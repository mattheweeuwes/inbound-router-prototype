import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountIds, accountIntent, assignsRep, claimsAccount, compareSecondOpinion, doubtNeedsFollowUp, hubspotOwnerIdOf, modelTiming,
  pickRoundRobin, reviewReason, summarizeTouches, wantsSlackAlert, webIntentDetail, webIntentPoints, type PriorTouch,
} from '../src/decisions';
import { AFTER_ALERT_REASON, fastPathOf } from '../src/modelPath';
import { combine } from '../src/qualify/combine';
import type { LlmOutcome } from '../src/qualify/llm';
import type { Classification } from '../src/schema';
import type { SlackPayload } from '../src/notify/slack';
import type { CrmMirrorEntry, Owners, Qualification, Resolution, Route } from '../src/schema';

const slack: SlackPayload = { channel: '@Avery', text: 't', blocks: [], dryRun: true };
const touch = (over: Partial<PriorTouch>): PriorTouch => ({ id: 'L1', owner: 'Avery', team: 'HSP', action: 'rep_alert', alert: { slack }, receivedAt: '2026-11-01T15:00:00.000Z', ...over });
const route = (over: Partial<Route> = {}): Route => ({ action: 'rep_alert', team: 'HSP', owner: 'Avery', rule: 'R8', reason: 'r', slaMinutes: 5, slaDueAt: null, ...over });
const owners: Owners = {
  teams: { HSP: { name: 'Health systems', reps: [{ name: 'Avery', hubspotOwnerId: '900001', capacity: 6 }, { name: 'Jordan', hubspotOwnerId: '900002', capacity: 6 }] } },
  queues: { Review: { owner: 'RevOps', hubspotOwnerId: '900099' } },
};

describe('summarizeTouches: which prior touch owns a repeat contact', () => {
  it('no prior touches: routed on its own', () => {
    assert.deepEqual(summarizeTouches([]), { duplicate: null, priorTouches: 0 });
  });

  it('the oldest touch that went to sales owns it, and every live touch counts', () => {
    const out = summarizeTouches([
      touch({ id: 'N', owner: 'Marketing (Sam)', team: 'Nurture', action: 'nurture', alert: { slack: null } }),
      touch({ id: 'A', receivedAt: '2026-11-02T15:00:00.000Z' }),
      touch({ id: 'B', owner: 'Jordan', receivedAt: '2026-11-03T15:00:00.000Z' }),
    ]);
    assert.equal(out.priorTouches, 3);
    assert.deepEqual(out.duplicate, { leadId: 'A', owner: 'Avery', team: 'HSP', lastAlertAt: '2026-11-03T15:00:00.000Z' });
  });

  it('a nurture touch alone counts for scoring but owns nothing', () => {
    assert.deepEqual(summarizeTouches([touch({ action: 'nurture', alert: { slack: null } })]), { duplicate: null, priorTouches: 1 });
  });

  it('dropped, careers and press touches are not live and count for nothing', () => {
    assert.deepEqual(summarizeTouches([touch({ action: 'drop' }), touch({ action: 'careers' }), touch({ action: 'press' })]), { duplicate: null, priorTouches: 0 });
  });

  it('the 24-hour clock runs from the newest alert that went out; a suppressed or missing alert does not reset it', () => {
    const out = summarizeTouches([
      touch({ id: 'A', receivedAt: '2026-11-01T15:00:00.000Z' }),
      touch({ id: 'B', action: 'attach_to_existing', alert: { slack, suppressed: true }, receivedAt: '2026-11-02T15:00:00.000Z' }),
      touch({ id: 'C', action: 'team_queue', alert: null, receivedAt: '2026-11-03T15:00:00.000Z' }),
    ]);
    assert.equal(out.duplicate?.lastAlertAt, '2026-11-01T15:00:00.000Z');
  });
});

describe('account intent points', () => {
  it('6 per web-intent signal up to 12, 4 per other contact, 12 in all', () => {
    assert.deepEqual(accountIntent(0, 0), { points: 0, note: '' });
    assert.deepEqual(accountIntent(1, 0), { points: 6, note: '1 web-intent signal(s)' });
    assert.deepEqual(accountIntent(3, 0), { points: 12, note: '3 web-intent signal(s)' });
    assert.deepEqual(accountIntent(0, 2), { points: 8, note: '2 other contact(s) at this account' });
    assert.deepEqual(accountIntent(1, 2), { points: 12, note: '1 web-intent signal(s), 2 other contact(s) at this account' });
  });
  it('an account keeps up to 12 web-intent points', () => {
    assert.deepEqual([0, 1, 2, 5].map(webIntentPoints), [0, 6, 12, 12]);
  });
});

