// Company-name matching. nameNorm() must stay identical to the ETL's name_norm rule (etl/name_norm.py).
import type { Db } from '../db';
import type { Candidate } from '../schema';

const STOP = new Set(['inc', 'llc', 'the', 'of', 'corp', 'corporation', 'company', 'co', 'ltd']);
/** Kept in name_norm, but they carry little identity, so scoring gives them less weight. */
export const GENERIC = new Set(['health', 'hospital', 'hospitals', 'system', 'systems', 'medical', 'center', 'centre', 'healthcare']);
const GENERIC_WEIGHT = 0.3;

export function nameNorm(s: string | null | undefined): string {
  if (!s) return '';
  // Same steps as etl/name_norm.py: NFKD and drop accents, lowercase, & -> and, delete apostrophes, every other non-alphanumeric run -> a space.
  const t = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/['\u2019`]/g, '').replace(/[^a-z0-9]+/g, ' ');
  return t.split(' ').filter(w => w && !STOP.has(w)).join(' ');
}

const tok = (n: string) => n.split(' ').filter(Boolean);
const weight = (t: string) => (GENERIC.has(t) ? GENERIC_WEIGHT : 1);

function trigrams(n: string): Set<string> {
  const p = `  ${n} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  return out;
}

export function scoreNames(aNorm: string, bNorm: string): number {
  if (!aNorm || !bNorm) return 0;
  const a = new Set(tok(aNorm)), b = new Set(tok(bNorm));
  let inter = 0, union = 0;
  for (const t of new Set([...a, ...b])) {
    const w = weight(t);
    union += w;
    if (a.has(t) && b.has(t)) inter += w;
  }
  const jac = union ? inter / union : 0;
  const ta = trigrams(aNorm), tb = trigrams(bNorm);
  let common = 0;
  for (const g of ta) if (tb.has(g)) common++;
  const dice = (2 * common) / (ta.size + tb.size);
  return 0.6 * jac + 0.4 * dice;
}

interface Entry {
  kind: 'ahrq_system' | 'cms_hospital' | 'payer';
  id: string; name: string; norm: string; tokens: Set<string>; state: string | null; multistate: boolean;
  accountId: string; accountName: string;
}

const indexCache = new WeakMap<Db, Entry[]>();

function buildIndex(db: Db): Entry[] {
  const out: Entry[] = [];
  const sys = db.prepare(`SELECT health_sys_id id, name, state, multistate, name_norm FROM reg.ahrq_systems`).all() as { id: string; name: string; state: string | null; multistate: number | null; name_norm: string | null }[];
  const sysName = new Map<string, string>();
  for (const s of sys) {
    sysName.set(s.id, s.name);
    const norm = s.name_norm || nameNorm(s.name);
    out.push({ kind: 'ahrq_system', id: s.id, name: s.name, norm, tokens: new Set(tok(norm)), state: s.state ?? null, multistate: !!s.multistate, accountId: `ahrq:${s.id}`, accountName: s.name });
  }
  // a hospital resolves to its (latest-year) system when AHRQ links it to one
  const links = db.prepare(`SELECT ccn, health_sys_id, source_year FROM reg.ahrq_hospital_links ORDER BY source_year ASC`).all() as { ccn: string; health_sys_id: string; source_year: number }[];
  const linkOf = new Map<string, string>();
  for (const l of links) linkOf.set(l.ccn, l.health_sys_id);
  for (const h of db.prepare(`SELECT ccn, name, state, name_norm FROM reg.cms_hospitals`).all() as { ccn: string; name: string; state: string | null; name_norm: string | null }[]) {
    const norm = h.name_norm || nameNorm(h.name);
    const sid = linkOf.get(h.ccn);
    out.push({
      kind: 'cms_hospital', id: h.ccn, name: h.name, norm, tokens: new Set(tok(norm)), state: h.state ?? null, multistate: false,
      accountId: sid ? `ahrq:${sid}` : `ccn:${h.ccn}`, accountName: sid ? (sysName.get(sid) ?? h.name) : h.name,
    });
  }
  for (const p of db.prepare(`SELECT slug, name, name_norm FROM reg.payers`).all() as { slug: string; name: string; name_norm: string | null }[]) {
    const norm = p.name_norm || nameNorm(p.name);
    out.push({ kind: 'payer', id: p.slug, name: p.name, norm, tokens: new Set(tok(norm)), state: null, multistate: true, accountId: `payer:${p.slug}`, accountName: p.name });
  }
  return out;
}

export interface MatchResult {
  outcome: 'unique' | 'ambiguous' | 'none';
  top: Candidate | null;
  runnerUp: Candidate | null;
  candidates: Candidate[]; // top five distinct accounts
  reason: string;
}

export const MATCH_MIN = 0.7; // below this there is nothing worth showing a person
export const MATCH_STRONG = 0.85;
export const MATCH_MARGIN = 0.1;
export const CANDIDATE_MIN = 0.75; // review-queue candidates: at least this, or within CANDIDATE_BAND of the top
export const CANDIDATE_BAND = 0.15;

/** Fuzzy-match a company string. State filters hospitals and nudges systems. Candidates are collapsed per account. */
export function matchCompany(db: Db, company: string, state: string | null): MatchResult {
  let idx = indexCache.get(db);
  if (!idx) { idx = buildIndex(db); indexCache.set(db, idx); }
  const q = nameNorm(company);
  const qTokens = tok(q);
  if (!q) return { outcome: 'none', top: null, runnerUp: null, candidates: [], reason: 'empty company name' };

  const best = new Map<string, Candidate & { tokens: Set<string> }>();
  for (const e of idx) {
    if (state && e.kind === 'cms_hospital' && e.state && e.state !== state) continue;
    let s = scoreNames(q, e.norm);
    if (state && e.state) {
      if (e.state === state) s = Math.min(1, s + 0.05);
      else if (!e.multistate) s -= 0.1;
    }
    if (s < 0.4) continue;
    const prev = best.get(e.accountId);
    if (!prev || s > prev.score) best.set(e.accountId, { accountId: e.accountId, name: e.accountName, kind: e.kind, state: e.state, score: Math.round(s * 1000) / 1000, tokens: e.tokens });
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  const top = ranked[0], second = ranked[1];
  // what a person sees: scoring 0.75 or more, or within 0.15 of the top, at most five
  const candidates: Candidate[] = ranked.filter(c => c.score >= CANDIDATE_MIN || (top && top.score - c.score <= CANDIDATE_BAND + 1e-9)).slice(0, 5).map(({ tokens: _t, ...c }) => c);
  if (!top || top.score < MATCH_MIN) return { outcome: 'none', top: null, runnerUp: null, candidates, reason: `best score ${top?.score ?? 0} is under ${MATCH_MIN}` };

  const EPS = 1e-9; // 1.0 - 0.9 is 0.0999999... in floating point
  const close = ranked.filter(c => c.score >= MATCH_MIN && top.score - c.score < MATCH_MARGIN - EPS);
  if (close.length > 1) {
    return { outcome: 'ambiguous', top: strip(top), runnerUp: strip(second), candidates, reason: `${close.length} accounts within ${MATCH_MARGIN} of the top score` };
  }
  if (top.score < MATCH_STRONG) return { outcome: 'none', top: strip(top), runnerUp: strip(second), candidates, reason: `unique but weak (${top.score} < ${MATCH_STRONG})` };

  // A short name that is contained in several different accounts is ambiguous even if one scores higher.
  const core = qTokens.filter(t => !GENERIC.has(t));
  if (core.length && qTokens.length <= 3) {
    const containing = ranked.filter(c => c.score >= MATCH_MIN && core.every(t => c.tokens.has(t)) && (!state || !c.state || c.state === state));
    if (containing.length >= 2) {
      return { outcome: 'ambiguous', top: strip(top), runnerUp: strip(second), candidates, reason: `"${company}" is contained in ${containing.length} different accounts` };
    }
  }
  if (second && top.score - second.score < MATCH_MARGIN - EPS) {
    return { outcome: 'ambiguous', top: strip(top), runnerUp: strip(second), candidates, reason: 'runner-up within margin' };
  }
  return { outcome: 'unique', top: strip(top), runnerUp: strip(second), candidates, reason: `${top.score} vs runner-up ${second?.score ?? 0}` };
}

function strip(c?: (Candidate & { tokens?: Set<string> })): Candidate | null {
  if (!c) return null;
  const { tokens: _t, ...rest } = c;
  return rest;
}
