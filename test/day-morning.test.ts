// The working day's inbound (fixtures/day/morning.json) as acceptance cases for enterprise handling and referrals
// (decisions 25 and 26), on the mini registry the test helpers choose.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import accountsApi from '../api/accounts';
import { ROOT } from '../src/config';
import { computeDashboard } from '../src/dashboard';
import type { DealSignals } from '../src/enterprise';
import type { SlackPayload } from '../src/notify/slack';
import type { StoredReferral } from '../src/referral';
import type { Source } from '../src/schema';
import { leadView, post, testCtx, type LeadView } from './helpers';

interface DayEvent { id: string; source: Source; payload: unknown }
const DAY: DayEvent[] = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'day', 'morning.json'), 'utf8')).events;
const event = (id: string) => DAY.find(e => e.id === id)!;

/** A lead view with the fields this file reads beyond helpers.LeadView. */
type DayLead = LeadView & { deal: DealSignals; referral: StoredReferral | null; normalized: { channel: string }; org: { name: string } };

async function run(ids: string[]) {
  const ctx = testCtx();
  const leads: Record<string, DayLead> = {};
  for (const id of ids) {
    const r = await post(ctx, event(id).source, event(id).payload);
    leads[id] = leadView(ctx, r.json.leadId) as DayLead;
  }
  return { ctx, leads };
}

const fieldText = (p: SlackPayload | null) => JSON.stringify(p?.blocks ?? []);

