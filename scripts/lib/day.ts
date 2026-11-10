// One working day at Serif as a scenario the repo can run (docs/day-in-the-life.md): the 40 base fixtures replayed, the fifteen
// events of fixtures/day/morning.json in time order, a seeded 150-scan conference list uploaded at once, and then the
// outbound summary, the attribution API, the accounts API and the team brief read back. Each event of the day carries the
// sentence a seller or marketer would expect of it, and an assertion that checks it against what the router did.
// In process, rules only, offline, HubSpot dry-run, on the context's clock. The CLI (scripts/day.ts) and test/day.test.ts run
// this same code; the test runs it on the test registry and the CLI on whatever registry the checkout has.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import accountsApi from '../../api/accounts';
import attributionApi from '../../api/attribution';
import briefApi from '../../api/brief';
import outboundApi from '../../api/outbound';
import { ROOT } from '../../src/config';
import type { Ctx } from '../../src/context';
import type { StoredAlert } from '../../src/decisions';
import type { DealSignals } from '../../src/enterprise';
import { flushListDigests } from '../../src/listDigest';
import { whenIdle } from '../../src/pipeline';
import type { StoredReferral } from '../../src/referral';
import { postFixture, runReplay } from '../../src/replay';
import type { Resolution, Route, Source } from '../../src/schema';
import type { DigestRow } from '../../src/store/today';
import { BRIEF_SECTIONS, type TodayBrief } from '../../src/todayBrief';
import { leadDetail } from '../../src/view';
import { generateList, mirrorCustomers, postList, registryOrgs, type BadgeScan, type ScanKind } from './list-upload';

/** One event of the day, as fixtures/day/morning.json holds it. */
export interface DayEvent { id: string; ts: string; source: Source; expect: string; payload: unknown }
export interface DayFile { clock: string; events: DayEvent[] }

export const loadDay = (root = ROOT): DayFile => JSON.parse(readFileSync(join(root, 'fixtures', 'day', 'morning.json'), 'utf8')) as DayFile;

export interface DayOptions { seed: number; listCount: number; listName: string }
export const DAY_DEFAULTS: DayOptions = { seed: 20261110, listCount: 150, listName: 'HLTH' };

/** The parts of a lead detail the day reads (src/view.ts leadDetail returns its JSON columns untyped). */
export interface DayLead {
  id: string; status: string; tier: string | null; score: { total: number } | null; list: string | null; flags: string[];
  person: { name: string; title: string | null } | null;
  route: Route; alert: StoredAlert; deal: DealSignals; referral: StoredReferral | null; resolution: Resolution;
  dedupe: { duplicateOf: string | null };
}

export function readLead(ctx: Ctx, id: string): DayLead {
  const d = leadDetail(ctx, id);
  if (!d) throw new Error(`no lead ${id}`);
  return d as unknown as DayLead;
}

const apiGet = async <T>(handler: (req: Request, ctx: Ctx) => Promise<Response>, ctx: Ctx, path: string): Promise<T> => {
  const res = await handler(new Request(`http://local${path}`), ctx);
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
  return (await res.json()) as T;
};

// ---- what the day reads back ----------------------------------------------------------------------------------------

export interface AskedRead { leadId: string; accountName: string | null; owner: string | null; customer: boolean; cue: string; cues: string[]; quote: string | null }
export interface FeatureRead { feature: string; status: string; launchedAt: string | null; interest: { leads: number; accounts: number; salesReady: number }; asked: AskedRead[] }
export interface AttributionRead { loaded: boolean; features: FeatureRead[] }
export interface OutboundRead {
  loaded: boolean; groups: unknown[];
  summary: { statuses: Record<string, number> } | null;
}
export interface ExportRead {
  loaded: boolean; rows: number; groups: number; ready: { total: number }; blocked: { total: number }; suppressed: { total: number };
  waitingForLinkDecision: { total: number }; notTarget: number;
}
export interface AccountsRead { total: number; accounts: { key: string; name: string | null; enterprise: boolean }[] }

export interface ListRun {
  name: string; seed: number; scans: BadgeScan[]; kinds: ScanKind[]; leadIds: (string | null)[]; codes: Record<number, number>;
  leads: DayLead[];
  /** the digests recorded for this list */
  digests: DigestRow[];
}

export interface PlayedDay {
  clock: string;
  /** the morning events' leads by event id (D01 ...) */
  morning: Record<string, DayLead>;
  list: ListRun;
  outbound: OutboundRead;
  exported: ExportRead;
  attribution: AttributionRead;
  accounts: AccountsRead;
  brief: TodayBrief;
  /** the base replay's lead count, for the report */
  baseLeads: number;
}

