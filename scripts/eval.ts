// npm run eval: rules vs model vs combined v1, v2, v3 and v4 (v4 is what the pipeline runs), on up to three sets.
//   dev      the 40 fixtures (classifier fields, plus segment and routing from the full pipeline). The rules were written alongside these messages.
//   heldout  fixtures/heldout.json: 24 items written after the rules were frozen. Round 3 used its misses to develop the date parser, so it is a development set now.
//   sealed   fixtures/heldout-sealed.json, loaded only if it exists: same shape as heldout, written after the round-3 parser was frozen.
// Writes out/eval.json (the cockpit reads it), out/eval.md and out/eval-manifest.json (hashes of the sealed set and every classifier source file).
// The numbers are whatever they are.
// The dev replay runs with the model before every free-text route (MODEL_BEFORE_ROUTE=all), so the classifier is scored on its
// full answer whatever the pipeline's gate does. The fast-path section then counts, on every labelled set, the items the gated
// pipeline (decision 19) would route on different classifier inputs, because their model answer would arrive after the alert.
//   npm run eval:gate:rules (--gate --rules-only, LLM_PROVIDER=rules) is the same gate with no model in the loop: deterministic, so it runs in CI against
//                       RULES_FLOORS (the measured results, no slack). It writes eval-rules.json, eval-rules.md and eval-rules-manifest.json, never the model run's files.
//   npm run eval:gate   (--gate) runs the same evaluation, then exits 1 if the v4 combiner on the sealed or held-out set is below the floors in
//                       scripts/lib/eval-gate.ts, or if the local model could not be reached. It never passes by skipping.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, makeConfig } from '../src/config';
import { COMBINED_HASH_METHOD, FLOORS, RULES_FLOORS, classifierFiles, combinedHash, compareClassifier, evaluateGate, gatePreflight, rulesGatePreflight, gateTable, infraFailures, mtimeIso, ollamaTemperature, sha256File, type SetCounts } from './lib/eval-gate';
import { createCtx, type Ctx } from '../src/context';
import { NO_OUTSIDE_WRITES } from './lib/outside-writes';
import { normalizeEvent } from '../src/normalize';
import { buildPayload } from '../src/payloads';
import { compareSecondOpinion, type OpinionField } from '../src/decisions';
import { fastPathOf } from '../src/modelPath';
import { COMBINE_VERSION, combine } from '../src/qualify/combine';
import { warmOllama, type LlmOutcome } from '../src/qualify/llm';
import { PROMPT_VERSION } from '../src/qualify/prompt';
import { qualify } from '../src/qualify';
import { classifyRules } from '../src/qualify/rules';
import { parse as parseWhen, urgencyFromWhen } from '../src/qualify/when';
import { registryLookups } from '../src/resolve/domain';
import { runReplay } from '../src/replay';
import type { Classification, Qualification, Resolution, Segment, Source } from '../src/schema';
import { adapt } from '../src/sources';
import { leadDetail } from '../src/view';

const gold: Record<string, any> = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'gold-labels.json'), 'utf8'));
type ItemSet = { receivedAt: string; items: any[] };
const heldout = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'heldout.json'), 'utf8')) as ItemSet;
const sealedPath = join(ROOT, 'fixtures', 'heldout-sealed.json');
const sealed: ItemSet | null = existsSync(sealedPath) ? JSON.parse(readFileSync(sealedPath, 'utf8')) : null;
const OUT = makeConfig().outDir; // ROOT/out unless OUT_DIR is set
const scratch = join(OUT, '_eval');

