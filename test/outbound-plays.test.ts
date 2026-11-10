// The outbound module as a team works it (decisions 27 to 29), on the invented rate file and the mini registry: the
// system-gap play, link review and a person's decision, suppression of accounts someone already has, and the export.
// The four Amarillo groups in test/fixtures/rates-mini.csv are there for this: CANYON LARK HEALTH links exactly to an
// invented system, PECOS VALE PHYSICIANS PLLC has it as a probable link, TALLOWMERE HEALTH PARTNERS carries the name of a
// fictional CRM customer, and HIGH PLAINS PSYCHIATRY holds the city's top rate.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import handler from '../api/outbound';
import { COMPANY_PROPERTIES } from '../src/crm/hubspot';
import { campaignOf } from '../src/outbound/campaign';
import { parseCsv } from '../src/outbound/csv';
import { csvField, EXPORT_COLUMNS, exportCounts, exportRows, toCsv } from '../src/outbound/export';
import { groupState, groupStates } from '../src/outbound/groupState';
import { linkReviewOf, nameContained, PROBABLE_MIN_SCORE, probableCandidate, type LinkDecision } from '../src/outbound/linkReview';
import { cityGap, playOf, SYSTEM_GAP } from '../src/outbound/plays';
import { statusOf } from '../src/outbound/status';
import { ordinaryName, renderSystemGapDraft, SYSTEM_GAP_TEMPLATES } from '../src/outbound/systemGapDraft';
import { outboundDetail, outboundSummary } from '../src/outbound/view';
import type { NameLink } from '../src/resolve';
import type { Candidate } from '../src/schema';
import type { OutboundGroup } from '../src/store/outbound';
import { PLATFORMS_MINI, RATES_MINI, submit, testCtx } from './helpers';

const CANYON = '900000013';
const PECOS = '900000014';
const TALLOW = '900000015';
const PLAINS = '900000016';

