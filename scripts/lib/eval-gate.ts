// Pure helpers for the eval gate and the freeze manifest (used by scripts/eval.ts, tested in test/eval-gate.test.ts).
// Nothing here reads the model or changes a classifier decision.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const sha256File = (path: string) => sha256(readFileSync(path));

// ---------------------------------------------------------------- floors

export type GateField = 'urgency' | 'useCase' | 'disqualifier';
export const GATE_FIELDS: GateField[] = ['urgency', 'useCase', 'disqualifier'];
/** The sets the gate scores, each out of 24. Floors allow one regression per field from the recorded results (sealed 23/18/22, held-out 22/20/23). */
export const GATE_N = 24;
export const FLOORS: Record<'sealed' | 'heldout', Record<GateField, number>> = {
  sealed: { urgency: 22, useCase: 17, disqualifier: 21 },
  heldout: { urgency: 21, useCase: 19, disqualifier: 22 },
};

/**
 * Floors for the rules-only gate (`npm run eval:gate:rules`, `--rules-only`): the v4 pipeline with no model, which is deterministic, so these are
 * exactly the measured results with no slack. Any drop is a real regression in the rules or the date parser.
 * Measured 2026-11-08, two runs with identical results (combine v4, offline, real registry):
 * sealed 23/13/20 (urgency/use case/disqualifier), held-out 22/18/23, each out of 24. Raising a floor after a real improvement is a deliberate edit here.
 */
export const RULES_FLOORS: Record<'sealed' | 'heldout', Record<GateField, number>> = {
  sealed: { urgency: 23, useCase: 13, disqualifier: 20 },
  heldout: { urgency: 22, useCase: 18, disqualifier: 23 },
};

export interface SetCounts { name: string; n: number; v4: Record<GateField, { ok: number; n: number }> }
export interface GateRow { set: 'sealed' | 'heldout'; field: GateField; floor: number; ok: number | null; n: number | null; pass: boolean; why: string }

/** Score the v4 (pipeline) results of the sealed and held-out sets against the floors. A missing set, a wrong set size or a missing field fails. */
export function evaluateGate(sets: SetCounts[], floors: typeof FLOORS = FLOORS): { rows: GateRow[]; pass: boolean } {
  const rows: GateRow[] = [];
  for (const set of ['sealed', 'heldout'] as const) {
    const s = sets.find(x => x.name === set);
    for (const field of GATE_FIELDS) {
      const floor = floors[set][field];
      const c = s?.v4?.[field];
      if (!s || !c) { rows.push({ set, field, floor, ok: null, n: null, pass: false, why: `${set} set was not scored` }); continue; }
      if (c.n !== GATE_N) { rows.push({ set, field, floor, ok: c.ok, n: c.n, pass: false, why: `${set} ${field} was scored on ${c.n} items, the floors are defined on ${GATE_N}` }); continue; }
      const pass = c.ok >= floor;
      rows.push({ set, field, floor, ok: c.ok, n: c.n, pass, why: pass ? '' : `${c.ok}/${c.n} is below the floor of ${floor}/${GATE_N}` });
    }
  }
  return { rows, pass: rows.every(r => r.pass) };
}