/** A line per decision: what the router did with each list row, in the order they were posted, with nothing that varies by run (ids). */
export function decisionFingerprint(leads: readonly DayLead[]): string[] {
  return leads.map(l => [l.tier, l.score?.total, l.route.action, l.route.team, l.route.owner, l.route.rule, l.route.slaMinutes, l.alert.slack?.channel ?? l.alert.digest?.channel ?? '-'].join('|'));
}

/** Plays the day on `ctx`: replay, the morning, the list, then the reads. The context's clock should be the day's own (DayFile.clock). */
export async function playDay(ctx: Ctx, opt: DayOptions = DAY_DEFAULTS, day: DayFile = loadDay()): Promise<PlayedDay> {
  const base = await runReplay(ctx, { wait: true });

  const morning: Record<string, DayLead> = {};
  for (const e of [...day.events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const r = await postFixture(ctx, { id: e.id, ts: e.ts, source: e.source, payload: e.payload });
    if (!r.leadId) throw new Error(`${e.id} was not accepted (HTTP ${r.status})`);
    await whenIdle(ctx);
    morning[e.id] = readLead(ctx, r.leadId);
  }
  // a later event can change an earlier lead's account (a second person at it), so read each lead again at the end of the morning
  for (const id of Object.keys(morning)) morning[id] = readLead(ctx, morning[id].id);

  const list = generateList(registryOrgs(ctx.db), mirrorCustomers(ctx.mirror), { count: opt.listCount, listName: opt.listName, seed: opt.seed, now: Date.parse(day.clock) });
  const posted = await postList(list.scans, async payload => {
    const r = await postFixture(ctx, { id: opt.listName, ts: payload.scanned_at, source: 'event_scan', payload });
    return { status: r.status, leadId: r.leadId };
  });
  await whenIdle(ctx);
  flushListDigests(ctx, { force: true });
  const digests = ctx.store.today.digests().filter(d => d.list_name === opt.listName);

  return {
    clock: day.clock,
    morning: Object.fromEntries(Object.entries(morning).map(([id, l]) => [id, readLead(ctx, l.id)])),
    list: {
      name: opt.listName, seed: opt.seed, scans: list.scans, kinds: list.kinds, leadIds: posted.ids, codes: posted.codes, digests,
      leads: posted.ids.map(id => readLead(ctx, id as string)),
    },
    outbound: await apiGet<OutboundRead>(outboundApi, ctx, '/api/outbound'),
    exported: await apiGet<ExportRead>(outboundApi, ctx, '/api/outbound/export'),
    attribution: await apiGet<AttributionRead>(attributionApi, ctx, '/api/attribution'),
    accounts: await apiGet<AccountsRead>(accountsApi, ctx, '/api/accounts?limit=500'),
    brief: await apiGet<TodayBrief>(briefApi, ctx, '/api/brief'),
    baseLeads: base.length,
  };
}

// ---- the assertions -------------------------------------------------------------------------------------------------

/** show: the line carries what was measured even when it passes */
export interface Assertion { what: string; pass: boolean; got: string; show: boolean }
export interface EventReport { id: string; expect: string; happened: string; assertions: Assertion[] }
export interface GroupReport { title: string; assertions: Assertion[]; /** what the group measured, in sentences */ facts: string[] }
export interface DayReport { events: EventReport[]; groups: GroupReport[]; passed: number; failed: number }

const is = (what: string, pass: boolean, got: string): Assertion => ({ what, pass, got, show: true });
const eq = (what: string, got: unknown, want: unknown): Assertion => ({ what, pass: got === want, got: String(got), show: false });

/** What the router did with a lead, in a line. */
export function happened(l: DayLead): string {
  const r = l.route;
  const sla = r.slaMinutes == null ? 'no SLA' : `SLA ${r.slaMinutes} min`;
  return `tier ${l.tier ?? '?'} ${l.score?.total ?? '?'}, ${r.action} to ${r.owner || r.team} (${r.team}), ${r.rule}, ${sla}${l.flags.includes('enterprise') ? ', enterprise' : ''}${l.referral ? `, referral from ${l.referral.account?.name ?? l.referral.referrer}` : ''}`;
}

const alertText = (l: DayLead): string => JSON.stringify(l.alert.slack?.blocks ?? []);
const askedFor = (p: PlayedDay, feature: string, leadId: string): AskedRead | undefined =>
  p.attribution.features.find(f => f.feature === feature)?.asked.find(a => a.leadId === leadId);

/** The assertions for each event of the day, keyed by event id. */
function eventAssertions(p: PlayedDay): Record<string, Assertion[]> {
  const m = p.morning;
  const team = (l: DayLead) => l.route.team;
  const a: Record<string, Assertion[]> = {};
  a.D01 = [
    eq('tier A', m.D01.tier, 'A'), eq('Health Systems team (HSP)', team(m.D01), 'HSP'), eq('a rep alert', m.D01.route.action, 'rep_alert'),
    is('enterprise, with its hospital fact', m.D01.deal.enterprise.enterprise && /^\d+ hospitals/.test(m.D01.deal.enterprise.fact ?? ''), String(m.D01.deal.enterprise.fact)),
    is('referral resolved to Wrenfield Health as a customer owned by Avery',
      m.D01.referral?.account?.name === 'Wrenfield Health' && m.D01.referral.account.customer === true && m.D01.referral.account.owner === 'Avery',
      m.D01.referral ? `${m.D01.referral.account?.name}, customer ${m.D01.referral.account?.customer}, owner ${m.D01.referral.account?.owner}` : 'no referral'),
  ];
  a.D02 = [eq('tier A', m.D02.tier, 'A'), eq('Benefits & Workforce (BW)', team(m.D02), 'BW'), eq('a rep alert', m.D02.route.action, 'rep_alert')];
  a.D03 = [
    is('employer inferred, flagged as such', m.D03.resolution.inferred === true, `inferred ${m.D03.resolution.inferred}`),
    eq('Benefits & Workforce (BW)', team(m.D03), 'BW'), eq('nurture, not dropped', m.D03.route.action, 'nurture'),
  ];
  a.D04 = [
    is('a named rep under the enterprise rule (R10)', m.D04.route.rule === 'R10' && !!m.D04.route.owner && m.D04.route.action === 'rep_alert', `${m.D04.route.rule} ${m.D04.route.owner}`),
    is('SLA 15 minutes or less', (m.D04.route.slaMinutes ?? 999) <= 15, String(m.D04.route.slaMinutes)),
  ];
  a.D05 = [eq('Data & API team (API)', team(m.D05), 'API')];
  const ask = askedFor(p, 'signal_ask', m.D06.id);
  a.D06 = [
    eq('an owner task', m.D06.route.action, 'owner_task'), eq('to Taylor', m.D06.route.owner, 'Taylor'),
    is('Signal Ask interest recorded and listed under asked, as a customer', !!ask && ask.customer && ask.owner === 'Taylor', ask ? `${ask.accountName}, customer ${ask.customer}, owner ${ask.owner}, cue ${ask.cue}` : 'not listed'),
  ];
  a.D07 = [eq('Payers, Life Sciences & Advisory (PLS)', team(m.D07), 'PLS')];
  a.D08 = [eq('Payers, Life Sciences & Advisory (PLS)', team(m.D08), 'PLS')];
  const visited = askedFor(p, 'network_benchmarking', m.D09.id);
  a.D09 = [
    eq('an account signal', m.D09.route.action, 'account_signal'), is('no rep alert', m.D09.alert.slack === null, m.D09.alert.slack ? 'an alert was built' : 'no alert'),
    is('Network benchmarking interest from the visited path', visited?.cue === 'path', visited ? `${visited.accountName}, cue ${visited.cue}` : 'not listed'),
  ];
  a.D10 = [eq('RevOps review', m.D10.route.action, 'review')];
  a.D11 = [eq('dropped', m.D11.route.action, 'drop'), is('no alert', m.D11.alert.slack === null, m.D11.alert.slack ? 'an alert was built' : 'no alert')];
  a.D12 = [
    eq('tier A', m.D12.tier, 'A'), eq('a rep alert', m.D12.route.action, 'rep_alert'),
    is('a referral naming Emory Healthcare, not a customer', m.D12.referral?.account?.name === 'Emory Healthcare' && m.D12.referral.account.customer === false,
      m.D12.referral ? `${m.D12.referral.account?.name}, customer ${m.D12.referral.account?.customer}` : 'no referral'),
  ];
  a.D13 = [
    is('the same rep as D01', !!m.D13.route.owner && m.D13.route.owner === m.D01.route.owner, `${m.D13.route.owner} and ${m.D01.route.owner}`),
    is('the alert names Helena Marsh', alertText(m.D13).includes('Helena Marsh'), alertText(m.D13).includes('Helena Marsh') ? 'named' : 'not named'),
  ];
  a.D14 = [eq('an owner task', m.D14.route.action, 'owner_task'), eq('to Avery', m.D14.route.owner, 'Avery')];
  a.D15 = [eq('Benefits & Workforce (BW)', team(m.D15), 'BW')];
  return a;
}

const FOLDED = ['team_queue', 'owner_task', 'nurture', 'review'];

/** The list's assertions. `again` is the same list's decisions from a second run with the same seed. */
function listAssertions(p: PlayedDay, again: readonly string[]): Assertion[] {
  const l = p.list;
  const unfinished = l.leads.filter(x => x.status !== 'done').length;
  const ownAlert = l.leads.filter(x => x.alert.slack && x.route.action !== 'rep_alert').length;
  const perTeam = new Map<string, number>();
  for (const d of l.digests) perTeam.set(d.team, (perTeam.get(d.team) ?? 0) + 1);
  const mostDigests = Math.max(0, ...perTeam.values());
  const unfolded = l.leads.filter(x => FOLDED.includes(x.route.action) && !x.alert.digest).length;
  // a repeat is the same badge scanned again. The list is shuffled, so the scan accepted first may be either of the pair; the later
  // one attaches to the earlier when the earlier went to a person (decision 6), and is routed on its own when it went to nurture
  const pairs = l.kinds.flatMap((k, i) => {
    if (k !== 'repeat') return [];
    const other = l.scans.findIndex((s, j) => j !== i && l.kinds[j] !== 'repeat' && s.badge.email === l.scans[i].badge.email);
    return other >= 0 ? [{ early: l.leads[Math.min(i, other)], late: l.leads[Math.max(i, other)] }] : [];
  });
  const wentToSales = (x: DayLead) => ['rep_alert', 'owner_task', 'team_queue', 'review'].includes(x.route.action);
  const attached = pairs.filter(({ late }) => late.route.action === 'attach_to_existing');
  const owed = pairs.filter(({ early }) => wentToSales(early));
  const missed = owed.filter(({ late }) => late.route.action !== 'attach_to_existing').length;
  const mine = decisionFingerprint(l.leads);
  return [
    eq(`all ${l.scans.length} scans accepted`, l.codes[202] ?? 0, l.scans.length),
    eq('every row finished', unfinished, 0),
    eq('no row alerted on its own unless it is a rep alert', ownAlert, 0),
    eq('every team-queue, owner-task, nurture and review row waits for its digest', unfolded, 0),
    is('at most one digest per team (the review digest included)', mostDigests <= 1, `${l.digests.length} digests, at most ${mostDigests} for a team`),
    is('every repeat scan is attached to the scan accepted first, when that one went to a person', missed === 0,
      `${attached.length} of ${pairs.length} attached; ${owed.length - missed} of ${owed.length} owed; ${pairs.length - owed.length} followed a nurture and were routed on their own`),
    is('decisions identical across two runs with the same seed', mine.length === again.length && mine.every((x, i) => x === again[i]), `${mine.length} rows compared`),
  ];
}

const tally = (xs: readonly string[]): string => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([k, v]) => `${v} ${k}`).join(', ');
};