const GATE = process.argv.includes('--gate');
// --rules-only: no model anywhere; own file names so a rules run can never replace the cockpit's eval.json or the model gate's manifest.
const RULES_ONLY = process.argv.includes('--rules-only');
const FILES = RULES_ONLY ? { json: 'eval-rules.json', md: 'eval-rules.md', manifest: 'eval-rules-manifest.json' } : { json: 'eval.json', md: 'eval.md', manifest: 'eval-manifest.json' };
const GATE_FLOORS = RULES_ONLY ? RULES_FLOORS : FLOORS;
// The dev replay posts the Calendly fixtures through the real handler, which refuses unsigned traffic; sign with a key that lives only in this process.
// The eval runs synthetic items through the real pipeline: it never writes to HubSpot, whatever .env says.
const ctx = createCtx({ appDb: ':memory:', outDir: scratch, calendlyKey: 'eval-in-process-signing-key', modelBeforeRoute: 'all', ...NO_OUTSIDE_WRITES });
const modelReachable = ctx.cfg.llmProvider === 'ollama' && await warmOllama(ctx);
if (RULES_ONLY) {
  const problems = rulesGatePreflight({ provider: ctx.cfg.llmProvider, sealedExists: !!sealed });
  if (problems.length) { console.error(`EVAL GATE (rules only): FAIL (not run)\n${problems.map(p => `  - ${p}`).join('\n')}`); rmSync(scratch, { recursive: true, force: true }); process.exit(1); }
} else if (GATE) {
  const problems = gatePreflight({ provider: ctx.cfg.llmProvider, modelReachable, sealedExists: !!sealed, model: ctx.cfg.ollamaModel, ollamaUrl: ctx.cfg.ollamaUrl });
  if (problems.length) { console.error(`EVAL GATE: FAIL (not run)\n${problems.map(p => `  - ${p}`).join('\n')}`); rmSync(scratch, { recursive: true, force: true }); process.exit(1); }
} else if (!modelReachable && ctx.cfg.llmProvider === 'ollama') console.log('ollama unavailable: the model column will be empty');

const CLS = ['useCase', 'urgency', 'disqualifier'] as const;
type Variant = 'rules' | 'llm' | 'v1' | 'v2' | 'v3' | 'v4';
const VARIANTS: Variant[] = ['rules', 'llm', 'v1', 'v2', 'v3', 'v4'];
interface Tally { n: number; ok: number }
const tally = () => ({ n: 0, ok: 0 });
const frac = (t: Tally) => (t.n ? Math.round((t.ok / t.n) * 1000) / 1000 : null);
const counts = (t: Tally) => `${t.ok}/${t.n}`;
const pctile = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };

interface Row { id: string; source: string; q: Qualification; gold: any; message?: string | null; receivedAt?: string; resolution?: Resolution; route?: any; extra?: Record<string, unknown> }
interface Miss { set: string; fixtureId: string; field: string; expected: unknown; got: unknown; source: string; reasons: string; modelGot?: unknown; v1Got?: unknown; v2Got?: unknown; v3Got?: unknown; rulesGot?: unknown }
interface LabelQuestion { fixtureId: string; expected: string; parserAnswer: string; kind: string; cue: string | null; date: string | null; days: number | null; message: string }

/** Why urgency came out as it did: the parser's cue and date, or the model/door default. */
function urgencyWhy(r: Row): string {
  const e = r.q.rules.evidence;
  if (e?.urgencyParsed) return `parser (${e.urgencyKind}): "${e.urgencyCue}"${e.urgencyDate ? ` -> ${e.urgencyDate}, ${e.urgencyDays} days` : ''}`;
  return 'no timing language in the message, so unknown (or the door default when there is no free text)';
}

const llmLatencies: number[] = [];
const rulesMs: number[] = [];

/** Older policies, rebuilt from what the pipeline stored: same rules output, same model output. */
function policyOf(q: Qualification, version: 'v1' | 'v2' | 'v3' | 'v4'): Classification {
  const outcome: LlmOutcome | null = q.llm ? { ok: true, value: q.llm, latencyMs: q.latencyMs, provider: q.provider } : null;
  return combine(q.rules, outcome, q.fallbackReason, q.provider, version).final;
}

