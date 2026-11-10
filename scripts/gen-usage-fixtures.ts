// Generates fixtures/usage/events.json and fixtures/usage/deals.json from the tables below.
// Everything is invented. The twelve accounts are the fictional organizations in fixtures/crm-mirror.json (reserved .example domains);
// the people are made-up names at those domains; every event and deal carries "synthetic": true. No real organization appears.
//
// The story the tables tell is meant to be believable and modest, not tidy: some features have no visible effect (Signal search is
// used by nearly everyone, so there is almost nobody to compare to), the counts are small, and one account looked at the
// quality preview and still lost the add-on deal. Edit the tables and run `npm run gen-usage`. features.json is written by hand.
//
// The randomness is a seeded generator, so a run with the same tables writes the same files, uuids included.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config';
import type { CrmMirrorEntry } from '../src/schema';
import { primaryEvent, type Feature } from '../src/usage/taxonomy';

const DIR = join(ROOT, 'fixtures', 'usage');
const mirror = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'crm-mirror.json'), 'utf8')) as CrmMirrorEntry[];
const features = (JSON.parse(readFileSync(join(DIR, 'features.json'), 'utf8')) as { features: { feature: Feature; launchedAt: string }[] }).features;
const launch = new Map(features.map(f => [f.feature, f.launchedAt]));

/** Made-up people per account: a first initial and a surname each. */
const PEOPLE: Record<string, string[]> = {
  wrenfield: ['a.okafor', 'd.lindqvist', 'r.haddad'],
  tallowmere: ['m.brandt', 'k.osei', 'l.varga'],
  quillhaven: ['s.moreau', 't.abara'],
  thistledown: ['e.petrov', 'j.castellanos'],
  copperleaf: ['n.iyer', 'b.lund', 'c.mwangi'],
  brindlewood: ['h.tanaka', 'p.dubois', 'w.achterberg', 'f.kaplan'],
  sparrowgate: ['g.rossi', 'o.nwosu'],
  lumenfold: ['i.sandoval', 'u.berg', 'z.khalil'],
  ravensmoor: ['y.fontaine', 'v.ostrowski'],
  fennick: ['q.halvorsen', 'x.mendes'],
  brookmere: ['a.zielinski', 'l.moyo', 'd.paquette'],
  alderfinch: ['t.sorensen', 'c.adeyemi'],
};

// ---- usage ----------------------------------------------------------------------------------------------------------------
// A run of n events between two days (the first on `from`, the last on `to`, the rest spread across weekdays between), or an
// explicit list of days. `who` limits which of the account's people do it (indexes into PEOPLE).
interface Use { a: string; f: Feature; n?: number; from?: string; to?: string; days?: string[]; who?: number[] }
const run = (a: string, f: Feature, n: number, from: string, to: string, who?: number[]): Use => ({ a, f, n, from, to, who });
const on = (a: string, f: Feature, days: string[], who?: number[]): Use => ({ a, f, days, who });

