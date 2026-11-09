import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountIds, accountIntent, assignsRep, claimsAccount, hubspotOwnerIdOf, pickRoundRobin, reviewReason, summarizeTouches,
  wantsSlackAlert, webIntentDetail, webIntentPoints, type PriorTouch,
} from '../src/decisions';
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