const scratch = mkdtempSync(join(tmpdir(), 'outbound-plays-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const req = (path: string, init?: RequestInit) => new Request(`http://local${path}`, init);
const postLink = (ein: string, body: unknown) => req(`/api/outbound/${ein}/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** A context whose server would take link decisions (DEMO_ROUTES=1). */
const demoCtx = (over: Parameters<typeof testCtx>[0] = {}) => testCtx({ demoRoutes: true, ...over });
const group = (ctx: ReturnType<typeof testCtx>, ein: string): OutboundGroup => ctx.store.outbound.group(ein)!;
/** Every number in a text: "$131.02", "79%", "1,100" and "90837" come back as 131.02, 79, 1100 and 90837. */
const numbersIn = (text: string) => (text.match(/\d[\d,]*(\.\d+)?/g) ?? []).map(n => Number(n.replace(/,/g, '')));

const cand = (name: string, state: string | null, score: number, accountId = `ahrq:${name}`): Candidate => ({ accountId, name, kind: 'ahrq_system', state, score });
const unlinked = (candidates: Candidate[]): NameLink => ({ status: 'unlinked', accountId: null, accountName: null, method: 'company_name', score: candidates[0]?.score ?? null, reason: 'unique but weak', candidates });

describe('outbound link review', () => {
  it('a best candidate in the same state is probable when its distinctive name is in the group name, or it scores 0.5 or more', () => {
    assert.equal(PROBABLE_MIN_SCORE, 0.5);
    assert.equal(probableCandidate('OU HEALTH PARTNERS INC', 'OK', [cand('OU Health', 'OK', 0.45)])?.why, '"OU Health" is contained in the group\'s name');
    assert.match(String(probableCandidate('PARKLAND HEALTH', 'TX', [cand('Parkland Health and Hospital System', 'TX', 0.58)])?.why), /score 0\.58/);
    assert.equal(probableCandidate('NIX GROUP', 'TX', [cand('Somewhere Else', 'TX', 0.49)]), null, 'neither contained nor 0.5');
    assert.equal(probableCandidate('OU HEALTH PARTNERS', 'OK', [cand('OU Health', 'TX', 0.9)]), null, 'a candidate in another state is never probable');
    assert.equal(probableCandidate('OU HEALTH PARTNERS', null, [cand('OU Health', 'OK', 0.9)]), null, 'a group with no state has no same-state candidate');
    // the best candidate in the state is the one asked about, even when a weaker one is contained
    assert.equal(probableCandidate('MESA GROUP', 'TX', [cand('Mesa', 'TX', 0.3), cand('Other Health', 'TX', 0.6)])?.candidate.name, 'Other Health');
  });
  it('common words, state names included, never make a name contained', () => {
    assert.equal(nameContained('Physicians Centre, The', 'UT PHYSICIANS'), false);
    assert.equal(nameContained('The University of Texas System', 'TEXAS TECH UNIVERSITY HEALTH SCIENCES CENTER'), false);
    assert.equal(nameContained('Houston Methodist', 'HOUSTON METHODIST SPECIALTY PHYSICIANS'), true);
  });
  it('an exact link stands; otherwise a decision wins; otherwise the candidates decide', () => {
    const g = { name: 'PECOS VALE PHYSICIANS PLLC', state: 'TX' };
    const c = cand('Pecos Vale Health System', 'TX', 0.48, 'ahrq:SYS-PECOSVALE');
    const decided = (decision: 'confirmed' | 'rejected'): LinkDecision => ({ ein: PECOS, decision, accountId: c.accountId, accountName: c.name, decidedBy: 'Pat', note: null, decidedAt: '2026-11-09T12:00:00.000Z' });
    assert.equal(linkReviewOf(g, unlinked([c]), null).status, 'probable');
    assert.equal(linkReviewOf(g, unlinked([]), null).status, 'unlinked');
    const confirmed = linkReviewOf(g, unlinked([c]), decided('confirmed'));
    assert.deepEqual([confirmed.status, confirmed.accountId, confirmed.accountName, confirmed.why], ['confirmed', 'ahrq:SYS-PECOSVALE', 'Pecos Vale Health System', 'confirmed by Pat']);
    const rejected = linkReviewOf(g, unlinked([c]), decided('rejected'));
    assert.deepEqual([rejected.status, rejected.accountId, rejected.probable?.name], ['rejected', null, 'Pecos Vale Health System']);
    const exact: NameLink = { ...unlinked([c]), status: 'linked', accountId: 'ahrq:X', accountName: 'X Health' };
    assert.equal(linkReviewOf(g, exact, decided('rejected')).status, 'exact');
  });
  it('on the mini files: one exact link, one probable, and the rest unlinked; a probable link claims no organization', () => {
    const ctx = testCtx();
    const by = new Map(groupStates(ctx).map(s => [s.group.ein, s]));
    assert.deepEqual([by.get(CANYON)!.review.status, by.get(CANYON)!.review.accountName], ['exact', 'Canyon Lark Health']);
    const pecos = by.get(PECOS)!;
    assert.deepEqual([pecos.review.status, pecos.review.accountId, pecos.review.probable?.accountId], ['probable', null, 'ahrq:SYS-PECOSVALE']);
    assert.equal([...by.values()].filter(s => s.review.status === 'unlinked').length, 14);
    // no draft, no HubSpot body and no export row names the probable candidate
    const d = outboundDetail(ctx, PECOS)!;
    assert.deepEqual([d.work.status, d.draft?.kind], ['link_to_confirm', 'preview']);
    assert.ok(!`${d.draft?.subject} ${d.draft?.body} ${d.draft?.linkedin}`.includes('Pecos Vale Health System'));
    assert.deepEqual(d.hubspot.requests, []);
    assert.ok(exportRows(ctx).every(r => r.ein !== PECOS));
  });
});

describe('outbound plays: the system gap', () => {
  it('states its rule once: a hospital or system link, more than 50 clinicians, a group in the city paid 20% more', () => {
    assert.deepEqual(SYSTEM_GAP, { minClinicians: 50, minGapPct: 20 });
    const ctx = testCtx();
    const g = group(ctx, CANYON);
    const review = groupState(ctx, g).review;
    assert.deepEqual([playOf(g, review).play, cityGap(g)], ['system_gap', 121]);
    const miss = (over: Partial<OutboundGroup>, why: RegExp) => {
      const c = playOf({ ...g, ...over }, review);
      assert.equal(c.play, null);
      assert.match(c.reason, why);
    };
    miss({ clinicians: 50 }, /50 or fewer clinicians/);
    miss({ cityTopRate: g.rate * 1.19 }, /only 19% above its own, under 20%/);
    miss({ cityTopEin: g.ein, cityTopRate: g.rate }, /holds the top rate in Amarillo/);
    assert.equal(cityGap(group(ctx, PLAINS)), null, 'the group paid the top rate has nothing above it');
    assert.equal(playOf({ ...g, cityTopRate: g.rate * 1.2 }, review).play, 'system_gap', 'exactly 20% qualifies');
    assert.match(playOf(g, { ...review, accountId: 'payer:humana', accountName: 'Humana' }).reason, /Humana is not a hospital or health system/);
    assert.match(playOf(g, { ...review, status: 'unlinked', accountId: null, accountName: null }).reason, /not linked to a registry organization/);
  });
  it('keeps the platform play exactly as the loader stored it', () => {
    const ctx = testCtx();
    const states = new Map(groupStates(ctx).map(s => [s.group.ein, s]));
    assert.deepEqual(['900000008', '900000009'].map(e => [states.get(e)!.choice.play, states.get(e)!.status.status]), [['platform', 'ready'], ['platform', 'blocked']]);
    assert.deepEqual(outboundSummary(ctx).summary?.drafts, { ready: 1, blocked: 1 });
  });
  it('every group shows its play or why it is in none', () => {
    const s = outboundSummary(testCtx());
    for (const g of s.groups) {
      assert.ok(g.statusReason.length > 0 && g.playReason.length > 0, g.ein);
      if (!g.play) assert.match(g.playReason, /Not in the system-gap play: /, g.ein);
    }
    assert.deepEqual(s.summary?.statuses, { ready: 2, blocked: 1, suppressed: 1, link_to_confirm: 1, not_target: 11 });
    assert.deepEqual(s.groups.filter(g => g.play === 'system_gap').map(g => [g.ein, g.team]), [[CANYON, 'HSP']]);
  });
  it('the draft uses the agreed words, with every figure inserted by code and the other group never named', () => {
    const d = outboundDetail(testCtx(), CANYON)!.draft!;
    assert.deepEqual([d.kind, d.status], ['draft', 'ready']);
    assert.equal(d.subject, "Canyon Lark Health's UHC rate for 90837 in Amarillo: 93% of Medicare");
    assert.equal(d.body, [
      'Hi {first_name},',
      "In UnitedHealthcare's August Choice Plus file, Canyon Lark Health (600 clinicians) is paid $141.20 for a 60-minute session (90837), 93% of Medicare. The top rate for the same session in Amarillo is $312.47, 121% above yours, and groups with more than 500 clinicians sit at a median of 132% of Medicare in the same file. That is one code in one network. Serif shows the same comparison for every code, payer and service line you contract, next to your peers. Worth 20 minutes before your next UHC renewal?",
    ].join('\n\n'));
    assert.equal(d.linkedin, "{first_name}, I sent a note on Canyon Lark Health's UHC rate for 90837 in Amarillo (93% of Medicare, against a top rate of $312.47) and can send the full comparison if it's useful.");
    const all = `${d.subject}\n${d.body}\n${d.linkedin}`;
    assert.ok(!/high plains/i.test(all), 'the group paid the top rate is not named');
    const inserted = new Set(d.inserted.flatMap(v => numbersIn(v.value)));
    for (const n of numbersIn(all)) assert.ok(inserted.has(n), `${n} is not an inserted value`);
    for (const t of SYSTEM_GAP_TEMPLATES) assert.doesNotMatch(t, /\d/, t);
    for (const key of ['subject', 'body', 'linkedin'] as const) assert.equal(d.parts[key].map(p => p.text).join(''), d[key]);
    assert.ok([...d.parts.subject, ...d.parts.body, ...d.parts.linkedin].filter(p => !p.placeholder).every(p => !/\d/.test(p.text)), 'plain runs carry no figure');
  });
  it('names the system as the registry has it and the group in ordinary capitalization', () => {
    const ctx = testCtx();
    const g = { ...group(ctx, CANYON), name: 'CANYON LARK PHYSICIANS OF THE PLAINS PLLC' };
    const campaign = campaignOf(ctx.store.outbound.file()!.scope, ctx.store.outbound.allGroups(), ctx.store.outbound.patterns());
    const d = renderSystemGapDraft({ finding: g, system: { name: 'Canyon Lark Health', how: 'exact' }, campaign });
    assert.match(d.body, /, Canyon Lark Physicians of the Plains PLLC \(600 clinicians\)/);
    assert.deepEqual(['OU HEALTH PARTNERS INC', 'SSM HEALTH', 'ST JOHN PHYSICIANS INC', "COOK CHILDREN'S PHYSICIAN NETWORK"].map(ordinaryName),
      ['OU Health Partners Inc', 'SSM Health', 'St John Physicians Inc', "Cook Children's Physician Network"]);
  });
  it('its HubSpot body carries the play and the link status, and every property is defined', () => {
    const plan = outboundDetail(testCtx(), CANYON)!.hubspot;
    const props = (plan.requests[0].body as { inputs: { properties: Record<string, unknown> }[] }).inputs[0].properties;
    assert.deepEqual([props.serif_outbound_play, props.serif_link_status, props.serif_registry_account_key], ['system_gap', 'exact', 'ahrq:SYS-CANYONLARK']);
    const defined = new Set([...COMPANY_PROPERTIES.map(p => p.name), 'name', 'city', 'state']);
    for (const k of Object.keys(props)) assert.ok(defined.has(k), k);
  });
});

describe('outbound link decisions: POST /api/outbound/<ein>/link', () => {
  it('is not served without the demo actions, and says so', async () => {
    const res = await handler(postLink(PECOS, { decision: 'confirm', accountKey: 'ahrq:SYS-PECOSVALE', by: 'Pat' }), testCtx());
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /demo actions are off.*DEMO_ROUTES=1.*Sign-in is not built/);
  });
  it('confirming the probable link puts the group in the system-gap play, with a ready draft, a HubSpot body and an export row', async () => {
    const ctx = demoCtx();
    const res = await handler(postLink(PECOS, { decision: 'confirm', accountKey: 'ahrq:SYS-PECOSVALE', by: 'Pat Okafor', note: 'same campus' }), ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([body.decision.decision, body.decision.decidedBy, body.decision.note, body.linkReview.status, body.work.status, body.work.play], ['confirmed', 'Pat Okafor', 'same campus', 'confirmed', 'ready', 'system_gap']);
    const d = outboundDetail(ctx, PECOS)!;
    assert.equal(d.draft?.subject, "Pecos Vale Health System's UHC rate for 90837 in Amarillo: 81% of Medicare");
    assert.match(d.draft!.body, /Pecos Vale Physicians PLLC \(200 clinicians\) is paid \$122\.41/);
    assert.ok(d.draft!.inserted.some(v => v.placeholder === '{system}' && /confirmed by a person/.test(v.field)));
    const props = (d.hubspot.requests[0].body as { inputs: { properties: Record<string, unknown> }[] }).inputs[0].properties;
    assert.deepEqual([props.serif_link_status, props.serif_registry_account_key], ['confirmed', 'ahrq:SYS-PECOSVALE']);
    assert.deepEqual(exportRows(ctx).map(r => [r.ein, r.play, r.account_keys]), [['900000008', 'platform', 'ein:900000008'], [CANYON, 'system_gap', `ein:${CANYON};ahrq:SYS-CANYONLARK`], [PECOS, 'system_gap', `ein:${PECOS};ahrq:SYS-PECOSVALE`]]);
  });
  it('a lead from a confirmed system now carries the group\'s rate line', async () => {
    const ctx = demoCtx();
    await handler(postLink(PECOS, { decision: 'confirm', accountKey: 'ahrq:SYS-PECOSVALE', by: 'Pat' }), ctx);
    const { lead } = await submit(ctx, 'calendly_demo', { email: 'rlee@pecosvalehs.example', company: 'Pecos Vale Health System', state: 'TX' });
    assert.equal(lead.resolution.accountId, 'ahrq:SYS-PECOSVALE');
    assert.deepEqual([lead.rateFact?.ein, lead.rateFact?.matchedBy], [PECOS, 'registry_link']);
  });
  it('a rejection keeps the group out of every play and records the candidate turned down', async () => {
    const ctx = demoCtx();
    const res = await handler(postLink(PECOS, { decision: 'reject', by: 'Pat', note: 'a different practice' }), ctx);
    assert.equal(res.status, 200);
    const s = groupState(ctx, group(ctx, PECOS));
    assert.deepEqual([s.review.status, s.review.decision?.accountId, s.status.status, s.choice.play], ['rejected', 'ahrq:SYS-PECOSVALE', 'not_target', null]);
  });
  it('refuses an account that is not a candidate, the exact link, an unknown EIN and a request with no name', async () => {
    const ctx = demoCtx();
    const call = async (ein: string, body: unknown) => { const r = await handler(postLink(ein, body), ctx); return [r.status, (await r.json()).error] as [number, string]; };
    const [s1, e1] = await call(PECOS, { decision: 'confirm', accountKey: 'ahrq:SYS-INTERMTN', by: 'Pat' });
    assert.equal(s1, 422);
    assert.match(e1, /not one of this group's candidates \(ahrq:SYS-PECOSVALE/);
    assert.equal((await call(CANYON, { decision: 'reject', by: 'Pat' }))[0], 409);
    assert.equal((await call('123', { decision: 'reject', by: 'Pat' }))[0], 404);
    assert.match((await call(PECOS, { decision: 'confirm', accountKey: 'ahrq:SYS-PECOSVALE' }))[1], /by is required.*sign-in is not built/);
    assert.match((await call(PECOS, { decision: 'maybe', by: 'Pat' }))[1], /decision must be/);
    assert.equal((await handler(req(`/api/outbound/${PECOS}/link`), ctx)).status, 405);
  });
  it('survives a reload of the rate file, which rebuilds every derived table', async () => {
    const appDb = join(scratch, 'decisions.sqlite');
    const file = join(scratch, 'rates.csv');
    writeFileSync(file, readFileSync(RATES_MINI, 'utf8'));
    await handler(postLink(PECOS, { decision: 'confirm', accountKey: 'ahrq:SYS-PECOSVALE', by: 'Pat' }), demoCtx({ appDb, ratesCsv: file }));
    writeFileSync(file, readFileSync(RATES_MINI, 'utf8').replace('$122.41,true,$152,81%', '$122.42,true,$152,81%'));
    const reloaded = testCtx({ appDb, ratesCsv: file });
    assert.equal(reloaded.outbound.status, 'loaded');
    const s = groupState(reloaded, group(reloaded, PECOS));
    assert.deepEqual([s.review.status, s.review.decision?.decidedBy, s.status.status], ['confirmed', 'Pat', 'ready']);
  });
});

describe('outbound link decisions: DELETE /api/outbound/<ein>/link takes one back', () => {
  const del = (ein: string) => req(`/api/outbound/${ein}/link`, { method: 'DELETE' });
  const statusOf = (ctx: ReturnType<typeof testCtx>, ein: string) => { const s = groupState(ctx, group(ctx, ein)); return [s.review.status, s.status.status, s.choice.play]; };

  it('is not served without the demo actions, and says so', async () => {
    const res = await handler(del(PECOS), testCtx());
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /demo actions are off/);
  });
  it('clears a confirmation: the group goes back to a probable link, out of the play, and the export loses its draft', async () => {
    const ctx = demoCtx();
    await handler(postLink(PECOS, { decision: 'confirm', accountKey: 'ahrq:SYS-PECOSVALE', by: 'Pat' }), ctx);
    assert.deepEqual(statusOf(ctx, PECOS), ['confirmed', 'ready', 'system_gap']);
    const res = await handler(del(PECOS), ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([body.cleared, body.linkReview.status, body.work.status], [true, 'probable', 'link_to_confirm']);
    assert.deepEqual(statusOf(ctx, PECOS), ['probable', 'link_to_confirm', null]);
    assert.equal(ctx.store.outbound.decision(PECOS), null);
    assert.ok(!exportRows(ctx).some(r => r.ein === PECOS));
  });
  it('clears a rejection too, and leaves every other group\'s decision alone', async () => {
    const ctx = demoCtx();
    await handler(postLink(PECOS, { decision: 'reject', by: 'Pat' }), ctx);
    await handler(postLink(PLAINS, { decision: 'reject', by: 'Sam' }), ctx);
    assert.equal(statusOf(ctx, PECOS)[0], 'rejected');
    assert.equal((await handler(del(PECOS), ctx)).status, 200);
    assert.equal(statusOf(ctx, PECOS)[0], 'probable');
    assert.equal(ctx.store.outbound.decision(PLAINS)?.decidedBy, 'Sam');
  });
  it('says so when there is nothing to clear, for an unknown EIN, and refuses a method it does not take', async () => {
    const ctx = demoCtx();
    const none = await handler(del(PECOS), ctx);
    assert.equal(none.status, 404);
    assert.match((await none.json()).error, /no recorded decision/);
    assert.equal((await handler(del('123'), ctx)).status, 404);
    assert.equal((await handler(req(`/api/outbound/${PECOS}/link`, { method: 'PUT' }), ctx)).status, 405);
  });
  it('a cleared decision stays cleared across a reload of the rate file', async () => {
    const appDb = join(scratch, 'cleared.sqlite');
    await handler(postLink(PECOS, { decision: 'confirm', accountKey: 'ahrq:SYS-PECOSVALE', by: 'Pat' }), demoCtx({ appDb }));
    await handler(del(PECOS), demoCtx({ appDb }));
    assert.equal(statusOf(testCtx({ appDb }), PECOS)[0], 'probable');
  });
});

describe('outbound suppression', () => {
  it('a group under a CRM customer\'s name is not prospected, says who has it, and keeps its finding as a talking point', () => {
    const ctx = testCtx();
    const d = outboundDetail(ctx, TALLOW)!;
    assert.deepEqual([d.work.status, d.work.holder?.by, d.work.holder?.owner, d.work.holder?.accountKey], ['suppressed', 'crm', 'Jordan', 'crm:mirror-tallowmere']);
    assert.match(d.work.statusReason, /^Not prospected: Tallowmere Health is a customer in the CRM, owned by Jordan\. The finding is a talking point for Jordan\.$/);
    assert.equal(d.draft?.kind, 'preview');
    assert.match(String(d.draft?.label), /talking point for Jordan, not a draft/);
    assert.match(d.rateLine, /^Their UHC Choice Plus rate for 90837 \(Aug 2026\): \$211\.80, 139% of Medicare/);
    assert.match(String(d.hubspot.skipped), /^suppressed: Tallowmere Health is a customer/);
  });
  it('a rep\'s claim from an inbound lead suppresses the system-gap group, and the lead names who has it', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo', { email: 'mreyes@canyonlarkhealth.example', company: 'Canyon Lark Health', state: 'TX' });
    assert.equal(lead.resolution.accountId, 'ahrq:SYS-CANYONLARK');
    assert.equal(lead.rateFact?.ein, CANYON, 'the inbound rate line already names the group for the rep');
    const s = groupState(ctx, group(ctx, CANYON));
    assert.deepEqual([s.choice.play, s.status.status, s.hold?.by, s.hold?.owner], ['system_gap', 'suppressed', 'claim', lead.route.owner]);
    assert.ok(exportRows(ctx).every(r => r.ein !== CANYON));
  });
  it('an inbound lead with no claim suppresses for 90 days after it came in, and not after', async () => {
    const at = (iso: string) => testCtx({ now: () => Date.parse(iso) });
    const nurture = { email: 'jkim@canyonlarkhealth.example', company: 'Canyon Lark Health', state: 'TX', title: 'Student', message: 'Just reading.', ts: '2026-08-01T15:00:00.000Z' };
    const inside = at('2026-10-30T12:00:00.000Z');
    const { lead } = await submit(inside, 'guide_download', nurture);
    assert.equal(inside.store.accounts.claimedOwner('ahrq:SYS-CANYONLARK'), null, 'the lead went to a queue and claimed nothing');
    const held = groupState(inside, group(inside, CANYON)).hold;
    assert.deepEqual([held?.by, held?.leadId, held?.owner], ['inbound', lead.id, lead.route.owner]);
    const outside = at('2026-10-31T15:00:01.000Z');
    await submit(outside, 'guide_download', nurture);
    assert.equal(groupState(outside, group(outside, CANYON)).status.status, 'ready');
  });
  it('the platform play obeys it too: a confirmed platform someone already has gets no draft', () => {
    const platforms = join(scratch, 'platforms.json');
    writeFileSync(platforms, JSON.stringify({ platforms: [...JSON.parse(readFileSync(PLATFORMS_MINI, 'utf8')).platforms, { ein: TALLOW, platform: 'Tallowmere', confirmed: true, how: 'test' }] }));
    const ctx = testCtx({ outboundPlatforms: platforms });
    const s = groupState(ctx, group(ctx, TALLOW));
    assert.deepEqual([s.choice.play, s.status.status], ['platform', 'suppressed']);
    assert.equal(outboundDetail(ctx, TALLOW)!.draft?.kind, 'preview');
    assert.ok(exportRows(ctx).every(r => r.ein !== TALLOW));
    // and the status rule says so in one place
    assert.equal(statusOf(s.choice, 'ready', s.review, s.hold, null).status, 'suppressed');
  });
});

describe('outbound export', () => {
  it('one row per ready draft with every column, quoted so the texts survive a CSV reader', () => {
    const ctx = testCtx();
    const rows = exportRows(ctx);
    assert.deepEqual(rows.map(r => r.ein), ['900000008', CANYON]);
    const parsed = parseCsv(toCsv(rows));
    assert.deepEqual(parsed[0], [...EXPORT_COLUMNS]);
    assert.equal(parsed.length, 3);
    const canyon = Object.fromEntries(EXPORT_COLUMNS.map((c, i) => [c, parsed[2][i]]));
    assert.deepEqual([canyon.play, canyon.team, canyon.city, canyon.state, canyon.clinicians, canyon.rate, canyon.pct_of_medicare, canyon.city_top_rate, canyon.contract_form, canyon.card_tier, canyon.conversion_factor],
      ['system_gap', 'HSP', 'Amarillo', 'TX', '600', '141.20', '93', '312.47', 'factor', '', '40']);
    assert.equal(canyon.body, rows[1].body, 'the body, with its blank line, reads back whole');
    assert.ok(canyon.body.startsWith('Hi {first_name},\n\n') && canyon.linkedin.startsWith('{first_name},'), '{first_name} is left open');
    assert.deepEqual(['plain', 'a, b', 'say "hi"', 'two\nlines'].map(csvField), ['plain', '"a, b"', '"say ""hi"""', '"two\nlines"']);
  });
  it('GET /api/outbound/export.csv serves it as a CSV file; GET /api/outbound/export counts every group once', async () => {
    const ctx = testCtx();
    const csv = await handler(req('/api/outbound/export.csv'), ctx);
    assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(String(csv.headers.get('content-disposition')), /attachment; filename="outbound-ready-drafts\.csv"/);
    assert.equal(parseCsv(await csv.text()).length, 3);
    const c = await (await handler(req('/api/outbound/export'), ctx)).json();
    assert.deepEqual([c.rows, c.ready.total, c.ready.byPlay, c.blocked.total, c.suppressed.total, c.waitingForLinkDecision, c.notTarget],
      [2, 2, { platform: 1, system_gap: 1 }, 1, 1, { total: 1, wouldJoinSystemGap: 1 }, 11]);
    assert.equal(c.ready.total + c.blocked.total + c.suppressed.total + c.waitingForLinkDecision.total + c.notTarget, c.groups);
    assert.match(c.blocked.why[0].reason, /mapped to Harborlight but not confirmed/);
    assert.deepEqual(c.suppressed.why, [{ reason: 'Jordan (crm)', groups: 1 }]);
    assert.equal(exportCounts(testCtx({ ratesCsv: join(scratch, 'none.csv') })).loaded, false);
  });
});
