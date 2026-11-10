// The outbound module end to end on the synthetic rate file (test/fixtures/rates-mini.csv, invented groups): loading,
// one finding per group, registry links, targeting, drafts, the dry-run HubSpot body, the API, and the rate line an
// inbound lead's brief carries.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import handler from '../api/outbound';
import { COMPANY_PROPERTIES, PATHS } from '../src/crm/hubspot';
import { campaignOf } from '../src/outbound/campaign';
import { hookFor, HOOKS, renderDraft, TEMPLATES, type Draft } from '../src/outbound/draft';
import { rateLine } from '../src/outbound/fact';
import { targetingOf } from '../src/outbound/targeting';
import { outboundDetail, outboundSummary } from '../src/outbound/view';
import { resolveByName, type NameLink } from '../src/resolve';
import { RATES_MINI, submit, testCtx } from './helpers';

const scratch = mkdtempSync(join(tmpdir(), 'outbound-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A rate file of the fixture's header and the given rows, written to the scratch folder. */
function rateFile(name: string, rows: string[]): string {
  const header = readFileSync(RATES_MINI, 'utf8').split(/\r?\n/)[0];
  const path = join(scratch, name);
  writeFileSync(path, [header, ...rows].join('\n') + '\n');
  return path;
}
/** One fixture-format row: an organization with one flagged rate. */
const row = (ein: string, name: string, address: string, state: string, clinicians: number, rate: string, pct: string) =>
  `UnitedHealthcare,Choice Plus,202608,"${name}",${ein},"1900000999",1,5,${clinicians},Psychiatry Physician,${state},"${address}",90837,11,true,$${rate},true,$165,${pct}%`;

const get = (path: string) => new Request(`http://local${path}`);
const unlinked: NameLink = { status: 'unlinked', accountId: null, accountName: null, method: 'company_name', score: null, reason: 'none', candidates: [] };

describe('outbound: loading the rate file', () => {
  it('loads every row, finds the card and the factor by search, and keeps one finding per group', () => {
    const ctx = testCtx();
    assert.deepEqual([ctx.outbound.status, ctx.outbound.rows, ctx.outbound.groups], ['loaded', 16, 12]);
    const p = ctx.store.outbound.patterns();
    assert.deepEqual([p.card?.value, p.card?.hits, p.card?.distinctRates], [143.21, 5, 14]);
    assert.deepEqual([p.factor?.value, p.factor?.hits], [3.53, 4]);
  });
  it('one rate per group: the flagged row, then the largest NPI list, then the most psychiatrists, then the higher rate', () => {
    const ctx = testCtx();
    const g = (ein: string) => ctx.store.outbound.group(ein)!;
    assert.equal(g('900000010').rate, 150.37, 'the flagged row beats a larger NPI list and a higher rate');
    assert.equal(g('900000011').rate, 160.13, 'nothing flagged and the same NPI list: the row with more psychiatrists');
    assert.equal(g('900000012').rate, 211.80, 'equal on every count: the higher rate');
    const rows = ctx.store.outbound.sourceRows('900000010');
    assert.deepEqual(rows.map(r => [r.rate, r.chosen]), [[150.37, 1], [199.99, 0], [122.41, 0]]);
  });
  it('each finding has the EIN as its key, the form, the city top and the band median', () => {
    const ctx = testCtx();
    const both = ctx.store.outbound.group('900000006')!;
    assert.equal(both.accountKey, 'ein:900000006');
    assert.deepEqual([both.form, both.cardTier, both.factorMultiple, both.pctOfMedicare], ['both', 281, 114, 252]);
    const small = ctx.store.outbound.group('900000003')!;
    assert.deepEqual([small.city, small.state, small.band, small.form, small.cardTier], ['Tulsa', 'OK', '1-50', 'card', 80]);
    assert.deepEqual([small.cityTopRate, small.cityTopClinicians, small.cityTopEin], [402.42, 320, '900000006']);
    assert.deepEqual(['900000003', '900000011', '900000007'].map(e => ctx.store.outbound.group(e)!.bandMedianPct), [78, 95.5, 132]);
    assert.deepEqual(['900000011', '900000007'].map(e => ctx.store.outbound.group(e)!.form), ['neither', 'neither']);
  });
  it('does nothing on a restart with the same file, and reloads when the file changes', () => {
    const appDb = join(scratch, 'reload.sqlite');
    const file = rateFile('reload.csv', [row('800000001', 'ALPHA GROUP', '1 A ST, AUSTIN, TX 78701', 'TX', 10, '114.57', '69')]);
    assert.equal(testCtx({ appDb, ratesCsv: file }).outbound.status, 'loaded');
    assert.equal(testCtx({ appDb, ratesCsv: file }).outbound.status, 'unchanged');
    writeFileSync(file, readFileSync(file, 'utf8') + row('800000002', 'BETA GROUP', '2 B ST, AUSTIN, TX 78701', 'TX', 12, '128.89', '78') + '\n');
    const changed = testCtx({ appDb, ratesCsv: file });
    assert.deepEqual([changed.outbound.status, changed.outbound.groups], ['loaded', 2]);
  });
  it('with no file, or a file it cannot read, the tables are empty and the API says why', async () => {
    const appDb = join(scratch, 'missing.sqlite');
    assert.equal(testCtx({ appDb }).outbound.status, 'loaded');
    const missing = testCtx({ appDb, ratesCsv: join(scratch, 'nope.csv') });
    assert.equal(missing.outbound.status, 'missing');
    assert.equal(missing.store.outbound.allGroups().length, 0, 'the earlier load does not linger');
    const summary = outboundSummary(missing);
    assert.deepEqual([summary.loaded, summary.groups.length], [false, 0]);
    assert.match(String(summary.reason), /No rate file at .*nope\.csv\. npm run rates:fetch/);
    const res = await handler(get('/api/outbound/900000001'), missing);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /No rate file/);

    const broken = testCtx({ ratesCsv: rateFile('broken.csv', ['not,enough']) });
    assert.equal(broken.outbound.status, 'failed');
    assert.match(broken.outbound.message, /could not be loaded: CSV record 1/);
    assert.equal(outboundSummary(broken).loaded, false);
  });
});

describe('outbound: identity and targeting', () => {
  it('links a name and state to the registry only on a unique, strong match; a tie stays unlinked with its candidates', () => {
    const ctx = testCtx();
    const hit = resolveByName(ctx, 'INTERMOUNTAIN HEALTH', 'UT');
    assert.deepEqual([hit.status, hit.accountId, hit.method], ['linked', 'ahrq:SYS-INTERMTN', 'company_name']);
    const tie = resolveByName(ctx, 'Baptist Health', null);
    assert.equal(tie.status, 'unlinked');
    assert.equal(tie.accountId, null);
    assert.match(tie.reason, /^tie: /);
    assert.ok(tie.candidates.length >= 2, 'the candidates a person would choose from are kept');
    const weak = resolveByName(ctx, 'Northwind Psychiatry PLLC', 'OK');
    assert.deepEqual([weak.status, weak.accountId], ['unlinked', null]);
  });
  it('stores every group link with its method and score, and the invented groups link to nothing', () => {
    const ctx = testCtx();
    const link = ctx.store.outbound.link('900000007')!;
    assert.deepEqual([link.status, link.method], ['unlinked', 'company_name']);
    assert.equal(ctx.store.outbound.linkedAccounts().size, 0);
  });
  it('a confirmed platform is a target with a ready draft; an unconfirmed one is a target with a blocked draft', () => {
    const ctx = testCtx();
    const ready = ctx.store.outbound.group('900000008')!;
    assert.deepEqual([ready.fit, ready.platform, ready.platformConfirmed, ready.draftStatus, ready.draftReason], ['target', 'Harborlight', true, 'ready', null]);
    const blocked = ctx.store.outbound.group('900000009')!;
    assert.deepEqual([blocked.fit, blocked.platformConfirmed, blocked.draftStatus], ['target', false, 'blocked']);
    assert.match(String(blocked.draftReason), /not confirmed .* only called theirs once it is/);
  });
  it('small independent groups and hospital systems are not targets, each with a one-line reason', () => {
    const ctx = testCtx();
    const small = ctx.store.outbound.group('900000003')!;
    assert.deepEqual([small.fit, small.draftStatus], ['not_target', 'none']);
    assert.match(small.fitReason, /Small independent group: the subject of the finding, not the buyer/);
    assert.match(ctx.store.outbound.group('900000007')!.fitReason, /Not a mapped behavioral health platform/);
    const hospital = targetingOf(ctx.store.outbound.group('900000007')!, { ...unlinked, status: 'linked', accountId: 'ahrq:SYS-X', accountName: 'X Health' }, undefined);
    assert.equal(hospital.fit, 'not_target');
    assert.match(hospital.fitReason, /Hospital or health system \(X Health\)/);
    const summary = outboundSummary(ctx);
    assert.deepEqual(summary.summary?.fit, { target: 2, notTarget: 10 });
    assert.deepEqual(summary.summary?.drafts, { ready: 1, blocked: 1 });
  });
  it('summarizes by size band and contract form, counting a group on both patterns in both columns', () => {
    const s = outboundSummary(testCtx()).summary!;
    assert.deepEqual(s.bands.map(b => [b.band, b.groups, b.card, b.factor, b.both, b.neither]), [
      ['1-50', 5, 5, 0, 0, 0], ['51-500', 4, 2, 2, 1, 1], ['501+', 3, 0, 1, 0, 2],
    ]);
    assert.deepEqual(s.forms, { card: 6, factor: 2, both: 1, neither: 3 });
  });
});

/** Every number in a text: "$131.02", "79%", "1,100" and "90837" come back as 131.02, 79, 1100 and 90837. */
const numbersIn = (text: string) => (text.match(/\d[\d,]*(\.\d+)?/g) ?? []).map(n => Number(n.replace(/,/g, '')));

describe('outbound: drafts', () => {
  const draftFor = (ein: string, hook?: Draft['hook']) => {
    const ctx = testCtx();
    const d = outboundDetail(ctx, ein)!;
    if (!hook) return d.draft!;
    const g = ctx.store.outbound.group(ein)!;
    const file = ctx.store.outbound.file()!;
    const campaign = campaignOf(file.scope, ctx.store.outbound.allGroups(), ctx.store.outbound.patterns());
    return renderDraft({ finding: g, platform: g.platform, status: g.draftStatus, reason: g.draftReason, hook, campaign });
  };

  it('renders the subject, a greeting and five sentences, and the LinkedIn follow-up, with {first_name} left open', () => {
    const d = draftFor('900000008');
    assert.equal(d.kind, 'draft');
    assert.equal(d.status, 'ready');
    assert.equal(d.subject, "Harborlight's UHC rate in Texas: 79% of Medicare");
    const [greeting, text] = d.body.split('\n\n');
    assert.equal(greeting, 'Hi {first_name},');
    assert.equal(text.split(/(?<=[.?])\s+/).length, 5);
    assert.match(text, /^In UnitedHealthcare's August Choice Plus file, Harborlight's Texas entity \(780 clinicians\) is paid \$131\.02 for a 60-minute session \(90837\), 79% of Medicare\./);
    assert.match(d.linkedin, /^\{first_name\}, I sent a note on Harborlight's UHC rates \(79% of Medicare in Texas/);
    assert.deepEqual(d.placeholders, ['{first_name}']);
  });
  it('every number in the subject, email and follow-up was inserted by code, and each insert names its field', () => {
    for (const ein of ['900000008', '900000009', '900000003', '900000006']) {
      for (const hook of HOOKS) {
        const d = draftFor(ein, hook);
        const inserted = new Set(d.inserted.flatMap(v => numbersIn(v.value)));
        for (const n of numbersIn(`${d.subject}\n${d.body}\n${d.linkedin}`)) assert.ok(inserted.has(n), `${ein} ${hook}: ${n} is not in the inserted values`);
        assert.ok(d.inserted.every(v => v.field.length > 0 && v.placeholder.startsWith('{')));
      }
    }
  });
  it('the templates carry no figures of their own', () => {
    for (const t of TEMPLATES) assert.doesNotMatch(t, /\d/, t);
  });
  it('the two hooks are assigned by EIN, the same every time, and both are in use', () => {
    const ctx = testCtx();
    const groups = ctx.store.outbound.allGroups();
    assert.ok(groups.every(g => g.hook === hookFor(g.ein)));
    assert.deepEqual(new Set(groups.map(g => g.hook)), new Set(HOOKS));
    const range = draftFor('900000009', 'rate_range');
    assert.match(range.body, /That is above the \$114 to \$129 range where most small psychiatry groups sit, which looks like one UHC fee schedule paid at 80% to 90%\./);
    const leverage = draftFor('900000009', 'hospital_leverage');
    assert.match(leverage.body, /Groups with more than 500 clinicians are paid a median of 132% of Medicare/);
    assert.match(leverage.body, /Groups with 50 or fewer clinicians sit at a median of 78%/);
  });
  it('a blocked draft is marked blocked with its reason; any other group renders only as a labelled preview', () => {
    const blocked = draftFor('900000009');
    assert.deepEqual([blocked.kind, blocked.status], ['draft', 'blocked']);
    assert.match(String(blocked.reason), /not confirmed/);
    const preview = draftFor('900000003');
    assert.deepEqual([preview.kind, preview.status], ['preview', 'preview']);
    assert.match(preview.label, /^Preview only: this group is not a target/);
    assert.match(preview.subject, /^NORTHWIND PSYCHIATRY PLLC's UHC rate in Oklahoma/);
  });
  it('without a card range the rate-range hook falls back to hospital leverage, and says so', () => {
    const ctx = testCtx({ ratesCsv: rateFile('no-card.csv', [row('800000003', 'GAMMA GROUP', '3 C ST, DALLAS, TX 75201', 'TX', 600, '147.64', '88')]) });
    const g = ctx.store.outbound.group('800000003')!;
    const campaign = campaignOf(ctx.store.outbound.file()!.scope, [g], ctx.store.outbound.patterns());
    const d = renderDraft({ finding: g, platform: null, status: 'none', reason: null, hook: 'rate_range', campaign });
    assert.equal(d.hook, 'hospital_leverage');
    assert.match(String(d.hookNote), /no card range/);
  });
});

describe('outbound: HubSpot (dry-run) and the API', () => {
  it('a target gets a company upsert keyed on ein:<EIN> that carries the finding; nothing is enqueued or written', () => {
    const ctx = testCtx();
    const plan = outboundDetail(ctx, '900000008')!.hubspot;
    assert.equal(plan.mode, 'dry_run');
    assert.equal(plan.requests.length, 1);
    const [req] = plan.requests;
    assert.deepEqual([req.method, req.path], ['POST', PATHS.companiesUpsert]);
    const input = (req.body as { inputs: { id: string; idProperty: string; properties: Record<string, unknown> }[] }).inputs[0];
    assert.deepEqual([input.id, input.idProperty], ['ein:900000008', 'serif_account_key']);
    assert.deepEqual([input.properties.serif_rate, input.properties.serif_rate_pct_medicare, input.properties.serif_contract_form, input.properties.serif_platform],
      [131.02, 79, 'neither', 'Harborlight']);
    const defined = new Set([...COMPANY_PROPERTIES.map(p => p.name), 'name', 'city', 'state']);
    for (const k of Object.keys(input.properties)) assert.ok(defined.has(k), `${k} is defined in docs/hubspot-properties.json or is a standard property`);
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM crm_outbox`).get() as { n: number }).n, 0);
  });
  it('any other group gets no request, with the reason', () => {
    const plan = outboundDetail(testCtx(), '900000003')!.hubspot;
    assert.deepEqual(plan.requests, []);
    assert.match(String(plan.skipped), /^not a target: Small independent group/);
  });
  it('GET /api/outbound lists the patterns, the summary and every group; GET /api/outbound/<ein> the rest; nothing else', async () => {
    const ctx = testCtx();
    const list = await (await handler(get('/api/outbound'), ctx)).json();
    assert.equal(list.loaded, true);
    assert.deepEqual([list.file.rows, list.file.groups, list.file.code, list.patterns.card.base, list.patterns.factor.unit], [16, 12, '90837', 143.21, 3.53]);
    assert.equal(list.groups.length, 12);
    const one = await (await handler(get('/api/outbound/900000008'), ctx)).json();
    assert.deepEqual(Object.keys(one).sort(), ['draft', 'draftUnavailable', 'finding', 'hubspot', 'link', 'rateLine', 'sourceRows']);
    assert.equal(one.draft.inserted.length > 0, true);
    assert.equal((await handler(get('/api/outbound/123'), ctx)).status, 404);
    assert.equal((await handler(new Request('http://local/api/outbound', { method: 'POST' }), ctx)).status, 405);
  });
});

describe('outbound: the rate line in the router', () => {
  it('reads like the take-home: rate, percent of Medicare, the form and the top rate in the city', () => {
    const ctx = testCtx();
    const t = { payer: 'UnitedHealthcare', payerShort: 'UHC', network: 'Choice Plus', code: '90837', month: 'August', monthShort: 'Aug', year: '2026', sessionMinutes: 60 };
    const parkland = { ...ctx.store.outbound.group('900000005')!, rate: 163.09, pctOfMedicare: 97, cardTier: null, factorMultiple: 47, city: 'Dallas', cityTopRate: 378.38, cityTopEin: 'other' };
    assert.equal(rateLine(parkland, t, 141.47, 1), 'Their UHC Choice Plus rate for 90837 (Aug 2026): $163.09, 97% of Medicare, a $47 conversion factor; top rate in Dallas $378.38.');
    const top = ctx.store.outbound.group('900000006')!;
    assert.equal(rateLine(top, t, 143.21, 2),
      'Their UHC Choice Plus rate for 90837 (Aug 2026): $402.42, 252% of Medicare, 281% of a $143.21 rate card and a $114 conversion factor; the top rate in Tulsa (LONE PEAK MEDICAL GROUP, the largest of 2 rate groups that match).');
  });

  const northwind = { first: 'Pat', last: 'Okafor', email: 'pat@northwind-psych.example', company: 'Northwind Psychiatry PLLC', state: 'OK', title: 'Director of Payer Contracting', message: 'We renegotiate with UnitedHealthcare next quarter and want peer rates.' };

  it('a lead whose organization matches a group by name and state carries the line in its brief, Slack alert and CRM task', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo', northwind);
    const line = 'Their UHC Choice Plus rate for 90837 (Aug 2026): $114.57, 72% of Medicare, 80% of a $143.21 rate card; top rate in Tulsa $402.42.';
    assert.deepEqual([lead.rateFact.ein, lead.rateFact.matchedBy, lead.rateFact.line], ['900000003', 'name_and_state', line]);
    const fields = lead.alert.slack.blocks[1].fields.map((f: { text: string }) => f.text);
    assert.ok(fields.includes(`*Their rates*\n${line}`), 'the Slack alert has a Their rates field');
    const task = lead.crm.requests.find((r: { path: string }) => r.path === PATHS.tasks);
    assert.ok(task.body.properties.hs_task_body.includes(line), 'the CRM task body carries the line');
  });
  it('a lead resolved to a registry account that a group links to gets that group\'s line', async () => {
    const file = rateFile('linked.csv', [row('800000010', 'INTERMOUNTAIN HEALTH', '36 S STATE ST, SALT LAKE CITY, UT 84111', 'UT', 4100, '212.86', '129')]);
    const ctx = testCtx({ ratesCsv: file });
    assert.equal(ctx.store.outbound.link('800000010')?.accountId, 'ahrq:SYS-INTERMTN');
    const { lead } = await submit(ctx, 'calendly_demo');
    assert.equal(lead.resolution.accountId, 'ahrq:SYS-INTERMTN');
    assert.deepEqual([lead.rateFact.ein, lead.rateFact.matchedBy], ['800000010', 'registry_link']);
    assert.match(lead.rateFact.line, /^Their UHC Choice Plus rate for 90837 \(Aug 2026\): \$212\.86, 129% of Medicare; the top rate in Salt Lake City\.$/);
  });
  it('the line changes no score and no route, and a lead with no rate group carries none', async () => {
    const withRates = (await submit(testCtx(), 'calendly_demo', northwind)).lead;
    const without = (await submit(testCtx({ ratesCsv: join(scratch, 'none.csv') }), 'calendly_demo', northwind)).lead;
    assert.equal(without.rateFact, null);
    assert.deepEqual([withRates.score, withRates.tier, withRates.route], [without.score, without.tier, without.route]);
    assert.equal((await submit(testCtx(), 'calendly_demo', { ...northwind, state: 'TX' })).lead.rateFact, null, 'the same name in another state is not the group');
  });
});