function scoreSet(name: string, rows: Row[], note: string, extraFields: boolean) {
  const t: Record<string, Record<Variant, Tally>> = Object.fromEntries(CLS.map(f => [f, Object.fromEntries(VARIANTS.map(v => [v, tally()])) as Record<Variant, Tally>]));
  const other: Record<string, Tally> = { segment: tally(), routeTeam: tally(), routeAction: tally(), routeOwner: tally() };
  const misses: Miss[] = [];
  for (const r of rows) {
    const v1 = policyOf(r.q, 'v1'), v2 = policyOf(r.q, 'v2'), v3 = policyOf(r.q, 'v3');
    for (const f of CLS) {
      const g = r.gold[f]; if (g === undefined) continue;
      const got: Record<Variant, unknown> = { rules: r.q.rules[f], llm: r.q.llm?.[f], v1: v1[f], v2: v2[f], v3: v3[f], v4: r.q.final[f] };
      for (const v of VARIANTS) { if (v === 'llm' && !r.q.llm) continue; t[f][v].n++; if (got[v] === g) t[f][v].ok++; }
      if (got.v4 !== g) misses.push({ set: name, fixtureId: r.id, field: f, expected: g, got: got.v4, source: r.source, reasons: f === 'urgency' ? urgencyWhy(r) : r.q.final.reasons, modelGot: got.llm ?? null, v1Got: got.v1, v2Got: got.v2, v3Got: got.v3, rulesGot: got.rules });
    }
    if (extraFields) {
      const gr = r.gold.route ?? {};
      const chk = (k: string, expected: unknown, got: unknown, why: string) => {
        if (expected === undefined) return;
        other[k].n++; if (got === expected) other[k].ok++;
        else misses.push({ set: name, fixtureId: r.id, field: k, expected, got, source: r.source, reasons: why });
      };
      chk('segment', r.gold.segment, r.resolution?.segment, (r.resolution?.evidence ?? []).map(e => `${e.step}: ${e.detail}`).join(' | ').slice(0, 300));
      chk('routeTeam', gr.team, r.route?.team, r.route?.reason ?? '');
      chk('routeAction', gr.action, r.route?.action, r.route?.reason ?? '');
      chk('routeOwner', gr.owner ?? (gr.ownerSameAs ? r.extra?.[`owner:${gr.ownerSameAs}`] : undefined), r.route?.owner, r.route?.reason ?? '');
    }
  }
  const fields: Record<string, any> = {};
  for (const f of CLS) fields[f] = { ...Object.fromEntries(VARIANTS.map(v => [v, frac(t[f][v])])), final: frac(t[f].v4), finalOk: t[f].v4.ok, finalN: t[f].v4.n, counts: { ...Object.fromEntries(VARIANTS.map(v => [v, counts(t[f][v])])), final: counts(t[f].v4) } };
  if (extraFields) for (const k of ['segment', 'routeTeam', 'routeAction', 'routeOwner']) fields[k] = { final: frac(other[k]), counts: { final: counts(other[k]) } };
  // Items where the parser had something to say and the gold label disagrees. Reported for a person to rule on; golds are never edited.
  const labelQuestions: LabelQuestion[] = [];
  for (const r of rows) {
    const g = r.gold.urgency; if (g === undefined || r.message == null || !r.receivedAt) continue;
    const w = parseWhen(r.message, r.receivedAt), ans = urgencyFromWhen(w);
    if (w.kind !== 'none' && ans !== g) labelQuestions.push({ fixtureId: r.id, expected: g, parserAnswer: ans!, kind: w.kind, cue: w.cue, date: w.date, days: w.horizonDays, message: r.message });
  }
  return { set: { name, n: rows.length, note, fields, labelQuestions }, misses };
}

// ---------------- dev: the full pipeline over the 40 fixtures
const results = await runReplay(ctx, { wait: true, keepOut: true });
const byId: Record<string, any> = {};
for (const r of results) byId[r.fixture.id] = { ...r, detail: r.leadId && !r.duplicate ? leadDetail(ctx, r.leadId) : null };
const devRows: Row[] = [];
const idempotency: { fixture: string; ok: boolean }[] = [];
for (const [id, g] of Object.entries(gold)) {
  if (g.noop) { idempotency.push({ fixture: id, ok: !!byId[id]?.duplicate }); continue; }
  const d = byId[id]?.detail; if (!d) continue;
  const q: Qualification = d.qualification;
  const hasFreeText = !q.fallbackReason?.startsWith('no_free_text');
  if (hasFreeText && q.latencyMs > 0) llmLatencies.push(q.latencyMs);
  const ev = adapt(d.source, d.raw, d.receivedAt); ev.receivedAt = d.receivedAt;
  const n = normalizeEvent(ev, registryLookups(ctx.db));
  const t0 = performance.now(); for (let i = 0; i < 20; i++) classifyRules({ ev, n, res: d.resolution }); rulesMs.push((performance.now() - t0) / 20);
  const ownerRef = g.route?.ownerSameAs ? { [`owner:${g.route.ownerSameAs}`]: byId[g.route.ownerSameAs]?.detail?.route?.owner } : {};
  devRows.push({ id, source: d.source, q, gold: g, resolution: d.resolution, route: d.route, extra: ownerRef, message: d.normalized?.message ?? null, receivedAt: d.receivedAt });
}
const dev = scoreSet('dev', devRows, 'rules were written alongside these messages', true);

