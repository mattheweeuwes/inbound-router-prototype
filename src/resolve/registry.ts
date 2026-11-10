// Read-only lookups against the attached `reg` database.
import type { Db } from '../db';
import type { Firmographics, Segment } from '../schema';

export interface CuratedOrg { domain: string; name: string; segment: Segment; subsegment: string | null; size_class: string | null }

// Defensive: the ETL may spell a segment slightly differently than the scoring table.
const SEGMENT_ALIAS: Record<string, Segment> = {
  broker: 'benefits_consultant_broker', consultant: 'benefits_consultant_broker', broker_consultant: 'benefits_consultant_broker',
  benefits_broker: 'benefits_consultant_broker', benefits_consultant: 'benefits_consultant_broker',
  navigation: 'innovator_navigation', innovator_api: 'innovator_api_data', innovator: 'innovator_api_data',
  api_innovator: 'innovator_api_data', pe: 'pe_investor', private_equity: 'pe_investor', consulting: 'consulting_advisory',
  lifesciences: 'life_sciences', pharma: 'life_sciences',
};
const KNOWN = new Set<string>(['health_system', 'payer', 'benefits_consultant_broker', 'tpa', 'life_sciences', 'standalone_hospital', 'employer_self_funded', 'innovator_navigation', 'innovator_api_data', 'provider_group', 'pe_investor', 'consulting_advisory', 'unknown_org', 'government', 'academic', 'non_us', 'media', 'competitor']);

export function toSegment(s: string): Segment {
  const k = s.trim().toLowerCase().replace(/[\s/&-]+/g, '_');
  if (KNOWN.has(k)) return k as Segment;
  return SEGMENT_ALIAS[k] ?? 'unknown_org';
}

type CuratedOrgRow = Omit<CuratedOrg, 'segment'> & { segment: string };

export function curatedOrg(db: Db, domain: string): CuratedOrg | null {
  const r = db.prepare(`SELECT domain, name, segment, subsegment, size_class FROM reg.curated_orgs WHERE domain = ?`).get(domain) as CuratedOrgRow | undefined;
  return r ? { ...r, segment: toSegment(r.segment) } : null;
}

export interface OrgDomain { domain: string; entity_type: 'ahrq_system' | 'cms_hospital' | 'payer'; entity_id: string; name: string; evidence: string | null }

export function orgDomain(db: Db, domain: string): OrgDomain | null {
  return (db.prepare(`SELECT domain, entity_type, entity_id, name, evidence FROM reg.org_domains WHERE domain = ?`).get(domain) as OrgDomain | undefined) ?? null;
}

export function systemFirmographics(db: Db, id: string): { name: string; firmographics: Firmographics } | null {
  const s = db.prepare(`SELECT name, state, hosp_cnt, sys_beds FROM reg.ahrq_systems WHERE health_sys_id = ?`).get(id) as { name: string; state: string | null; hosp_cnt: number | null; sys_beds: number | null } | undefined;
  if (!s) return null;
  const links = db.prepare(`SELECT ccn, state, beds FROM reg.ahrq_hospital_links WHERE health_sys_id = ? ORDER BY source_year DESC, beds DESC`).all(id) as { ccn: string; state: string | null; beds: number | null }[];
  const seen = new Set<string>();
  const ccns: string[] = [];
  for (const l of links) if (!seen.has(l.ccn)) { seen.add(l.ccn); ccns.push(l.ccn); }
  const states = [...new Set([s.state, ...links.map(l => l.state)].filter(Boolean))].sort() as string[];
  return { name: s.name, firmographics: { hospitals: s.hosp_cnt ?? null, beds: s.sys_beds ?? null, states, ccns: ccns.slice(0, 10) } };
}

export function hospital(db: Db, ccn: string) {
  const h = db.prepare(`SELECT ccn, name, state, hospital_type, ownership, overall_rating FROM reg.cms_hospitals WHERE ccn = ?`).get(ccn) as { ccn: string; name: string; state: string | null; hospital_type: string | null; ownership: string | null; overall_rating: string | number | null } | undefined;
  if (!h) return null;
  const link = db.prepare(`SELECT health_sys_id, beds FROM reg.ahrq_hospital_links WHERE ccn = ? ORDER BY source_year DESC LIMIT 1`).get(ccn) as { health_sys_id: string | null; beds: number | null } | undefined;
  const rating = h.overall_rating != null && h.overall_rating !== '' && !Number.isNaN(Number(h.overall_rating)) ? Number(h.overall_rating) : null;
  return { ccn: h.ccn, name: h.name, state: h.state, systemId: link?.health_sys_id ?? null, beds: link?.beds ?? null, cmsType: h.hospital_type, ownership: h.ownership, rating };
}

export function payer(db: Db, slug: string) {
  return db.prepare(`SELECT slug, name, kind, domain FROM reg.payers WHERE slug = ?`).get(slug) as { slug: string; name: string; kind: string; domain: string } | undefined;
}

export function registryMeta(db: Db): Record<string, string> {
  return Object.fromEntries((db.prepare(`SELECT key, value FROM reg.meta`).all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
}

/** What the registry holds, as the How it works tab states it: hospitals (CCN), health systems, payers and verified organization domains. */
export interface RegistryCounts { hospitals: number; systems: number; payers: number; verifiedDomains: number }

export function registryCounts(db: Db): RegistryCounts {
  const r = db.prepare(`SELECT (SELECT COUNT(*) FROM reg.cms_hospitals) AS hospitals, (SELECT COUNT(*) FROM reg.ahrq_systems) AS systems,
    (SELECT COUNT(*) FROM reg.payers) AS payers, (SELECT COUNT(*) FROM reg.org_domains) AS verified_domains`).get() as { hospitals: number; systems: number; payers: number; verified_domains: number };
  return { hospitals: Number(r.hospitals), systems: Number(r.systems), payers: Number(r.payers), verifiedDomains: Number(r.verified_domains) };
}
