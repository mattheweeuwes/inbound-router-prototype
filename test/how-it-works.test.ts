// How it works stays true (decision 34). Every figure and named setting on the tab, in the drawing, the three cards and
// the click-to-explain panels (public/how-model.js), is checked against the constant or the source it comes from, and a
// figure nobody checks fails the test, so the tab cannot drift from the code without CI saying so. Every box on the
// drawing has a panel, and every test a panel cites as its proof exists under that title.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import howApi from '../api/how';
import { allText, NODE_ORDER, TOPO } from '../public/how-model.js';
import { DEFAULT_COMMIT_GRACE_MS, makeConfig, ROOT } from '../src/config';
import { DEDUPE_DAYS } from '../src/decisions';
import { ENTERPRISE_DEFINITION } from '../src/enterprise';
import { PROBABLE_MIN_SCORE } from '../src/outbound/linkReview';
import { MIN_PATTERN_HITS } from '../src/outbound/patterns';
import { INBOUND_WINDOW_DAYS } from '../src/outbound/holds';
import { SYSTEM_GAP } from '../src/outbound/plays';
import { COMBINE_VERSION, LLM_DISQUALIFY_CONFIDENCE, LLM_MIN_CONFIDENCE } from '../src/qualify/combine';
import { REFERRAL_POINTS } from '../src/referral';
import { MATCH_MARGIN } from '../src/resolve/match';
import { registryCounts } from '../src/resolve/registry';
import { REPEAT_ALERT_QUIET_MS, SLA } from '../src/route';
import { SOURCES } from '../src/schema';
import { tierFor } from '../src/score';
import { EXPANSION_MIN_USES, EXPANSION_WINDOW_DAYS } from '../src/usage/expansion';
import { INFLUENCE_WINDOW_DAYS } from '../src/usage/attribution';
import { testCtx } from './helpers';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const HTML = read('public/index.html');
const SECTION = HTML.slice(HTML.indexOf('id="view-how"'), HTML.indexOf('</section>', HTML.indexOf('id="view-how"')));
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
/** What a reader sees: the drawing's labels, its description for a screen reader, the cards, and every panel. */
const PAGE = [
  decode(SECTION.replace(/<!--[\s\S]*?-->/g, ' ').replace(/aria-label="([^"]*)"/g, ' $1 ').replace(/<[^>]+>/g, ' ')),
  ...NODE_ORDER.flatMap(id => allText(TOPO[id])),
].join('\n').replace(/\s+/g, ' ');
const defaults = makeConfig({}, {});

/** The first argument of every AbortSignal.timeout() call in a source file, in milliseconds. */
const timeoutsIn = (rel: string) => [...read(rel).matchAll(/AbortSignal\.timeout\(([\d_]+)\)/g)].map(m => Number(m[1].replace(/_/g, '')));
const seconds = (ms: number) => ms / 1000;

/** A figure as the page words it, and the value the code has. Every match of the pattern must carry that value. */
interface Figure { what: string; pattern: RegExp; expected: number | number[] }