function listFacts(p: PlayedDay): string[] {
  const l = p.list;
  return [
    `tiers: ${tally(l.leads.map(x => x.tier ?? 'none'))}`,
    `routes: ${tally(l.leads.map(x => x.route.action))}`,
    `digests: ${l.digests.length} (${tally(l.digests.map(d => d.team))}), ${l.digests.reduce((a, d) => a + d.rows, 0)} rows folded into them`,
  ];
}

function outboundGroup(p: PlayedDay): GroupReport {
  const e = p.exported;
  if (!e.loaded) return { title: 'Outbound', assertions: [is('the rate file is loaded', false, 'not loaded')], facts: [] };
  const sum = e.ready.total + e.blocked.total + e.suppressed.total + e.waitingForLinkDecision.total + e.notTarget;
  return {
    title: 'Outbound',
    assertions: [
      is('ready, blocked, suppressed, waiting for a link and not a target add up to the groups', sum === e.groups, `${sum} of ${e.groups}`),
      eq('the export has one row per ready draft', e.rows, e.ready.total),
    ],
    facts: [`${e.groups} groups: ${e.ready.total} ready, ${e.blocked.total} blocked, ${e.suppressed.total} suppressed, ${e.waitingForLinkDecision.total} waiting for a link decision, ${e.notTarget} not a target; ${e.rows} export rows`],
  };
}

