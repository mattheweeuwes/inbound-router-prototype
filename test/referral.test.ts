import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureAnswer, captureMessage, captureReferrals, orgCandidates, referralLine, resolveReferral, type ReferrerAccount, type ReferrerLookups,
} from '../src/referral';
import { adapt } from '../src/sources';
import { referralFieldOf } from '../src/sources/common';

const referrers = (m: string) => captureMessage(m).map(c => [c.cue, c.referrer]);

describe('referral capture: the message', () => {
  it('finds each phrase and the words that name the referrer', () => {
    const cases: [string, string, string][] = [
      ['The contracting VP at Wrenfield Health recommended you.', 'recommended_you', 'The contracting VP at Wrenfield Health'],
      ['We were referred by Dana at Brookmere Health Plan.', 'referred_by', 'Dana at Brookmere Health Plan'],
      ['Serif was recommended by our broker, and we want a demo.', 'recommended_by', 'our broker'],
      ['Our CFO heard about you from the managed care team at Emory.', 'heard_from', 'the managed care team at Emory'],
      ['A peer at Piedmont told us to reach out.', 'told_us', 'A peer at Piedmont'],
      ['Our consultant at Mercer suggested we talk to you.', 'suggested', 'Our consultant at Mercer'],
      ['So far so good, and a friend at OhioHealth recommended Serif.', 'recommended_you', 'a friend at OhioHealth'],
    ];
    for (const [m, cue, who] of cases) assert.deepEqual(referrers(m), [[cue, who]], m);
  });

  it('does not match what is not a referral', () => {
    const none = [
      'Our CFO suggested we benchmark our rates.',
      'We recommended your product to our members.',
      'We were not referred by anyone.',
      'Nobody recommended you; we found you ourselves.',
      'Can you recommend a dataset for orthopedics?',
      'I heard about the new rule from CMS.',
      'Our renegotiations start in January.',
    ];
    for (const m of none) assert.deepEqual(captureMessage(m), [], m);
    assert.deepEqual(captureMessage(null), []);
  });

  it('keeps the sentence as written, one capture per sentence', () => {
    const c = captureMessage('We renegotiate in Q1. The contracting VP at Wrenfield Health recommended you.');
    assert.deepEqual(c.map(x => x.text), ['The contracting VP at Wrenfield Health recommended you.']);
  });
});

describe('referral capture: the answer to "How did you hear about us?"', () => {
  it('a referral word, or a bare name, is a referral; a channel is not', () => {
    assert.deepEqual(captureAnswer({ field: 'How did you hear about us?', answer: 'Referral from a colleague at Emory Healthcare' }), {
      cue: 'form_answer', text: 'Referral from a colleague at Emory Healthcare', referrer: 'a colleague at Emory Healthcare',
    });
    assert.equal(captureAnswer({ field: 'how_did_you_hear', answer: 'Emory Healthcare' })?.referrer, 'Emory Healthcare');
    assert.equal(captureAnswer({ field: 'how_did_you_hear', answer: 'A colleague mentioned you at a conference' })?.cue, 'form_answer');
    for (const answer of ['Google', 'LinkedIn post', 'HLTH conference', 'Podcast', 'Other']) {
      assert.equal(captureAnswer({ field: 'how_did_you_hear', answer }), null, answer);
    }
  });
  it('a referred_by field is always a referral, even when it reads like a channel', () => {
    assert.equal(captureAnswer({ field: 'referred_by', answer: 'Event partner Jane Doe' })?.referrer, 'Event partner Jane Doe');
  });
  it('the answer comes first, then the message', () => {
    const c = captureReferrals({ field: 'how_did_you_hear', answer: 'Emory Healthcare' }, 'Our CFO heard about you from the managed care team at Emory.');
    assert.deepEqual(c.map(x => x.cue), ['form_answer', 'heard_from']);
  });
});