describe('pickRoundRobin', () => {
  const reps = owners.teams.HSP.reps;
  it('nobody assigned yet: roster order', () => {
    assert.equal(pickRoundRobin(reps, new Map())?.name, 'Avery');
  });
  it('the rep assigned least recently goes next', () => {
    const activity = new Map([['Avery', { last: '2026-11-05T15:00:00.000Z', load: 1 }]]);
    assert.equal(pickRoundRobin(reps, activity)?.name, 'Jordan');
  });
  it('a rep at capacity is skipped; when everyone is, the least loaded still gets it', () => {
    assert.equal(pickRoundRobin(reps, new Map([['Avery', { last: '', load: 6 }]]))?.name, 'Jordan');
    assert.equal(pickRoundRobin(reps, new Map([['Avery', { last: '', load: 7 }], ['Jordan', { last: '', load: 6 }]]))?.name, 'Jordan');
  });
  it('an empty team gets nobody', () => {
    assert.equal(pickRoundRobin([], new Map()), null);
  });
});

describe('claimsAccount and assignsRep', () => {
  const base = { route: route(), owners, accountId: 'ahrq:SYS-1', claimedOwner: null, mirror: null, source: 'calendly_demo' as const };
  it('an R8 rep alert to a named rep on an unowned account claims it', () => {
    assert.equal(claimsAccount(base), true);
  });
  it('anything else does not', () => {
    const mirror = { id: 'm' } as CrmMirrorEntry;
    assert.equal(claimsAccount({ ...base, route: route({ rule: 'R5' }) }), false, 'an owner route');
    assert.equal(claimsAccount({ ...base, route: route({ alertSuppressed: true }) }), false, 'a suppressed alert');
    assert.equal(claimsAccount({ ...base, route: route({ action: 'team_queue', owner: 'HSP queue' }) }), false, 'a team queue');
    assert.equal(claimsAccount({ ...base, route: route({ owner: 'Somebody Else' }) }), false, 'not a rep on the team');
    assert.equal(claimsAccount({ ...base, accountId: null }), false, 'no account');
    assert.equal(claimsAccount({ ...base, claimedOwner: 'Jordan' }), false, 'already claimed');
    assert.equal(claimsAccount({ ...base, mirror }), false, 'a CRM mirror account');
    assert.equal(claimsAccount({ ...base, source: 'web_intent' }), false, 'web intent');
  });
  it('only an unsuppressed rep alert is an assignment', () => {
    assert.equal(assignsRep(route()), true);
    assert.equal(assignsRep(route({ alertSuppressed: true })), false);
    assert.equal(assignsRep(route({ action: 'owner_task' })), false);
  });
});

describe('wantsSlackAlert', () => {
  it('sales, review and competitor routes alert; nurture, drops and signals do not; a repeat touch only when not suppressed', () => {
    for (const action of ['rep_alert', 'team_queue', 'owner_task', 'review', 'competitor_flag'] as const) assert.equal(wantsSlackAlert(route({ action })), true, action);
    for (const action of ['nurture', 'drop', 'careers', 'press', 'account_signal'] as const) assert.equal(wantsSlackAlert(route({ action })), false, action);
    assert.equal(wantsSlackAlert(route({ action: 'attach_to_existing' })), true);
    assert.equal(wantsSlackAlert(route({ action: 'attach_to_existing', alertSuppressed: true })), false);
  });
});

describe('small lookups', () => {
  it('reviewReason prefers the classifier\'s reason, then the company match', () => {
    const res = (status: Resolution['status']) => ({ status }) as Resolution;
    const qual = (reviewReason?: string) => ({ reviewReason }) as Qualification;
    assert.equal(reviewReason(qual('llm_only_disqualifier'), res('resolved')), 'llm_only_disqualifier');
    assert.equal(reviewReason(qual(), res('ambiguous')), 'ambiguous_company');
    assert.equal(reviewReason(qual(), res('unresolved')), 'unresolved_company');
  });
  it('hubspotOwnerIdOf finds reps and queue owners', () => {
    assert.deepEqual([hubspotOwnerIdOf(owners, 'Jordan'), hubspotOwnerIdOf(owners, 'RevOps'), hubspotOwnerIdOf(owners, 'Nobody')], ['900002', '900099', null]);
  });
  it('accountIds splits the key at the first colon and adds CCNs and the NPI', () => {
    assert.deepEqual(accountIds('ahrq:SYS-1', { ccns: ['010001'] }), { ahrq: 'SYS-1', ccns: ['010001'] });
    assert.deepEqual(accountIds('domain:a:b.example', { npi: '123' }), { domain: 'a:b.example', npi: '123' });
  });
  it('webIntentDetail describes the visit without the lead id', () => {
    assert.equal(webIntentDetail({ visits: [{}, {}], visitors: 2, paths: ['/a', '/b'] }), '2 page view(s), 2 visitor(s): /a, /b');
    assert.equal(webIntentDetail({}), '0 page view(s), ? visitor(s): ');
  });
});

describe('modelTiming: which leads wait for the model (decision 19)', () => {
  const base = { setting: 'gated' as const, providerIsModel: true, freeText: true, rulesUseCaseClear: true };
  it('a clear keyword use case is alerted on the rules and gets the model after the alert', () => {
    assert.equal(modelTiming(base), 'after_alert');
  });
  it('a use case the rules cannot settle waits for the model, because it can change the team', () => {
    assert.equal(modelTiming({ ...base, rulesUseCaseClear: false }), 'before_route');
  });
  it('no free text: the model is never called', () => {
    assert.equal(modelTiming({ ...base, freeText: false }), 'not_called');
    assert.equal(modelTiming({ ...base, freeText: false, setting: 'all' }), 'not_called');
  });
  it('the old setting puts the model before every free-text route', () => {
    assert.equal(modelTiming({ ...base, setting: 'all' }), 'before_route');
  });
  it('the rules provider answers at once, so its record stays where it always was', () => {
    assert.equal(modelTiming({ ...base, providerIsModel: false }), 'before_route');
  });
});