const FIGURES: Figure[] = [
  { what: 'doors', pattern: /\b(Eight) (?:sources|doors)\b/gi, expected: SOURCES.length },
  { what: 'model call timeout (Ollama, src/qualify/llm.ts)', pattern: /temperature 0, (?:output held to a JSON schema|JSON-schema output), (\d+) s timeout|the model times out \((\d+) s\)/gi, expected: seconds(timeoutsIn('src/qualify/llm.ts')[0]) },
  { what: 'registry lookup timeout (NPPES and homepage title)', pattern: /each with a (\d+) s timeout|lookup that times out \((\d+) s\)/g, expected: [...new Set([...timeoutsIn('src/resolve/nppes.ts'), ...timeoutsIn('src/resolve/siteTitle.ts')].map(seconds))] },
  { what: 'HubSpot call timeout', pattern: /Plain fetch, (\d+) s timeout per call/g, expected: [...new Set(timeoutsIn('src/crm/hubspot.ts').map(seconds))] },
  { what: 'model-only disqualifier confidence', pattern: /under (0\.\d+)|at (0\.\d+) (?:confidence )?or above|at (0\.\d+) or more/g, expected: LLM_DISQUALIFY_CONFIDENCE },
  { what: 'model use-case confidence', pattern: /the model at (0\.\d+) confidence/g, expected: LLM_MIN_CONFIDENCE },
  { what: 'tie margin', pattern: /within (0\.\d+) of each other/g, expected: MATCH_MARGIN },
  { what: 'R10 response time for tier B', pattern: /(\d+) for tier B|(\d+) minutes for tier B/g, expected: SLA.enterprise },
  { what: 'tier A response time', pattern: /(\d+) minutes for tier A|named rep \((\d+) minutes\)/g, expected: SLA.A },
  { what: 'review response time', pattern: /(\d+) business-minute SLA/g, expected: SLA.review },
  { what: 'list quiet period (LIST_QUIET_MS default)', pattern: /quiet for (\d+) s/g, expected: seconds(defaults.listQuietMs) },
  { what: 'HubSpot outbox attempts', pattern: /after (\d+) attempts/gi, expected: defaults.crmMaxAttempts },
  { what: 'lead retries (leadMaxAttempts less the first run)', pattern: /retried (twice), (?=after)/g, expected: defaults.leadMaxAttempts - 1 },
  { what: 'lead retry waits', pattern: /after (\d+) s and then (\d+) s/g, expected: [seconds(defaults.leadRetryDelayMs), seconds(defaults.leadRetryDelayMs * 2)] },
  { what: 'repeat-alert quiet window', pattern: /(?:inside|for) (\d+) hours/g, expected: REPEAT_ALERT_QUIET_MS / 3_600_000 },
  { what: 'sealed set size', pattern: /sealed set (?:of|is) (\d+)/g, expected: sealedSize() },
  { what: 'lookups at a time (PREPARE_CONCURRENCY default)', pattern: /prepare at once: (\d+) leads' lookups|(four) leads at a time/g, expected: defaults.prepareConcurrency },
  { what: 'commit grace (COMMIT_GRACE_MS default)', pattern: /grace of (\d+) ms/g, expected: DEFAULT_COMMIT_GRACE_MS },
  { what: 'dedupe and enterprise-note window', pattern: /(?:in the last|account in|went to sales in the last) (\d+) days/g, expected: DEDUPE_DAYS },
  { what: 'expansion rule', pattern: /at least (\d+) times in (\d+) days/g, expected: [EXPANSION_MIN_USES, EXPANSION_WINDOW_DAYS] },
  { what: 'referral points', pattern: /(\d+) (?:points )?from a customer, (\d+) from a known organization, (\d+) from words/g, expected: [REFERRAL_POINTS.customer, REFERRAL_POINTS.known_org, REFERRAL_POINTS.unknown_org] },
  { what: 'tier cut-offs', pattern: /A at (\d+) or more, B at (\d+), C at (\d+)/g, expected: [70, 50, 30] },
  { what: 'score scale', pattern: /score out of (\d+): fit up to (\d+) plus intent up to (\d+)/g, expected: [100, 50, 50] },
  { what: 'enterprise health system', pattern: /(\d+) or more hospitals or hospitals in (\d+) or more states/g, expected: [ENTERPRISE_DEFINITION.minHospitals, ENTERPRISE_DEFINITION.minStates] },
  { what: 'signature age', pattern: /more than (\d+) seconds old/g, expected: Number(/toleranceSec = (\d+)/.exec(read('src/sources/calendly.ts'))?.[1]) },
  { what: 'homepage title limits', pattern: /at most (\d+) KB read, at most (\d+) redirects/g, expected: [Number(/bytes < (\d+)/.exec(read('src/resolve/siteTitle.ts'))?.[1]) / 1024, Number(/MAX_REDIRECTS = (\d+)/.exec(read('src/resolve/siteTitle.ts'))?.[1])] },
  { what: 'system-gap play', pattern: /more than (\d+) clinicians, and is paid at least (\d+)% less/g, expected: [SYSTEM_GAP.minClinicians, SYSTEM_GAP.minGapPct] },
  { what: 'suppression window', pattern: /within (\d+) days\. Its status/g, expected: INBOUND_WINDOW_DAYS },
  { what: 'influence window', pattern: /in the (\d+) days before the deal/g, expected: INFLUENCE_WINDOW_DAYS },
  { what: 'probable link score', pattern: /scores (0\.\d+) or more/g, expected: PROBABLE_MIN_SCORE },
  { what: 'pattern minimum', pattern: /at least (\d+) distinct rates/g, expected: MIN_PATTERN_HITS },
  { what: 'combine version', pattern: /the guard rails, version (\d+)/g, expected: Number(COMBINE_VERSION.slice(1)) },
  { what: 'demo model', pattern: /Llama (\d+\.\d+) (\d+)B/g, expected: [3.2, 3] },
];

/** Numbers that are names, not settings: each with why it needs no constant. */
const NAMES: [RegExp, string][] = [
  [/\bR(?:10|[1-9])\b/g, 'rule ids, checked against src/route.ts below'],
  [/\b(?:200|202|401|429|503)\b|\b[45]xx\b/g, 'HTTP statuses the handlers answer (test/pipeline.test.ts, test/signed-doors.test.ts, test/crm-failure.test.ts)'],
  [/HMAC-SHA256|SHA-256|CRM v3|127\.0\.0\.1|Python 3\b/g, 'algorithm, API version, address and language names'],
  [/\b(?:DEMO_ROUTES|HUBSPOT_LIVE)=1\b/g, 'a switch named by its on value'],
];

function sealedSize(): number {
  const sealed = JSON.parse(read('fixtures/heldout-sealed.json')) as { items: unknown[] };
  return sealed.items.length;
}

const numberOf = (s: string) => (/^(?:eight|twice|four)$/i.test(s) ? { eight: 8, twice: 2, four: 4 }[s.toLowerCase()]! : Number(s));

describe('How it works: every figure is the code\'s', () => {
  for (const f of FIGURES) {
    it(f.what, () => {
      const found = [...PAGE.matchAll(f.pattern)];
      assert.ok(found.length > 0, `the page no longer states ${f.what} as ${f.pattern}; change the pattern with the words`);
      const expected = Array.isArray(f.expected) ? f.expected : [f.expected];
      for (const m of found) {
        const values = m.slice(1).filter((v): v is string => v !== undefined).map(numberOf);
        // a phrase with as many figures as the code gives states them all, in order; a one-figure phrase states the one value
        const want = values.length === expected.length ? expected : expected.length === 1 ? values.map(() => expected[0]) : expected;
        assert.deepEqual(values, want, `"${m[0]}" says ${values.join(', ')}; the code has ${expected.join(', ')}`);
      }
    });
  }

  it('states no figure the checks above do not cover', () => {
    let rest = PAGE;
    for (const f of FIGURES) rest = rest.replace(f.pattern, ' ');
    for (const [re] of NAMES) rest = rest.replace(re, ' ');
    // the registry counts are rendered from GET /api/how and checked on their own below
    rest = rest.replace(/[\d,]+ CMS hospitals|[\d,]+ AHRQ systems|[\d,]+ payers|[\d,]+ verified domains/g, ' ');
    const left = [...rest.matchAll(/.{0,40}\d.{0,40}/g)].map(m => m[0]);
    assert.deepEqual(left, [], 'a figure on How it works that nothing checks: add it to FIGURES with its constant, or reword it');
  });

  it('every rule id it names is a rule the router has', () => {
    const rules = new Set([...read('src/route.ts').matchAll(/rule: '(R\d+)'/g)].map(m => m[1]));
    rules.add('R7'); // R7 picks the team inside R8 and R10 (teamFor); it records no decision of its own
    for (const m of PAGE.matchAll(/\bR(\d+)\b/g)) assert.ok(rules.has(`R${m[1]}`), `R${m[1]} is not a rule in src/route.ts`);
  });
});

describe('How it works: the registry counts are the registry\'s', () => {
  const shown = Object.fromEntries([...SECTION.matchAll(/data-fact="(\w+)">([\d,]+)</g)].map(m => [m[1], Number(m[2].replace(/,/g, ''))]));

  it('GET /api/how serves the counts of the registry the server runs on, for every count the drawing shows', async () => {
    const ctx = testCtx();
    const body = (await (await howApi(new Request('http://local/api/how'), ctx)).json()) as { registry: Record<string, number | string> };
    const counts = registryCounts(ctx.db);
    assert.equal(body.registry.kind, 'mini');
    for (const key of Object.keys(shown)) assert.equal(body.registry[key], counts[key as keyof typeof counts], key);
    assert.deepEqual(Object.keys(shown).sort(), Object.keys(counts).sort(), 'the drawing shows each count the API serves');
    const mini = ctx.db.prepare(`SELECT COUNT(*) AS n FROM reg.cms_hospitals`).get() as { n: number };
    assert.equal(counts.hospitals, Number(mini.n));
  });

  const real = join(ROOT, 'data', 'registry.sqlite');
  it('the counts written in the page (shown with no server) are the real registry\'s', { skip: !existsSync(real) && 'the real registry is not built here' }, () => {
    const db = new DatabaseSync(real, { readOnly: true });
    try {
      const n = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
      assert.deepEqual(shown, { hospitals: n('cms_hospitals'), systems: n('ahrq_systems'), payers: n('payers'), verifiedDomains: n('org_domains') });
    } finally { db.close(); }
  });
});

describe('How it works: every box explains itself and names its proof', () => {
  const drawn = new Set([...SECTION.matchAll(/data-node="(\w+)"/g)].map(m => m[1]));

  it('every box on the drawing opens a panel, and every panel has a box', () => {
    assert.deepEqual([...drawn].sort(), [...NODE_ORDER].sort());
  });

  for (const id of NODE_ORDER) {
    it(`${id}: the tests it cites exist under those titles`, () => {
      const n = TOPO[id];
      assert.ok(n.tests.length > 0, `${id} names no test`);
      for (const [file, title] of n.tests) {
        assert.ok(existsSync(join(ROOT, file)), `${file} does not exist`);
        assert.ok(read(file).includes(title), `${file} has no test titled "${title}"`);
      }
    });
  }

  it('names every source file it points at', () => {
    for (const id of NODE_ORDER) {
      for (const part of TOPO[id].files.split('·')) {
        const path = part.trim().split(' ')[0];
        if (!/\.(ts|py|sql|json)$/.test(path) || path.includes('*')) continue;
        const dir = path.includes('/') ? '' : TOPO[id].files.split('·')[0].trim().replace(/[^/]+$/, '');
        assert.ok(existsSync(join(ROOT, dir + path)), `${id} names ${dir + path}, which does not exist`);
      }
    }
  });
});