describe('the doors carry the answer through', () => {
  it('a form field, a nested field, or a booking question', () => {
    assert.deepEqual(referralFieldOf({ referred_by: '  Wrenfield Health ' }), { field: 'referred_by', answer: 'Wrenfield Health' });
    assert.equal(referralFieldOf({ email: 'x@y.org' }), null);
    const form = adapt('guide_download', { synthetic: true, fields: { email: 'a@b.org', how_did_you_hear: 'Emory Healthcare' }, submitted_at: '2026-11-10T15:00:00Z' });
    assert.deepEqual(form.context.referral, { field: 'how_did_you_hear', answer: 'Emory Healthcare' });
    const booking = adapt('calendly_demo', { payload: { uri: 'u', email: 'a@b.org', questions_and_answers: [{ question: 'How did you hear about us?', answer: 'Wrenfield Health' }] } });
    assert.deepEqual(booking.context.referral, { field: 'How did you hear about us?', answer: 'Wrenfield Health' });
    assert.equal(booking.message, null, 'the answer is not mistaken for the message');
    const plain = adapt('guide_download', { synthetic: true, fields: { email: 'a@b.org' }, submitted_at: '2026-11-10T15:00:00Z' });
    assert.equal('referral' in plain.context, false, 'a payload without the field keeps the context it always had');
  });
});

describe('which organization referred them', () => {
  const wrenfield: ReferrerAccount = { key: 'crm:mirror-wrenfield', name: 'Wrenfield Health', customer: true, owner: 'Avery', matchedBy: 'crm' };
  const emory: ReferrerAccount = { key: 'ahrq:SYS-EMORY', name: 'Emory Healthcare', customer: false, owner: null, matchedBy: 'registry' };
  const lookups: ReferrerLookups = {
    crm: words => (/wrenfield/i.test(words) ? wrenfield : null),
    registry: name => (name === 'Emory Healthcare' ? emory : null),
  };

  it('tries the words after "at", "from" or "of", a possessive, then the whole phrase', () => {
    assert.deepEqual(orgCandidates('the managed care team at Emory'), ['Emory', 'managed care team at Emory']);
    assert.deepEqual(orgCandidates("Emory's managed care team"), ['Emory', "Emory's managed care team"]);
    assert.deepEqual(orgCandidates('the CFO of Emory Healthcare'), ['Emory Healthcare', 'CFO of Emory Healthcare']);
  });

  it('the CRM first, then the registry; a customer is worth 10, a known organization 6, words alone 3', () => {
    const toCustomer = resolveReferral(captureMessage('The contracting VP at Wrenfield Health recommended you.'), lookups, 'ahrq:SYS-COMMONSPIRIT');
    assert.deepEqual([toCustomer?.kind, toCustomer?.points, toCustomer?.account?.owner], ['customer', 10, 'Avery']);
    const known = resolveReferral([captureAnswer({ field: 'how_did_you_hear', answer: 'Referral from a colleague at Emory Healthcare' })!], lookups, null);
    assert.deepEqual([known?.kind, known?.points, known?.account?.name], ['known_org', 6, 'Emory Healthcare']);
    const words = resolveReferral(captureMessage('A friend at a small clinic recommended you.'), lookups, null);
    assert.deepEqual([words?.kind, words?.points, words?.account, words?.referrer], ['unknown_org', 3, null, 'A friend at a small clinic']);
  });

  it('a capture that resolves beats an earlier one that does not; a colleague at the lead\'s own account is skipped', () => {
    const c = captureMessage('Our CFO heard about you from the managed care team at Emory. The contracting VP at Wrenfield Health recommended you.');
    assert.equal(resolveReferral(c, lookups, null)?.account?.key, 'crm:mirror-wrenfield');
    assert.equal(resolveReferral(captureMessage('A colleague at Wrenfield Health recommended you.'), lookups, 'crm:mirror-wrenfield'), null);
    assert.equal(resolveReferral([], lookups, null), null);
  });

  it('the brief line says who, whether a customer, whose account, and the words', () => {
    const r = resolveReferral(captureMessage('The contracting VP at Wrenfield Health recommended you.'), lookups, null)!;
    assert.equal(referralLine(r), 'Referral: Wrenfield Health, a customer owned by Avery ("The contracting VP at Wrenfield Health recommended you.")');
    const unknown = resolveReferral(captureMessage('A friend recommended you.'), lookups, null)!;
    assert.equal(referralLine(unknown), 'Referral: referrer unknown ("A friend recommended you.")');
  });
});