// ---------------- item sets: the same qualify() the pipeline calls, one item at a time
async function runItems(set: ItemSet): Promise<Row[]> {
  const rows: Row[] = [];
  for (const it of set.items) {
    const source = it.source as Source;
    const payload = buildPayload(source, {
      first: 'Held', last: it.id, email: `${String(it.id).toLowerCase()}@heldout.example.org`, title: it.title || undefined, company: 'Held-out Co', message: it.message,
      ts: set.receivedAt, usage: [], notes: it.message, seed: it.id,
    });
    const ev = adapt(source, payload);
    const n = normalizeEvent(ev, registryLookups(ctx.db));
    const res: Resolution = { status: 'resolved', accountId: null, accountName: null, segment: it.segment as Segment, subsegment: null, confidence: 'high', method: 'org_domain', matchScore: null, evidence: [], firmographics: {}, candidates: [], inferred: false };
    const q = await qualify(ctx, ev, n, res);
    if (q.llm || q.latencyMs > 0) llmLatencies.push(q.latencyMs);
    rows.push({ id: it.id, source, q, gold: it.gold, message: n.message, receivedAt: set.receivedAt });
  }
  return rows;
}
const hoRows = await runItems(heldout);
const ho = scoreSet('heldout', hoRows, 'written after the rules were frozen; used to develop the round-3 date parser', false);
const sealedRows = sealed ? await runItems(sealed) : [];
const sealedResult = sealed ? scoreSet('sealed', sealedRows, 'sealed until the round-3 parser was frozen', false) : null;

const sets = [dev.set, ho.set, ...(sealedResult ? [sealedResult.set] : [])];

// ---------------- fast path: what the gated pipeline would route on, against the full combine scored above
/** Classifier outputs the route reads: the use case (the team), the disqualifier (R1, R4, tier X) and a person's review (R5, R6). */
const ROUTE_INPUTS: readonly OpinionField[] = ['useCase', 'disqualifier', 'reviewReason'];
/** Rules that decide before any classifier field is read, so a different input cannot change them. */
const DECIDED_FIRST = ['R1', 'R2', 'R3', 'R9'];
function fastPathSet(name: string, rows: Row[]) {
  const items = rows.map(r => {
    const fast = fastPathOf(r.q);
    const fields = compareSecondOpinion(fast, r.q).changed.filter(f => ROUTE_INPUTS.includes(f));
    // dev rows carry the route the full combine produced; the item sets have no earlier rule that could decide first
    const decidedFirst = !!r.route && DECIDED_FIRST.includes(r.route.rule);
    return { id: r.id, afterAlert: fast !== r.q, fields, routesDifferently: fields.length > 0 && !decidedFirst };
  });
  const differ = items.filter(i => i.routesDifferently);
  return {
    name, n: rows.length,
    waitedForModel: rows.filter(r => !r.q.fallbackReason?.startsWith('no_free_text') && r.q.provider !== 'rules').length - items.filter(i => i.afterAlert).length,
    afterAlert: items.filter(i => i.afterAlert).length,
    routesDifferently: differ.length,
    items: differ.map(i => ({ id: i.id, fields: i.fields })),
  };
}
const fastPath = [fastPathSet('dev', devRows), fastPathSet('heldout', hoRows), ...(sealed ? [fastPathSet('sealed', sealedRows)] : [])];
const misses = [...dev.misses, ...ho.misses, ...(sealedResult?.misses ?? [])];
const latency = { p50: pctile(llmLatencies, 50), p90: pctile(llmLatencies, 90) };
const out = {
  generatedAt: new Date().toISOString(), model: ctx.cfg.ollamaModel, promptVersion: PROMPT_VERSION, combineVersion: COMBINE_VERSION,
  latencyMs: latency, registry: ctx.registry.kind,
  rulesLatencyMs: { p50: +(pctile(rulesMs, 50) ?? 0).toFixed(3), p90: +(pctile(rulesMs, 90) ?? 0).toFixed(3) },
  modelCalls: llmLatencies.length, idempotency,
  note: 'accuracies are fractions 0-1; final is combine v4 (the pipeline); llm is counted only on leads where the model answered; rules is the round-2 keyword classifier; v1: a confident model overrides the rules; v2: rules first with keyword urgency cues; v3: v2 with the date parser deciding urgency and the model asked when the parser finds nothing; v4: the parser decides urgency and the model never does (no timing language means unknown)',
  sets, misses,
  fastPath: { note: 'decision 19: items the gated pipeline would route on different classifier inputs (use case, disqualifier, review) than the full combine, because the model answer that changes them arrives after the alert; dev excludes items an earlier rule (R1, R2, R3, R9) decides first', sets: fastPath },
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, FILES.json), JSON.stringify(out, null, 2));

