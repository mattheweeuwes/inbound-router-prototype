// Domain helpers and TLD heuristics (resolution step 6).
import type { Db } from '../db';
import type { DomainLookups } from '../normalize';
import type { Segment } from '../schema';

const lookups = new WeakMap<Db, DomainLookups>();

/** Free-mail and disposable-domain checks against the registry, prepared once per database. */
export function registryLookups(db: Db): DomainLookups {
  let l = lookups.get(db);
  if (!l) {
    const free = db.prepare(`SELECT 1 FROM reg.free_mail_domains WHERE domain = ?`);
    const disp = db.prepare(`SELECT 1 FROM reg.disposable_domains WHERE domain = ?`);
    l = { isFreeMail: d => !!free.get(d), isDisposable: d => !!disp.get(d) };
    lookups.set(db, l);
  }
  return l;
}

/** mail.eng.example.com -> [mail.eng.example.com, eng.example.com, example.com] */
export function domainChain(domain: string): string[] {
  const parts = domain.toLowerCase().split('.');
  const out: string[] = [];
  for (let i = 0; i <= parts.length - 2; i++) out.push(parts.slice(i).join('.'));
  return out;
}

// ccTLDs that startups use as vanity endings, so they say nothing about location
const VANITY_CCTLD = new Set(['io', 'ai', 'co', 'me', 'tv', 'fm', 'ly', 'gg', 'sh', 'cc', 'ws', 'to', 'vc', 'ac', 'us']);

export function tldSegment(domain: string, country?: string | null): { segment: Segment; detail: string } | null {
  const d = domain.toLowerCase();
  if (d === 'nhs.net' || d.endsWith('.nhs.uk') || d.endsWith('.nhs.net')) return { segment: 'non_us', detail: `${d} is an NHS domain` };
  if (d.endsWith('.edu')) return { segment: 'academic', detail: '.edu domain' };
  if (d.endsWith('.gov') || d.endsWith('.mil')) return { segment: 'government', detail: '.gov domain' };
  const tld = d.split('.').pop() ?? '';
  if (tld.length === 2 && !VANITY_CCTLD.has(tld)) return { segment: 'non_us', detail: `.${tld} country-code domain` };
  if (country && country !== 'US') return { segment: 'non_us', detail: `country field is ${country}` };
  return null;
}
