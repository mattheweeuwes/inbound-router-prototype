// Loads fixtures/submissions.json and applies data/fixture-overrides.json when the ETL's fixture check wrote one.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Source } from './schema';

export interface Fixture { id: string; ts: string; source: Source; payload: any; sameContactAs?: string; copyOf?: string; note?: string }
export interface Override { company?: string; domain?: string; state?: string }

const PERSON_KEY: Partial<Record<Source, string>> = {
  guide_download: 'fields', signal_ask_waitlist: 'fields', sample_signup: 'user', marketplace: 'requester', api_key: 'developer', event_scan: 'badge',
};

function lastName(p: any, source: Source): string {
  const o = source === 'calendly_demo' ? p.payload : p[PERSON_KEY[source]!];
  const last = o?.last_name ?? o?.lastname ?? o?.last ?? String(o?.name ?? '').split(' ').slice(1).join(' ');
  return String(last ?? '').toLowerCase().replace(/[^a-z]/g, '');
}
function firstInitial(p: any, source: Source): string {
  const o = source === 'calendly_demo' ? p.payload : p[PERSON_KEY[source]!];
  const first = o?.first_name ?? o?.firstname ?? o?.first ?? String(o?.name ?? '').split(' ')[0];
  return String(first ?? '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 1);
}

export function getContact(fx: Fixture): { email?: string; company?: string; state?: string } {
  const p = fx.payload;
  if (fx.source === 'calendly_demo') {
    const qa: any[] = p.payload.questions_and_answers ?? [];
    const a = (re: RegExp) => qa.find(x => re.test(x.question))?.answer;
    return { email: p.payload.email, company: a(/company/i), state: a(/state/i) };
  }
  if (fx.source === 'web_intent') return { company: p.company, email: undefined, state: undefined };
  const o = p[PERSON_KEY[fx.source]!] ?? {};
  return { email: o.email, company: o.company, state: o.state };
}

export function setContact(fx: Fixture, c: { email?: string; company?: string; state?: string }) {
  const p = fx.payload;
  if (fx.source === 'calendly_demo') {
    if (c.email) p.payload.email = c.email;
    for (const x of p.payload.questions_and_answers ?? []) {
      if (c.company !== undefined && /company/i.test(x.question)) x.answer = c.company;
      if (c.state !== undefined && /state/i.test(x.question)) x.answer = c.state;
    }
    return;
  }
  if (fx.source === 'web_intent') { if (c.company !== undefined) p.company = c.company; return; }
  const o = p[PERSON_KEY[fx.source]!];
  if (!o) return;
  if (c.email) o.email = c.email;
  if (c.company !== undefined) o.company = c.company;
  if (c.state !== undefined) o.state = c.state;
}

export function applyOverride(fx: Fixture, ov: Override) {
  if (fx.source === 'web_intent') {
    if (ov.domain) fx.payload.domain = ov.domain;
    if (ov.company) fx.payload.company = ov.company;
    return;
  }
  const email = ov.domain ? `${firstInitial(fx.payload, fx.source)}${lastName(fx.payload, fx.source)}@${ov.domain}` : undefined;
  setContact(fx, { email, company: ov.company, state: ov.state });
}

export function loadFixtures(cfg: { fixturesDir: string; root: string }): Fixture[] {
  const { fixturesDir, root } = cfg;
  const fixtures: Fixture[] = JSON.parse(readFileSync(join(fixturesDir, 'submissions.json'), 'utf8'));
  const ovPath = join(root, 'data', 'fixture-overrides.json');
  const overrides: Record<string, Override> = existsSync(ovPath) ? JSON.parse(readFileSync(ovPath, 'utf8')) : {};
  for (const fx of fixtures) if (overrides[fx.id]) applyOverride(fx, overrides[fx.id]);
  const byId = new Map(fixtures.map(f => [f.id, f]));
  for (const fx of fixtures) {
    if (fx.sameContactAs && byId.has(fx.sameContactAs)) {
      const src = getContact(byId.get(fx.sameContactAs)!);
      setContact(fx, src);
    }
  }
  for (const fx of fixtures) if (fx.copyOf && byId.has(fx.copyOf)) fx.payload = structuredClone(byId.get(fx.copyOf)!.payload);
  return fixtures.map((f, i) => ({ f, i })).sort((a, b) => Date.parse(a.f.ts) - Date.parse(b.f.ts) || a.i - b.i).map(x => x.f);
}