describe('a working day: enterprise accounts and referrals', () => {
  it('D01: an enterprise system with its hospital fact, referred by a customer owned by Avery, reported as a referral', async () => {
    const { leads } = await run(['D01']);
    const d = leads.D01;
    assert.equal(d.deal.enterprise.enterprise, true);
    assert.match(d.deal.enterprise.fact ?? '', /^\d+ hospitals/);
    assert.ok(d.flags.includes('enterprise') && d.flags.includes('referral'));
    assert.deepEqual([d.referral?.kind, d.referral?.points, d.referral?.account?.name, d.referral?.account?.customer, d.referral?.account?.owner],
      ['customer', 10, 'Wrenfield Health', true, 'Avery']);
    assert.equal(d.normalized.channel, 'referral');
    assert.ok((d.score as { items: { label: string; points: number }[] }).items.some(i => i.label === 'Referral: Wrenfield Health (a customer)' && i.points === 10));
    assert.equal(d.route.rule, 'R10');
    const alert = fieldText(d.alert.slack);
    assert.match(alert, /\*Enterprise\*\\n\d+ hospitals/);
    assert.match(alert, /\*Referral\*\\nWrenfield Health, a customer owned by Avery/);
    assert.equal(d.alert.enterprise?.channel, '#enterprise-deals', 'the first enterprise lead of the account tells sales leadership');
    // Avery owns Wrenfield, so a dry-run task to thank them is planned and never sent
    const task = d.referral?.thanks?.requests.find(r => r.path === '/crm/v3/objects/tasks');
    assert.match(JSON.stringify(task?.body), /Thank Wrenfield Health for referring CommonSpirit Health/);
    assert.match(JSON.stringify(task?.body), /"hubspot_owner_id":"900001"/);
    const contact = (d.crm.requests as { path: string; body: { inputs: { properties: Record<string, unknown> }[] } }[]).find(r => r.path.endsWith('/contacts/batch/upsert'));
    assert.deepEqual([contact?.body.inputs[0].properties.serif_referral_kind, contact?.body.inputs[0].properties.serif_referred_by], ['customer', 'Wrenfield Health']);
  });

  it('D04: a national payer asking for a bulk license goes to a named rep under R10 in 15 minutes, and the reason names the cue', async () => {
    const { leads } = await run(['D04']);
    const r = leads.D04.route;
    assert.equal(leads.D04.org.name, 'Humana');
    assert.deepEqual([r.rule, r.action, r.team, r.owner, r.slaMinutes], ['R10', 'rep_alert', 'API', 'Quinn', 15]);
    assert.match(r.reason, /^Humana is an enterprise account \(national payer\) and the message asks for a bulk or enterprise license \("bulk license"\), so a named rep gets it now instead of the Data & API Partnerships queue/);
    assert.deepEqual(leads.D04.deal.cues.map(c => c.kind), ['enterprise_license', 'full_dataset', 'broad_coverage', 'broad_coverage', 'approved_budget']);
    assert.match(fieldText(leads.D04.alert.slack), /deal-size cues \\"bulk license\\"/);
  });

  it('D12: a referral naming Emory Healthcare, which is not a customer', async () => {
    const { ctx, leads } = await run(['D12']);
    const ref = leads.D12.referral;
    assert.deepEqual([ref?.cue, ref?.kind, ref?.points, ref?.account?.name, ref?.account?.customer, ref?.thanks], ['form_answer', 'known_org', 6, 'Emory Healthcare', false, null]);
    assert.equal(leads.D12.normalized.channel, 'referral');
    // the referring account gets its signal row and an account the accounts API can show
    const emory = await (await accountsApi(new Request('http://local/api/accounts/ahrq%3ASYS-EMORY'), ctx)).json();
    assert.deepEqual(emory.signals.map((s: { kind: string; detail: string }) => [s.kind, s.detail]), [['referral_out', 'referred Piedmont Healthcare']]);
    assert.equal(emory.referralsOut, 1);
  });

  it('D13: a second person at CommonSpirit goes to the same rep as D01, and the alert names Helena Marsh', async () => {
    const { leads } = await run(['D01', 'D13']);
    assert.equal(leads.D13.route.owner, leads.D01.route.owner);
    assert.equal(leads.D13.route.rule, 'R5');
    assert.match(fieldText(leads.D13.alert.slack), /\*Also in from this account\*\\nHelena Marsh, SVP, Managed Care \(demo request, 6 hours ago\)/);
    assert.equal(leads.D13.alert.enterprise, undefined, 'one note per account in 30 days');
    assert.equal(leads.D13.referral, null);
  });

  it('the dashboard tells named referrals apart and ranks the referrers', async () => {
    const { ctx } = await run(['D01', 'D04', 'D12', 'D13']);
    const r = computeDashboard(ctx).referrals;
    assert.deepEqual([r.people, r.named, r.share], [4, 2, 50]);
    assert.deepEqual(r.byKind, { customer: 1, known_org: 1, unknown_org: 0 });
    assert.deepEqual(r.referrers.map(x => [x.name, x.customer, x.owner, x.leads]), [['Emory Healthcare', false, null, 1], ['Wrenfield Health', true, 'Avery', 1]]);
    assert.equal(r.tiers.referred.A, 2);
    assert.equal(r.salesReady.referred, 100);
    assert.equal(r.webOrUtmReferral, 0);
    assert.equal(r.thanksPlanned, 1);
  });

  it('the thank-you plan is never put in the outbox, live mode included', async () => {
    const sent: string[] = [];
    const ctx = testCtx({ hubspotLive: true, hubspotToken: 'tok' }, async (url, init) => {
      sent.push(`${init?.method ?? 'GET'} ${String(url)} ${String(init?.body ?? '')}`);
      return new Response(JSON.stringify({ results: [{ id: '1' }] }), { status: 200 });
    });
    const r = await post(ctx, 'calendly_demo', event('D01').payload);
    const plans = (ctx.db.prepare(`SELECT plan_json FROM crm_outbox`).all() as { plan_json: string }[]).map(p => p.plan_json);
    assert.equal(plans.length, 1, 'only the lead\'s own plan');
    assert.ok(!plans[0].includes('Thank Wrenfield Health'));
    assert.ok(!sent.some(x => x.includes('Thank Wrenfield Health')), 'nothing sent it');
    assert.ok((leadView(ctx, r.json.leadId) as DayLead).referral?.thanks, 'it is still planned on the lead');
  });

  it('D07: a managing director reads at the vice-president level', async () => {
    const { ctx } = await run(['D07']);
    const row = ctx.db.prepare(`SELECT title_seniority FROM leads`).get() as { title_seniority: string };
    assert.equal(row.title_seniority, 'vp');
  });

  it('D08: a cue alone sends a known company to a named rep, and the note never calls the account enterprise', async () => {
    const { leads } = await run(['D08']);
    const d = leads.D08;
    assert.equal(d.deal.enterprise.enterprise, false, 'a life sciences company is not enterprise by the definition');
    assert.deepEqual([d.route.rule, d.route.action, d.route.slaMinutes], ['R10', 'rep_alert', 15]);
    assert.match(d.route.reason, /asks for wide coverage \("ten states"\)/);
    assert.match(d.alert.enterprise?.text ?? '', /^Deal-size cue: Vertex Pharmaceuticals/);
    assert.ok(!fieldText(d.alert.enterprise ?? null).includes('enterprise lead'), 'ten states is a cue, not an enterprise account');
    assert.match(fieldText(d.alert.enterprise ?? null), /First lead with a deal-size cue from this account in 30 days/);
  });
});