const USES: Use[] = [
  // Signal search: nearly everyone, so there is almost no one to compare them to
  run('wrenfield', 'signal_search', 24, '2025-10-01', '2026-11-06'), run('tallowmere', 'signal_search', 14, '2026-01-05', '2026-11-05'),
  run('quillhaven', 'signal_search', 10, '2026-02-02', '2026-10-28'), run('thistledown', 'signal_search', 8, '2026-02-23', '2026-10-20'),
  run('copperleaf', 'signal_search', 12, '2026-03-02', '2026-11-04'), run('brindlewood', 'signal_search', 16, '2026-03-16', '2026-11-06'),
  run('sparrowgate', 'signal_search', 5, '2026-04-01', '2026-08-12'), run('ravensmoor', 'signal_search', 7, '2026-01-26', '2026-10-12'),
  run('fennick', 'signal_search', 9, '2026-05-04', '2026-11-02'), run('brookmere', 'signal_search', 11, '2025-11-10', '2026-11-03'),
  run('alderfinch', 'signal_search', 4, '2026-05-18', '2026-08-03'),
  // Signal Watch (launched 2026-02-09): the health systems, the payer and the broker that renews
  run('wrenfield', 'signal_watch', 14, '2026-02-24', '2026-11-05'), run('tallowmere', 'signal_watch', 9, '2026-04-14', '2026-11-03'),
  run('brindlewood', 'signal_watch', 11, '2026-05-05', '2026-11-04'), run('copperleaf', 'signal_watch', 6, '2026-07-14', '2026-10-27'),
  run('brookmere', 'signal_watch', 5, '2026-09-01', '2026-11-03'), run('thistledown', 'signal_watch', 4, '2026-08-10', '2026-10-14'),
  // API (launched 2025-11-03): the two data companies, with a little from a TPA and a payer
  run('sparrowgate', 'api', 30, '2026-03-02', '2026-11-05'), run('lumenfold', 'api', 34, '2026-03-30', '2026-11-06', [0, 1]),
  run('fennick', 'api', 8, '2026-06-01', '2026-10-30'), run('brindlewood', 'api', 5, '2026-07-06', '2026-10-08'),
  // MCP tools (launched 2026-05-04): two accounts, one of them new to it
  run('lumenfold', 'mcp', 16, '2026-05-18', '2026-11-06', [0, 2]), run('sparrowgate', 'mcp', 5, '2026-09-14', '2026-11-05'),
  // Network benchmarking (launched 2026-06-15): benefits, the payers and one health system
  run('copperleaf', 'network_benchmarking', 12, '2026-06-22', '2026-11-02'), run('alderfinch', 'network_benchmarking', 5, '2026-06-29', '2026-07-30'),
  run('brookmere', 'network_benchmarking', 7, '2026-09-21', '2026-11-04'), run('brindlewood', 'network_benchmarking', 9, '2026-07-13', '2026-10-27'),
  run('tallowmere', 'network_benchmarking', 4, '2026-08-31', '2026-10-22'),
  // Quality data preview (launched 2026-08-17): explicit days, because the dates are the story.
  // Wrenfield used it before and during its add-on deal and bought; Tallowmere is mid-deal; Quillhaven used it and lost the deal;
  // Brindlewood (5 uses) and Copperleaf (3) used it in the last 30 days with no add-on deal: the two expansion signals.
  // Lumenfold used it twice, under the threshold. Sparrowgate used it three times, but more than 30 days ago.
  // Brookmere is not a customer yet, so its four uses are not a signal.
  on('wrenfield', 'quality_preview', ['2026-08-24', '2026-09-02', '2026-09-09', '2026-09-15', '2026-09-30']),
  on('tallowmere', 'quality_preview', ['2026-10-02', '2026-10-06', '2026-10-09', '2026-10-14', '2026-10-20', '2026-10-28', '2026-11-03']),
  on('quillhaven', 'quality_preview', ['2026-09-14', '2026-09-17', '2026-09-22', '2026-10-02', '2026-10-12']),
  on('brindlewood', 'quality_preview', ['2026-10-14', '2026-10-15', '2026-10-21', '2026-10-29', '2026-11-04']),
  on('copperleaf', 'quality_preview', ['2026-10-20', '2026-10-27', '2026-11-03']),
  on('lumenfold', 'quality_preview', ['2026-10-26', '2026-11-02']),
  on('sparrowgate', 'quality_preview', ['2026-09-28', '2026-09-30', '2026-10-02']),
  on('brookmere', 'quality_preview', ['2026-10-12', '2026-10-13', '2026-10-19', '2026-10-26']),
  on('thistledown', 'quality_preview', ['2026-10-30']),
];

// PostHog sends events this project does not map. They are kept and counted as unmapped.
const NOISE: { name: string; per: number }[] = [{ name: '$pageview', per: 3 }, { name: 'export_downloaded', per: 2 }];
// Events from a company group the router does not know, and one with no group at all: stored, counted as unresolved.
const STRANGERS: { group: string | null; f: Feature; at: string }[] = [
  { group: 'unlisted-clinic.example', f: 'signal_search', at: '2026-09-03T15:10:00.000Z' },
  { group: 'unlisted-clinic.example', f: 'signal_search', at: '2026-09-03T15:14:00.000Z' },
  { group: 'unlisted-clinic.example', f: 'api', at: '2026-09-04T16:02:00.000Z' },
  { group: null, f: 'api', at: '2026-10-08T14:40:00.000Z' },
];