function accountsGroup(p: PlayedDay): GroupReport {
  const list = p.accounts.accounts;
  const firstOther = list.findIndex(a => !a.enterprise);
  const lastEnterprise = list.map(a => a.enterprise).lastIndexOf(true);
  const commonSpirit = list.find(a => /commonspirit/i.test(a.name ?? ''));
  return {
    title: 'Accounts',
    assertions: [
      is('enterprise accounts come before every other account', firstOther === -1 || lastEnterprise < firstOther, `${list.filter(a => a.enterprise).length} enterprise of ${p.accounts.total}`),
      is('CommonSpirit Health is an enterprise account', !!commonSpirit?.enterprise, commonSpirit ? `${commonSpirit.name}, enterprise ${commonSpirit.enterprise}` : 'not in the list'),
    ],
    facts: [`${p.accounts.total} accounts, ${list.filter(a => a.enterprise).length} of them enterprise`],
  };
}

function interestGroup(p: PlayedDay): GroupReport {
  const f = (key: string) => p.attribution.features.find(x => x.feature === key);
  const ask = f('signal_ask');
  return {
    title: 'Feature interest',
    assertions: [
      is('Signal Ask is a feature in preview with no launch date', ask?.status === 'preview' && ask.launchedAt === null, ask ? `${ask.status}, launched ${ask.launchedAt}` : 'not listed'),
      is('the benefits playbook D03 took shows as Network benchmarking interest, by its guide', askedFor(p, 'network_benchmarking', p.morning.D03.id)?.cue === 'guide', askedFor(p, 'network_benchmarking', p.morning.D03.id)?.cue ?? 'not listed'),
      is('Mercer named Network Benchmarking in its message (D02)', askedFor(p, 'network_benchmarking', p.morning.D02.id)?.cue === 'message', askedFor(p, 'network_benchmarking', p.morning.D02.id)?.cue ?? 'not listed'),
    ],
    facts: [p.attribution.features.map(x => `${x.feature} ${x.interest.leads}`).join(', ')],
  };
}