// ---------------- freeze manifest: what exactly was evaluated, against which sealed file, by which classifier code
const manifestPath = join(OUT, FILES.manifest);
let previousManifest: any = null;
try { previousManifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* first run, or unreadable: nothing to compare with */ }
const cFiles = classifierFiles(ROOT);
const cHash = combinedHash(cFiles);
const sealedSha = sealed ? sha256File(sealedPath) : null;
const inputPathFiles = ['src/normalize.ts', 'src/payloads.ts', ...readdirSync(join(ROOT, 'src', 'sources')).filter(f => f.endsWith('.ts')).map(f => `src/sources/${f}`)]
  .map(path => ({ path, sha256: sha256File(join(ROOT, path)) }));
const comparison = compareClassifier(cHash, previousManifest?.classifier?.combinedSha256);
const sealedComparison = !previousManifest?.sealedSet?.sha256 || !sealedSha ? null : previousManifest.sealedSet.sha256 === sealedSha ? 'sealed set file unchanged since the recorded run' : 'sealed set file CHANGED since the recorded run';
const setCounts: SetCounts[] = sets.map(x => ({ name: x.name, n: x.n, v4: Object.fromEntries(CLS.map(f => [f, { ok: x.fields[f].finalOk, n: x.fields[f].finalN }])) as SetCounts['v4'] }));
const gateResult = evaluateGate(setCounts, GATE_FLOORS);
const infra = { heldout: infraFailures(hoRows.map(r => r.q.fallbackReason)), sealed: infraFailures(sealedRows.map(r => r.q.fallbackReason)) };
const modelAnswered = { heldout: `${hoRows.filter(r => r.q.llm).length}/${hoRows.length}`, sealed: `${sealedRows.filter(r => r.q.llm).length}/${sealedRows.length}` };
const gatePass = gateResult.pass && infra.heldout === 0 && infra.sealed === 0 && (RULES_ONLY ? ctx.cfg.llmProvider === 'rules' : modelReachable);
const llmSource = readFileSync(join(ROOT, 'src', 'qualify', 'llm.ts'), 'utf8');
const sealedMtime = sealed ? mtimeIso(sealedPath) : null;
const classifierMtimes = cFiles.map(f => ({ path: f.path, modified: mtimeIso(join(ROOT, f.path)) }));
const newestClassifier = classifierMtimes.reduce((a, b) => (b.modified > a.modified ? b : a));
const manifest = {
  schema: 'eval-manifest/1',
  evalTimestamp: out.generatedAt,
  mode: RULES_ONLY ? (GATE ? 'rules-gate' : 'rules') : GATE ? 'gate' : 'eval',
  model: { name: ctx.cfg.ollamaModel, temperature: ollamaTemperature(llmSource), temperatureSource: 'literal in the Ollama call in src/qualify/llm.ts (there is no temperature key in config)', provider: ctx.cfg.llmProvider, ollamaUrl: ctx.cfg.ollamaUrl, promptVersion: PROMPT_VERSION, combineVersion: COMBINE_VERSION },
  sealedSet: sealed ? { path: 'fixtures/heldout-sealed.json', sha256: sealedSha, items: sealed.items.length, receivedAt: sealed.receivedAt } : null,
  classifier: { files: cFiles, combinedSha256: cHash, combinedMethod: COMBINED_HASH_METHOD, scope: 'everything under src/qualify plus the transitive runtime (non type-only) local imports of those files' },
  inputPathFiles: { note: 'files that shape the classifier input (payload build, adapters, normalization); hashed for the record, NOT part of the combined classifier hash', files: inputPathFiles },
  otherFixtures: Object.fromEntries(['heldout.json', 'gold-labels.json'].map(f => [`fixtures/${f}`, sha256File(join(ROOT, 'fixtures', f))])),
  comparisonWithPreviousRun: { classifier: comparison.message, sealedSet: sealedComparison, previousEvalTimestamp: previousManifest?.evalTimestamp ?? null },
  previousRun: previousManifest ? { evalTimestamp: previousManifest.evalTimestamp, mode: previousManifest.mode ?? null, classifierCombinedSha256: previousManifest.classifier?.combinedSha256 ?? null, sealedSha256: previousManifest.sealedSet?.sha256 ?? null } : null,
  results: sets.map(x => ({ name: x.name, n: x.n, fields: x.fields })),
  modelAnswered, modelInfrastructureFailures: infra,
  gate: GATE ? { floors: GATE_FLOORS, rows: gateResult.rows, pass: gatePass } : null,
  supportingEvidence: {
    label: 'SUPPORTING EVIDENCE ONLY: file modification times. They can be changed by copying, restoring or touching a file, so they do not prove when anything was written. The hashes above are the record from this run forward.',
    sealedSetModified: sealedMtime,
    newestClassifierFile: newestClassifier,
    classifierFilesModified: classifierMtimes,
  },
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const provenance: string[] = [
  `## Provenance`, ``,
  `- Evaluated ${out.generatedAt}. ${RULES_ONLY ? 'No model (rules only)' : `Model \`${ctx.cfg.ollamaModel}\`, temperature ${manifest.model.temperature} (a literal in \`src/qualify/llm.ts\`)`}, prompt ${PROMPT_VERSION}, combine ${COMBINE_VERSION}.`,
  `- Sealed set: \`fixtures/heldout-sealed.json\`, ${sealed ? `${sealed.items.length} items, sha256 \`${sealedSha}\`` : 'not present'}.`,
  `- Classifier: ${cFiles.length} source files (${cFiles.map(f => f.path.replace(/^src\//, '')).join(', ')}); combined sha256 \`${cHash}\`. Per-file hashes are in ${RULES_ONLY ? `\`${FILES.manifest}\` next to this file` : '`out/eval-manifest.json`'}.`,
  `- Against the previous recorded run: ${comparison.message}${sealedComparison ? `; ${sealedComparison}` : ''}.`,
  `- Supporting evidence only (file modification times, which copying or touching changes): sealed set ${sealedMtime ?? 'n/a'}; newest classifier file ${newestClassifier.modified} (${newestClassifier.path}).`,
  `- What this shows: from this record on, any edit to the sealed file or the classifier code is detectable by hash. It does not show when the sealed set was written relative to the classifier; that rests on the set's own note and the file times above.`, ``,
];
if (GATE) provenance.push(`## Gate (v4, ${RULES_ONLY ? 'rules only, floors are the measured results with no slack' : 'floors allow one regression per field'})`, ``, '```', gateTable(gateResult.rows), '```', ``, `${RULES_ONLY ? 'No model was called (rules only).' : `Model answered: held-out ${modelAnswered.heldout}, sealed ${modelAnswered.sealed}; model calls that failed on infrastructure (unreachable or timed out): held-out ${infra.heldout}, sealed ${infra.sealed}.`} Gate: **${gatePass ? 'PASS' : 'FAIL'}**.`, ``);

const pct = (x: number | null | undefined) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
const cell = (f: any, v: string) => (f[v] == null ? 'n/a' : `${f.counts[v]} (${pct(f[v])})`);
const md: string[] = [
  `# Qualification eval${RULES_ONLY ? ' (rules only, no model)' : ''}`, ``, ...provenance,
  `Generated ${out.generatedAt}. Registry: **${out.registry}**. Model: ${RULES_ONLY ? 'none (rules only)' : `\`${out.model}\` at temperature 0`}, prompt ${PROMPT_VERSION}. Pipeline combine policy: **${COMBINE_VERSION}**.`, ``,
  `- **rules**: the keyword classifier, run on every lead.`,
  `- **model**: the local model alone, counted only where it answered (leads with free text).`,
  `- **v1**: a confident model overrides the rules.`,
  `- **v2**: rules first, the model fills gaps; urgency from keyword cues.`,
  `- **v3**: as v2, but the date parser (\`src/qualify/when.ts\`) decides urgency; the model is asked when the parser finds nothing.`,
  `- **v4**: the parser decides urgency and the model never does; no timing language means unknown. This is what the pipeline runs, and v4 urgency equals the old "parser only" counterfactual, which is no longer reported separately.`, ``,
];
for (const s of sets) {
  md.push(`## ${s.name} (${s.n} items)`, ``, `_${s.note}._`, ``, `| field | rules | model | v1 | v2 | v3 | v4 |`, `|---|---|---|---|---|---|---|`);
  for (const f of CLS) md.push(`| ${f} | ${cell(s.fields[f], 'rules')} | ${cell(s.fields[f], 'llm')} | ${cell(s.fields[f], 'v1')} | ${cell(s.fields[f], 'v2')} | ${cell(s.fields[f], 'v3')} | ${cell(s.fields[f], 'v4')} |`);
  for (const k of ['segment', 'routeTeam', 'routeAction', 'routeOwner']) if (s.fields[k]) md.push(`| ${k} | | | | | | ${s.fields[k].counts.final} (${pct(s.fields[k].final)}) |`);
  md.push(``);
  if (s.labelQuestions.length) {
    md.push(`Label questions (the parser gave an answer from the written definition and the gold label disagrees; golds are not edited):`, ``, `| id | gold | parser | cue | date | days | message |`, `|---|---|---|---|---|---|---|`);
    for (const q of s.labelQuestions) md.push(`| ${q.fixtureId} | ${q.expected} | ${q.parserAnswer} | ${q.cue ?? ''} | ${q.date ?? ''} | ${q.days ?? ''} | ${q.message.replace(/\|/g, '/').slice(0, 120)} |`);
    md.push(``);
  }
}
md.push(`Idempotent re-delivery (F27) creates no new lead: ${idempotency.every(i => i.ok) ? 'yes' : 'NO'}.`, ``,
  `## Latency`, ``, `- rules: p50 ${out.rulesLatencyMs.p50} ms, p90 ${out.rulesLatencyMs.p90} ms per lead`, `- model: ${out.modelCalls} calls, p50 ${latency.p50} ms, p90 ${latency.p90} ms`, ``,
  `## Fast path (decision 19)`, ``,
  `Items the gated pipeline would route on different classifier inputs than the full combine above, because the model's answer that changes them would arrive after the alert. Use case never differs: a lead whose use case the model can change waits for it. ${RULES_ONLY ? 'With no model, nothing waits and nothing differs.' : ''}`, ``,
  `| set | items | waited for the model | model after the alert | routed differently | which |`, `|---|---|---|---|---|---|`,
  ...fastPath.map(f => `| ${f.name} | ${f.n} | ${f.waitedForModel} | ${f.afterAlert} | ${f.routesDifferently} | ${f.items.map(i => `${i.id} (${i.fields.join(', ')})`).join('; ')} |`), ``,
  `## Misses (v4 result; ${misses.length})`, ``, `| set | id | field | expected | got | rules | model | reasons |`, `|---|---|---|---|---|---|---|---|`,
  ...misses.map(m => `| ${m.set} | ${m.fixtureId} | ${m.field} | ${m.expected} | ${m.got} | ${m.rulesGot ?? ''} | ${m.modelGot ?? ''} | ${String(m.reasons).replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 200)} |`), ``,
  `Not evaluated: the score tier (it comes out of the points table, not a label) and fields the dev gold table leaves blank. The model sees guide-only, badge-only and usage-only dev leads never; those are decided by rules alone.`, ``);
writeFileSync(join(OUT, FILES.md), md.join('\n'));
rmSync(scratch, { recursive: true, force: true });
console.log(md.join('\n'));
if (GATE) {
  console.log(`\nEVAL GATE (combine ${COMBINE_VERSION}${RULES_ONLY ? ', rules only' : ''}, floor versus actual)\n${gateTable(gateResult.rows)}`);
  if (!RULES_ONLY) console.log(`model answered: held-out ${modelAnswered.heldout}, sealed ${modelAnswered.sealed}; infrastructure failures: held-out ${infra.heldout}, sealed ${infra.sealed}`);
  console.log(`${comparison.message}${sealedComparison ? `; ${sealedComparison}` : ''}`);
  console.log(`fast path (decision 19), items routed on different classifier inputs: ${fastPath.map(f => `${f.name} ${f.routesDifferently}/${f.n}`).join(', ')}`);
  for (const r of gateResult.rows.filter(r => !r.pass)) console.log(`  FAIL ${r.set} ${r.field}: ${r.why}`);
  if (infra.heldout || infra.sealed) console.log('  FAIL some model calls on a gated set failed on infrastructure (unreachable or timed out), so those items were decided without the model');
  console.log(`EVAL GATE${RULES_ONLY ? ' (rules only)' : ''}: ${gatePass ? 'PASS' : 'FAIL'}`);
}
process.exit(GATE && !gatePass ? 1 : 0);