// ---- deals ----------------------------------------------------------------------------------------------------------------
interface DealRow { id: string; a: string; stage: string; amount: number; created: string; closed?: string; addOn?: string }
const DEALS: DealRow[] = [
  { id: 'D-1001', a: 'wrenfield', stage: 'closed_won', amount: 180000, created: '2025-10-06', closed: '2025-12-12' },
  { id: 'D-1002', a: 'brookmere', stage: 'closed_lost', amount: 150000, created: '2025-11-17', closed: '2026-02-27' },
  { id: 'D-1003', a: 'tallowmere', stage: 'closed_won', amount: 140000, created: '2026-01-12', closed: '2026-03-20' },
  { id: 'D-1004', a: 'quillhaven', stage: 'closed_won', amount: 95000, created: '2026-02-02', closed: '2026-04-17' },
  { id: 'D-1005', a: 'ravensmoor', stage: 'closed_lost', amount: 125000, created: '2026-02-16', closed: '2026-04-30' },
  { id: 'D-1006', a: 'thistledown', stage: 'closed_lost', amount: 75000, created: '2026-03-02', closed: '2026-05-14' },
  { id: 'D-1007', a: 'copperleaf', stage: 'closed_won', amount: 72000, created: '2026-03-09', closed: '2026-05-22' },
  { id: 'D-1008', a: 'brindlewood', stage: 'closed_won', amount: 210000, created: '2026-03-23', closed: '2026-06-26' },
  { id: 'D-1009', a: 'sparrowgate', stage: 'closed_won', amount: 120000, created: '2026-04-06', closed: '2026-06-05' },
  { id: 'D-1010', a: 'lumenfold', stage: 'closed_won', amount: 88000, created: '2026-04-20', closed: '2026-07-10' },
  { id: 'D-1011', a: 'fennick', stage: 'closed_won', amount: 64000, created: '2026-05-11', closed: '2026-07-24' },
  { id: 'D-1012', a: 'alderfinch', stage: 'closed_lost', amount: 58000, created: '2026-05-26', closed: '2026-08-07' },
  { id: 'D-1013', a: 'copperleaf', stage: 'closed_won', amount: 36000, created: '2026-07-06', closed: '2026-08-28' }, // more seats
  { id: 'D-1014', a: 'sparrowgate', stage: 'closed_lost', amount: 55000, created: '2026-08-03', closed: '2026-09-18' }, // higher API tier
  { id: 'D-1015', a: 'thistledown', stage: 'proposal', amount: 78000, created: '2026-08-24' },
  { id: 'D-1016', a: 'wrenfield', stage: 'closed_won', amount: 45000, created: '2026-09-08', closed: '2026-10-16', addOn: 'provider_quality_data' },
  { id: 'D-1017', a: 'brookmere', stage: 'negotiation', amount: 165000, created: '2026-09-14' },
  { id: 'D-1018', a: 'quillhaven', stage: 'closed_lost', amount: 32000, created: '2026-09-21', closed: '2026-10-30', addOn: 'provider_quality_data' },
  { id: 'D-1019', a: 'lumenfold', stage: 'closed_won', amount: 42000, created: '2026-09-01', closed: '2026-10-23' }, // more API volume
  { id: 'D-1020', a: 'brindlewood', stage: 'negotiation', amount: 190000, created: '2026-09-29' }, // renewal
  { id: 'D-1021', a: 'ravensmoor', stage: 'qualified', amount: 130000, created: '2026-10-05' },
  { id: 'D-1022', a: 'tallowmere', stage: 'proposal', amount: 38000, created: '2026-10-12', addOn: 'provider_quality_data' },
];