export function gateTable(rows: GateRow[]): string {
  const lines = ['set       field         floor   actual  result'];
  for (const r of rows) lines.push(`${r.set.padEnd(9)} ${r.field.padEnd(13)} ${`${r.floor}/${GATE_N}`.padEnd(7)} ${(r.ok == null ? 'n/a' : `${r.ok}/${r.n}`).padEnd(7)} ${r.pass ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

/** Reasons the gate cannot run at all. It never passes by skipping: each of these is a failure. */
export function gatePreflight(o: { provider: string; modelReachable: boolean; sealedExists: boolean; model: string; ollamaUrl: string }): string[] {
  const problems: string[] = [];
  if (o.provider !== 'ollama' && o.provider !== 'anthropic') problems.push(`LLM_PROVIDER is "${o.provider}", not "ollama" or "anthropic": the gate scores the pipeline with a model in the loop`);
  else if (!o.modelReachable && o.provider === 'anthropic') problems.push(`the hosted model cannot be called (${o.model}): ANTHROPIC_API_KEY is not set; the gate does not pass without the model`);
  else if (!o.modelReachable) problems.push(`the local model is unreachable (${o.model} at ${o.ollamaUrl}): start Ollama and rerun; the gate does not pass without the model`);
  if (!o.sealedExists) problems.push('fixtures/heldout-sealed.json is missing: the gate does not pass without the sealed set');
  return problems;
}

/** Reasons the rules-only gate cannot run: it scores the pipeline with no model, so the provider must be "rules" (an Ollama run is not deterministic), and it needs the sealed set. */
export function rulesGatePreflight(o: { provider: string; sealedExists: boolean }): string[] {
  const problems: string[] = [];
  if (o.provider !== 'rules') problems.push(`LLM_PROVIDER is "${o.provider}", not "rules": the rules-only gate scores the pipeline with no model, and a model run is not deterministic`);
  if (!o.sealedExists) problems.push('fixtures/heldout-sealed.json is missing: the gate does not pass without the sealed set');
  return problems;
}

/** Model calls that failed for infrastructure reasons (unreachable, timed out) on a gated set. Any of these means the numbers are not the model's. */
export function infraFailures(fallbackReasons: (string | null)[]): number {
  return fallbackReasons.filter(r => !!r && /^llm_(unavailable|timeout)\b/.test(r)).length;
}

// ---------------------------------------------------------------- classifier source set and hashes

const IMPORT_RE = /^\s*(?:import|export)\b(?!\s+type\b)[^;'"]*?\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gm;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function resolveLocal(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const c of [base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

export interface SourceFile { path: string; sha256: string; why: string }

/**
 * Every file whose code can change a use case, urgency or disqualifier decision: everything under src/qualify, plus the transitive closure
 * of their runtime (non type-only) local imports. Listed explicitly with a reason per file; sorted by path.
 */
export function classifierFiles(root: string): SourceFile[] {
  const qualifyDir = join(root, 'src', 'qualify');
  const why = new Map<string, string>();
  const queue: string[] = [];
  for (const f of readdirSync(qualifyDir).filter(f => f.endsWith('.ts')).sort()) { const p = join(qualifyDir, f); why.set(p, 'under src/qualify'); queue.push(p); }
  while (queue.length) {
    const file = queue.shift()!;
    const text = readFileSync(file, 'utf8');
    for (const re of [IMPORT_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const target = resolveLocal(file, m[1]);
        if (target && !why.has(target)) { why.set(target, `runtime import of ${relative(root, file).split(sep).join('/')}`); queue.push(target); }
      }
    }
  }
  return [...why.entries()]
    .map(([p, w]) => ({ path: relative(root, p).split(sep).join('/'), sha256: sha256File(p), why: w }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** One hash over the files in sorted path order: sha256 of "<path>\0<sha256>\n" for each file. */
export function combinedHash(files: { path: string; sha256: string }[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(sorted.map(f => `${f.path}\0${f.sha256}\n`).join(''));
}
export const COMBINED_HASH_METHOD = 'sha256 over the concatenation of "<path>\\0<file sha256>\\n" for every classifier file, in ascending path order (UTF-16 code unit order)';

export function compareClassifier(current: string, previous: string | null | undefined): { changed: boolean | null; message: string } {
  if (!previous) return { changed: null, message: 'no earlier recorded run to compare the classifier with (this run becomes the record)' };
  return current === previous
    ? { changed: false, message: 'classifier unchanged since the recorded run' }
    : { changed: true, message: 'classifier CHANGED since the recorded run: sealed results now describe different code' };
}

/** The modelling temperature is a literal in the Ollama call, not a config key; read it from there so the manifest cannot drift from the code. */
export function ollamaTemperature(llmSource: string): number | null {
  const m = llmSource.match(/name:\s*'ollama'[\s\S]*?options:\s*\{\s*temperature:\s*([0-9.]+)/);
  return m ? Number(m[1]) : null;
}

export const mtimeIso = (path: string) => statSync(path).mtime.toISOString();
