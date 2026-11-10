import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agoText, ALSO_IN_LISTED, alsoInLine, enterpriseLine, type AccountContact } from '../src/brief';
import { notesEnterprise } from '../src/decisions';
import { findDealCues } from '../src/dealCues';
import { enterpriseOf, NO_DEAL_SIGNALS, type DealSignals } from '../src/enterprise';
import type { Route } from '../src/schema';

const at = '2026-11-10T20:30:00.000Z';
const contact = (name: string, minutesAgo: number): AccountContact => ({
  name, title: 'Director', source: 'calendly_demo', receivedAt: new Date(Date.parse(at) - minutesAgo * 60_000).toISOString(),
});

describe('the brief\'s account lines', () => {
  it('Also in from this account: up to three by name, the rest counted', () => {
    assert.equal(alsoInLine([], at), null);
    assert.equal(alsoInLine([contact('Helena Marsh', 360)], at), 'Also in from this account: Helena Marsh, Director (demo request, 6 hours ago)');
    const many = alsoInLine([contact('A', 5), contact('B', 90), contact('C', 3000), contact('D', 4000), contact('E', 5000)], at)!;
    assert.equal(ALSO_IN_LISTED, 3);
    assert.equal(many, 'Also in from this account: A, Director (demo request, 5 minutes ago); B, Director (demo request, 2 hours ago); C, Director (demo request, 2 days ago); and 2 more');
  });
  it('how long ago, in minutes, hours or days', () => {
    assert.deepEqual([1, 59, 60, 47 * 60, 48 * 60].map(m => agoText(new Date(Date.parse(at) - m * 60_000).toISOString(), at)), ['1 minute ago', '59 minutes ago', '1 hour ago', '47 hours ago', '2 days ago']);
  });
  it('the Enterprise line carries the fact and quotes the cues; cues alone read as Deal size', () => {
    const deal = (fact: DealSignals['enterprise'], message: string): DealSignals => ({ enterprise: fact, cues: findDealCues(message) });
    assert.equal(enterpriseLine(deal(enterpriseOf('payer', { payerKind: 'national' }), 'A bulk license for all states.')), 'Enterprise: national payer; deal-size cues "bulk license", "all states"');
    assert.equal(enterpriseLine(deal(enterpriseOf('health_system', { hospitals: 12 }), 'Hello.')), 'Enterprise: 12 hospitals');
    assert.equal(enterpriseLine(deal(enterpriseOf('pe_investor', {}), 'Three portfolio companies.')), 'Deal size: "portfolio companies"');
    assert.equal(enterpriseLine(NO_DEAL_SIGNALS), null);
  });
});

describe('the enterprise deals note', () => {
  const route = (over: Partial<Route> = {}): Route => ({ action: 'rep_alert', team: 'HSP', owner: 'Avery', rule: 'R10', reason: '', slaMinutes: 5, slaDueAt: null, ...over });
  const enterprise: DealSignals = { enterprise: enterpriseOf('health_system', { hospitals: 20 }), cues: [] };
  const base = { deal: enterprise, route: route(), person: true, listDoor: false, notedRecently: false };
  it('goes out on the first enterprise lead of an account in 30 days, routed to sales', () => {
    assert.equal(notesEnterprise(base), true);
    assert.equal(notesEnterprise({ ...base, route: route({ rule: 'R5', action: 'owner_task' }) }), true, 'an owner task at an enterprise account counts');
    assert.equal(notesEnterprise({ ...base, deal: NO_DEAL_SIGNALS }), true, 'an R10 deal on a cue counts');
  });
  it('not twice in 30 days, not for a list row, an account signal, nurture, or a lead that is not enterprise', () => {
    assert.equal(notesEnterprise({ ...base, notedRecently: true }), false);
    assert.equal(notesEnterprise({ ...base, listDoor: true }), false);
    assert.equal(notesEnterprise({ ...base, person: false }), false);
    assert.equal(notesEnterprise({ ...base, route: route({ rule: 'R8', action: 'nurture' }) }), false);
    assert.equal(notesEnterprise({ ...base, deal: NO_DEAL_SIGNALS, route: route({ rule: 'R8' }) }), false);
  });
});