function briefGroup(p: PlayedDay): GroupReport {
  const missing = BRIEF_SECTIONS.filter(id => !p.brief.sections[id]);
  return {
    title: 'The brief',
    assertions: [is(`all ${BRIEF_SECTIONS.length} sections present`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : BRIEF_SECTIONS.join(', '))],
    facts: BRIEF_SECTIONS.filter(id => p.brief.sections[id]).map(id => `${p.brief.sections[id].title}: ${p.brief.sections[id].headline}`),
  };
}

/** Checks the played day. `again` is the list's decision fingerprint from a second run with the same seed. */
export function checkDay(p: PlayedDay, day: DayFile, again: readonly string[]): DayReport {
  const byEvent = eventAssertions(p);
  const events = day.events.map((e): EventReport => ({ id: e.id, expect: e.expect, happened: happened(p.morning[e.id]), assertions: byEvent[e.id] ?? [] }));
  const groups: GroupReport[] = [
    { title: `The ${p.list.name} list`, assertions: listAssertions(p, again), facts: listFacts(p) },
    outboundGroup(p), accountsGroup(p), interestGroup(p), briefGroup(p),
  ];
  const all = [...events.flatMap(e => e.assertions), ...groups.flatMap(g => g.assertions)];
  return { events, groups, passed: all.filter(x => x.pass).length, failed: all.filter(x => !x.pass).length };
}

/** The report as text: each event with its expectation, what happened and each assertion, then the groups. */
export function reportText(p: PlayedDay, r: DayReport): string {
  const mark = (a: Assertion) => `    ${a.pass ? 'pass' : 'FAIL'}  ${a.what}${a.pass ? (a.show ? ` (${a.got})` : '') : ` (got ${a.got})`}`;
  const lines = [`The day, ${p.clock.slice(0, 10)}: ${p.baseLeads} base fixtures replayed, ${r.events.length} morning events, a ${p.list.scans.length}-row ${p.list.name} list`, ''];
  for (const e of r.events) {
    const ok = e.assertions.every(a => a.pass);
    lines.push(`${e.id}  ${ok ? 'PASS' : 'FAIL'}  ${e.expect}`, `    happened: ${e.happened}`, ...e.assertions.map(mark));
  }
  for (const g of r.groups) {
    lines.push('', `${g.title}  ${g.assertions.every(a => a.pass) ? 'PASS' : 'FAIL'}`, ...g.assertions.map(mark), ...g.facts.map(f => `    ${f}`));
  }
  lines.push('', `${r.passed} assertions passed, ${r.failed} failed`);
  return `${lines.join('\n')}\n`;
}
