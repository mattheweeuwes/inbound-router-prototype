// Resolution step 5: free NPPES Registry API, organizations (NPI-2) only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context';
import { nameNorm, scoreNames } from './match';

export interface NppesHit {
  npi: string; name: string; taxonomy: string | null; states: string[];
  npis: string[];     // every NPI-2 record that carries this name
  brand: boolean;     // true when the name spans several NPI-2 records (no single organizational NPI)
}
export interface NppesOutcome { hit: NppesHit | null; note: string }

const STRONG = 0.85;

function cacheFile(ctx: Ctx, key: string) {
  return join(ctx.cfg.cacheDir, 'nppes', createHash('sha1').update(key).digest('hex').slice(0, 16) + '.json');
}

export function nppesUrl(name: string, state: string | null): string {
  const q = new URLSearchParams({ version: '2.1', enumeration_type: 'NPI-2', organization_name: `${name}*`, limit: '10' });
  if (state) q.set('state', state);
  return `https://npiregistry.cms.hhs.gov/api/?${q.toString()}`;
}

export async function lookupNppes(ctx: Ctx, company: string, state: string | null): Promise<NppesOutcome> {
  const url = nppesUrl(company, state);
  const file = cacheFile(ctx, url);
  let body: any;
  if (existsSync(file)) body = JSON.parse(readFileSync(file, 'utf8'));
  else {
    try {
      const res = await ctx.fetch(url, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } });
      if (!res.ok) return { hit: null, note: `NPPES HTTP ${res.status}` };
      body = await res.json();
      mkdirSync(join(ctx.cfg.cacheDir, 'nppes'), { recursive: true });
      writeFileSync(file, JSON.stringify(body));
    } catch (e) {
      return { hit: null, note: `NPPES unavailable: ${(e as Error).message}` };
    }
  }
  return pickStrongMatch(company, body);
}

/** Best similarity between the query and any name on a record: the legal name or a registered other name. */
function recordScore(qNorm: string, r: any): { score: number; prefix: boolean } {
  const names: string[] = [r.basic?.organization_name, ...(r.other_names ?? []).map((o: any) => o.organization_name)].filter(Boolean);
  let best = 0, prefix = false;
  for (const raw of names) {
    const n = nameNorm(raw);
    best = Math.max(best, scoreNames(qNorm, n));
    // "US Anesthesia Partners of Texas" is a member of the brand "US Anesthesia Partners"
    if (qNorm.split(' ').length >= 2 && (n === qNorm || n.startsWith(qNorm + ' '))) prefix = true;
  }
  return { score: best, prefix };
}

/** Pure: choose a strong, unambiguous organization match from an NPPES response. */
export function pickStrongMatch(company: string, body: any): NppesOutcome {
  const results: any[] = body?.results ?? [];
  if (!results.length) return { hit: null, note: 'NPPES returned no organizations' };
  const q = nameNorm(company);
  const scored = results.map(r => ({ r, ...recordScore(q, r) }));
  const members = scored.filter(x => x.score >= STRONG || x.prefix);
  if (!members.length) {
    const best = Math.max(...scored.map(x => x.score));
    return { hit: null, note: `best NPPES name score ${best.toFixed(2)} under ${STRONG} (${results.length} results)` };
  }
  const primaryOf = (r: any) => (r.taxonomies ?? []).find((t: any) => t.primary) ?? r.taxonomies?.[0];
  const states = [...new Set(members.flatMap(x => (x.r.addresses ?? []).filter((a: any) => a.address_purpose === 'LOCATION').map((a: any) => a.state)).filter(Boolean))] as string[];
  const first = members[0].r;
  const npis = members.map(x => String(x.r.number));
  const brand = members.length > 1;
  return {
    hit: { npi: String(first.number), name: first.basic?.organization_name ?? company, taxonomy: primaryOf(first)?.desc ?? null, states, npis: npis.slice(0, 10), brand },
    note: brand ? `NPPES: ${members.length} NPI-2 records carry the name "${company}"` : `NPPES unique name match, NPI ${first.number}`,
  };
}