describe('compareSecondOpinion: what the model would have changed after the alert', () => {
  const ev = { useCaseScore: 3, useCaseRunnerUp: 0, urgencyCue: null, urgencyDate: null, urgencyDays: null, urgencyKind: 'none' as const, urgencyParsed: null, legacyUrgencyCue: null, hasFreeText: true, roleFromTitle: true };
  const rules = (over: Partial<Classification> = {}, e = {}): Classification => ({ reasons: 'rules', useCase: 'contract_negotiation', urgency: 'unknown', buyingRole: 'decision_maker', disqualifier: 'none', confidence: 0.8, evidence: { ...ev, ...e }, ...over });
  const answer = (over: Partial<Classification> = {}): LlmOutcome => ({ ok: true, provider: 'ollama:test', latencyMs: 2000, value: { reasons: 'model', useCase: 'contract_negotiation', urgency: 'now', buyingRole: 'decision_maker', disqualifier: 'none', confidence: 0.9, ...over } });
  const pair = (r: Classification, a: LlmOutcome) => [combine(r, null, AFTER_ALERT_REASON, 'ollama'), combine(r, a, null, 'ollama')] as const;

  it('agreement: nothing would change (urgency is never the model\'s, so it is not compared)', () => {
    const f = compareSecondOpinion(...pair(rules(), answer()));
    assert.deepEqual(f, { answered: true, agreed: true, changed: [], roleFilled: null, doubt: null });
  });
  it('a role the title did not give is filled; a title role is never replaced', () => {
    assert.deepEqual(compareSecondOpinion(...pair(rules({ buyingRole: 'unknown' }, { roleFromTitle: false }), answer({ buyingRole: 'influencer' }))).roleFilled, 'influencer');
    assert.deepEqual(compareSecondOpinion(...pair(rules(), answer({ buyingRole: 'user' }))).changed, []);
  });
  it('spam or a vendor pitch only the model saw is a doubt a person decides, whatever the confidence', () => {
    const f = compareSecondOpinion(...pair(rules(), answer({ disqualifier: 'vendor_pitch', confidence: 0.99 })));
    assert.deepEqual(f.doubt, { disqualifier: 'vendor_pitch', confidence: 0.99, heldForPerson: true });
    assert.deepEqual(f.changed, ['reviewReason']);
    assert.equal(f.agreed, false);
  });
  it('a job seeker at 0.8 or above is a doubt the old path would have counted; below 0.8 it would have held it', () => {
    assert.deepEqual(compareSecondOpinion(...pair(rules(), answer({ disqualifier: 'job_seeker', confidence: 0.85 }))).doubt, { disqualifier: 'job_seeker', confidence: 0.85, heldForPerson: false });
    assert.deepEqual(compareSecondOpinion(...pair(rules(), answer({ disqualifier: 'job_seeker', confidence: 0.7 }))).doubt, { disqualifier: 'job_seeker', confidence: 0.7, heldForPerson: true });
  });
  it('a disqualifier the rules already had is no doubt', () => {
    assert.equal(compareSecondOpinion(...pair(rules({ disqualifier: 'student' }), answer({ disqualifier: 'student' }))).doubt, null);
  });
  it('no answer: not agreed, nothing changed', () => {
    const down: LlmOutcome = { ok: false, reason: 'timeout', detail: 'Ollama call exceeded 8s', latencyMs: 8000, provider: 'ollama:test' };
    assert.deepEqual(compareSecondOpinion(...pair(rules(), down)), { answered: false, agreed: false, changed: [], roleFilled: null, doubt: null });
  });
  it('fastPathOf rebuilds the gated record from a full one: the rules alone when the model would have waited', () => {
    const full = combine(rules(), answer({ disqualifier: 'spam', confidence: 0.9 }), null, 'ollama');
    assert.equal(fastPathOf(full).fallbackReason, AFTER_ALERT_REASON);
    assert.equal(fastPathOf(full).reviewReason, null);
    const unclear = combine(rules({ useCase: 'other' }, { useCaseScore: 0 }), answer(), null, 'ollama');
    assert.equal(fastPathOf(unclear), unclear, 'an unclear use case waited for the model, so the record is the full one');
  });
});

describe('doubtNeedsFollowUp', () => {
  it('only routes the old order would have changed or annotated: R5 and R8', () => {
    for (const rule of ['R5', 'R8'] as const) assert.equal(doubtNeedsFollowUp(route({ rule })), true, rule);
    for (const rule of ['R1', 'R2', 'R3', 'R4', 'R6', 'R9'] as const) assert.equal(doubtNeedsFollowUp(route({ rule })), false, rule);
  });
});