// ---- generation -----------------------------------------------------------------------------------------------------------
/** mulberry32, seeded from a string. */
function rng(seed: string): () => number {
  let a = createHash('sha1').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uuidOf = (key: string): string => {
  const h = createHash('sha1').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const DAY = 86_400_000;
const isWeekday = (ms: number) => ![0, 6].includes(new Date(ms).getUTCDay());

/** n timestamps: the first on `from`, the last on `to`, the rest on weekdays between, at business hours in US time zones. */
function spread(n: number, from: string, to: string, rand: () => number): number[] {
  const start = Date.parse(from), end = Date.parse(to);
  const days: number[] = [start];
  for (let i = 1; i < n - 1; i++) {
    let d = start + Math.floor(rand() * ((end - start) / DAY + 1)) * DAY;
    while (!isWeekday(d)) d += DAY;
    days.push(Math.min(d, end));
  }
  if (n > 1) days.push(end);
  return days.sort((a, b) => a - b).map(d => d + (13 + Math.floor(rand() * 9)) * 3_600_000 + Math.floor(rand() * 60) * 60_000 + Math.floor(rand() * 60) * 1000);
}

const accountOf = (slug: string): CrmMirrorEntry => {
  const m = mirror.find(x => x.id === `mirror-${slug}`);
  if (!m) throw new Error(`no CRM mirror entry mirror-${slug}`);
  return m;
};

const EXTRA: Partial<Record<Feature, (rand: () => number) => Record<string, unknown>>> = {
  signal_search: r => ({ code: ['CPT 27447', 'CPT 29881', 'CPT 99214', 'CPT 70553', 'CPT 45378'][Math.floor(r() * 5)], market: ['GA', 'MI', 'OH', 'TX', 'UT', 'CA'][Math.floor(r() * 6)] }),
  api: r => ({ endpoint: ['/v1/rates', '/v1/providers', '/v1/markets'][Math.floor(r() * 3)] }),
  mcp: r => ({ tool: ['get_negotiated_rates', 'compare_markets', 'find_providers'][Math.floor(r() * 3)] }),
};

interface PostHogEvent { event: string; distinct_id: string | null; timestamp: string; uuid: string; properties: Record<string, unknown> }

function eventOf(key: string, name: string, who: string | null, group: string | null, at: number, extra: Record<string, unknown>): PostHogEvent {
  const timestamp = new Date(at).toISOString();
  return {
    event: name, distinct_id: who, timestamp, uuid: uuidOf(`${key}|${timestamp}`),
    properties: { ...(group ? { $groups: { company: group }, $group_0: group } : {}), ...extra, synthetic: true },
  };
}

function usageEvents(): PostHogEvent[] {
  const out: PostHogEvent[] = [];
  const accounts = new Set<string>();
  for (const u of USES) {
    accounts.add(u.a);
    const acct = accountOf(u.a);
    const domain = acct.domains[0];
    const rand = rng(`${u.a}|${u.f}`);
    const times = u.days ? u.days.map((d, i) => Date.parse(d) + (14 + (i % 6)) * 3_600_000 + ((i * 7) % 60) * 60_000) : spread(u.n as number, u.from as string, u.to as string, rand);
    const people = (u.who ?? PEOPLE[u.a].map((_, i) => i)).map(i => `${PEOPLE[u.a][i]}@${domain}`);
    const first = launch.get(u.f);
    times.forEach((t, i) => {
      if (first && t < Date.parse(first)) throw new Error(`${u.a} ${u.f}: an event on ${new Date(t).toISOString()} is before the feature launched on ${first}`);
      out.push(eventOf(`${u.a}|${u.f}|${i}`, primaryEvent(u.f), people[Math.floor(rand() * people.length)], domain, t, EXTRA[u.f]?.(rand) ?? {}));
    });
  }
  // events the project does not map, spread over the accounts that have usage
  for (const slug of accounts) {
    const domain = accountOf(slug).domains[0];
    for (const noise of NOISE) {
      const rand = rng(`${slug}|${noise.name}`);
      spread(noise.per + (slug.length % 3), '2026-06-01', '2026-11-04', rand).forEach((t, i) => {
        out.push(eventOf(`${slug}|${noise.name}|${i}`, noise.name, `${PEOPLE[slug][i % PEOPLE[slug].length]}@${domain}`, domain, t, noise.name === '$pageview' ? { $current_url: '/app/signal' } : { rows: 100 + i * 25 }));
      });
    }
  }
  STRANGERS.forEach((s, i) => out.push(eventOf(`stranger|${i}`, primaryEvent(s.f), 'visitor@unlisted-clinic.example', s.group, Date.parse(s.at), {})));
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.uuid.localeCompare(b.uuid));
}

const dealJson = (d: DealRow) => ({
  id: d.id, accountKey: `crm:${accountOf(d.a).id}`, stage: d.stage, amount: d.amount, createdAt: d.created, closedAt: d.closed ?? null, addOn: d.addOn ?? null, synthetic: true,
});

const events = usageEvents();
const lines = (rows: unknown[]) => rows.map(r => '    ' + JSON.stringify(r)).join(',\n');
writeFileSync(join(DIR, 'events.json'), `{\n  "synthetic": true,\n  "batch": [\n${lines(events)}\n  ]\n}\n`);
writeFileSync(join(DIR, 'deals.json'), `[\n${DEALS.map(d => '  ' + JSON.stringify(dealJson(d))).join(',\n')}\n]\n`);
console.log(`wrote ${events.length} events and ${DEALS.length} deals for ${new Set(USES.map(u => u.a)).size} accounts to fixtures/usage/`);
