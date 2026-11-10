// A conference badge-scan list, generated (decision 24). Seeded, so the same seed and clock give the same list. Every person
// is invented and flagged synthetic. Organizations come from the registry in use (real ones, as the registry holds them), a
// share are fictional unknown companies on the reserved .example domain, a share are on free mail, a share are the fictional
// customers in fixtures/crm-mirror.json, and a share are second scans of a badge already in the list, with a later time.
// The list is shuffled, as a booth export is: it is not in time order. Booth notes come from one pool, about a third vague.
import type { DatabaseSync } from 'node:sqlite';
import type { CrmMirrorEntry } from '../../src/schema';

export interface BadgeScan {
  synthetic: true;
  event: string;
  scanned_at: string;
  badge: { email: string; first: string; last: string; title: string; company: string; state?: string };
  notes: string;
}

/** Where each scan came from, for a test or a report; never posted. */
export type ScanKind = 'registry' | 'unknown' | 'free_mail' | 'customer' | 'repeat';

export interface GeneratedList { listName: string; scans: BadgeScan[]; kinds: ScanKind[] }

export interface ListUploadOptions {
  count: number;
  listName: string;
  seed: number;
  /** epoch ms the scan times are counted back from */
  now: number;
}

/** The shares of a list, as fractions of the count (each at least one scan). The rest are registry organizations. */
export const SHARES = { unknown: 0.12, freeMail: 0.05, customer: 0.03, repeat: 0.04 } as const;

const FIRST = 'Aiden Bianca Carlos Deja Elias Farah Gideon Hana Imani Jules Keiko Lamar Mirela Nadim Odessa Pavel Quentin Rosalind Stellan Tamsin Ulises Vera Wendell Ximena Yusuf Zelda Amara Bodhi Calla Dario Esme Finnian Greta Hollis Ines Jasper Kalani Leopold Maren Nikos'.split(' ');
const LAST = 'Ashcombe Bellweather Corrigan Delacroix Eastlake Fenwick Garroway Halvorsen Ingleby Jessup Kirkbride Lowenthal Marchetti Northcutt Okonjo Pemberton Quimby Rosenthal Sandoval Thackeray Underhill Vasquez Winterbourne Yarrow Zielinski Abernethy Brightwater Calloway Dunmore Ellsworth'.split(' ');
const TITLES: Record<string, string[]> = {
  ahrq_system: ['VP, Managed Care', 'Director, Payer Contracting', 'Chief Financial Officer', 'Director, Revenue Cycle', 'Manager, Decision Support', 'VP, Strategy', 'Contract Analyst', 'Chief Strategy Officer'],
  health_system: ['VP, Managed Care', 'Director, Payer Contracting', 'Chief Financial Officer', 'Director, Revenue Cycle', 'VP, Strategy'],
  cms_hospital: ['Chief Financial Officer', 'Director, Revenue Cycle', 'Managed Care Analyst', 'Director, Patient Financial Services', 'Controller'],
  payer: ['VP, Network Strategy', 'Director, Provider Contracting', 'Senior Actuary', 'Director, Network Analytics', 'Manager, Competitive Intelligence'],
  benefits_consultant_broker: ['Senior Consultant, Health & Benefits', 'Principal', 'Benefits Analyst', 'VP, Employee Benefits', 'Actuarial Consultant'],
  tpa: ['VP, Operations', 'Director, Network Solutions', 'Product Manager'],
  life_sciences: ['Director, Market Access', 'Senior Manager, Pricing & Reimbursement'],
  pe_investor: ['Vice President', 'Principal, Healthcare'],
  innovator_navigation: ['Head of Product', 'Senior Software Engineer', 'VP, Partnerships'],
  innovator_api_data: ['Head of Data', 'Staff Engineer'],
  consulting_advisory: ['Senior Manager', 'Partner, Healthcare'],
  unknown: ['Benefits Manager', 'Director, Total Rewards', 'HR Director', 'Founder', 'Practice Administrator', 'Operations Manager'],
};
export const NOTES = [
  'asked about service-line benchmarks', 'wants peer rate comparison before the UHC renewal in February', 'stopped by the booth, took a brochure',
  'interested in Network Benchmarking for client renewals', 'asked if the API covers all payers', 'contract with Aetna is up in Q2',
  'just browsing', 'wants a demo next week', 'asked about data quality scores', 'looking at a bulk data license for the analytics team',
  'curious about Signal Watch alerts', 'evaluating us against another vendor, decision by January', 'wants pricing', '', '', '', '', '', '',
];
export const REPEAT_NOTE = 'second session scan';
/** Fictional companies no registry holds, on the reserved .example domain. */
export const UNKNOWN_COMPANIES: [string, string][] = [
  ['Harrowgate Mills', 'harrowgatemills.example'], ['Pinecrest Logistics', 'pinecrestlogistics.example'], ['Fernhollow Foods', 'fernhollowfoods.example'],
  ['Castellan Manufacturing', 'castellanmfg.example'], ['Brightwater Schools', 'brightwaterschools.example'], ['Oakhaven Dental Partners', 'oakhavendental.example'],
  ['Summerfield Behavioral', 'summerfieldbh.example'], ['Tidewater Freight', 'tidewaterfreight.example'], ['Larkspur Hospitality', 'larkspurhospitality.example'],
  ['Granite Ridge Energy', 'graniteridgeenergy.example'],
];

/** A registry organization the list samples from. */
export interface ListOrg { kind: string; name: string; domain: string; state: string | null }

/**
 * The organizations a list samples from, read from a registry database. `schema` is 'reg.' on the app database (the registry
 * is attached there) and '' on the registry file itself.
 */
export function registryOrgs(db: DatabaseSync, schema: 'reg.' | '' = 'reg.'): ListOrg[] {
  const states = new Map((db.prepare(`SELECT d.domain AS domain, s.state AS state FROM ${schema}org_domains d JOIN ${schema}ahrq_systems s ON s.health_sys_id = d.entity_id WHERE d.entity_type = 'ahrq_system'`).all() as { domain: string; state: string | null }[]).map(r => [r.domain, r.state]));
  const domains = db.prepare(`SELECT entity_type AS kind, name, domain FROM ${schema}org_domains WHERE domain IS NOT NULL ORDER BY domain`).all() as { kind: string; name: string; domain: string }[];
  const curated = db.prepare(`SELECT segment AS kind, name, domain FROM ${schema}curated_orgs WHERE domain IS NOT NULL AND segment NOT IN ('media', 'competitor', 'government', 'academic') ORDER BY domain`).all() as { kind: string; name: string; domain: string }[];
  return [...domains, ...curated].map(o => ({ ...o, state: states.get(o.domain) ?? null }));
}

/** The fictional customers in the CRM mirror: the list's share of people at accounts Serif already has. */
export const mirrorCustomers = (mirror: CrmMirrorEntry[]): ListOrg[] =>
  mirror.filter(m => m.status === 'customer' && m.domains?.length).map(m => ({ kind: m.segment, name: m.name, domain: m.domains[0], state: null }));

/** mulberry32: a small seeded generator, so a list is the same for the same seed on every machine. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const shuffle = <T>(xs: T[]): T[] => {
    for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
    return xs;
  };
  return { next, int, pick, shuffle };
}

const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
const share = (count: number, f: number) => Math.max(1, Math.floor(count * f));

/** The list: `count` scans in all, the shares above, shuffled. */
export function generateList(orgs: ListOrg[], customers: ListOrg[], o: ListUploadOptions): GeneratedList {
  if (!orgs.length) throw new Error('the registry has no organizations with a domain to sample from');
  const rng = seeded(o.seed);
  const counts = { unknown: share(o.count, SHARES.unknown), freeMail: share(o.count, SHARES.freeMail), customer: share(o.count, SHARES.customer), repeat: share(o.count, SHARES.repeat) };
  const registryCount = Math.max(0, o.count - counts.unknown - counts.freeMail - counts.customer - counts.repeat);
  const rows: { scan: BadgeScan; kind: ScanKind }[] = [];
  let n = 0;
  const scan = (kind: ScanKind, titleKind: string, company: string, domain: string, state: string | null): BadgeScan => {
    n++;
    const first = rng.pick(FIRST), last = rng.pick(LAST);
    const local = `${first[0].toLowerCase()}${last.toLowerCase()}${n}`;
    return {
      synthetic: true, event: o.listName, scanned_at: iso(o.now - rng.int(60, 600) * 60_000),
      badge: { email: `${local}@${domain}`, first, last, title: rng.pick(TITLES[titleKind] ?? TITLES.unknown), company, ...(state ? { state } : {}) },
      notes: rng.pick(NOTES),
    };
  };
  // a registry sample without replacement while it lasts; a small registry (the test one) repeats organizations, never people
  const pool = rng.shuffle([...orgs]);
  for (let i = 0; i < registryCount; i++) {
    const org = pool[i % pool.length];
    rows.push({ scan: scan('registry', org.kind, org.name, org.domain, org.state), kind: 'registry' });
  }
  for (let i = 0; i < counts.unknown; i++) {
    const [company, domain] = rng.pick(UNKNOWN_COMPANIES);
    rows.push({ scan: scan('unknown', 'unknown', company, domain, null), kind: 'unknown' });
  }
  for (let i = 0; i < counts.freeMail; i++) {
    const [company] = rng.pick(UNKNOWN_COMPANIES);
    rows.push({ scan: scan('free_mail', 'unknown', company, 'gmail.com', null), kind: 'free_mail' });
  }
  for (let i = 0; i < counts.customer && customers.length; i++) {
    const c = rng.pick(customers);
    rows.push({ scan: scan('customer', c.kind, c.name, c.domain, c.state), kind: 'customer' });
  }
  // the same badge scanned again at a later session
  const firsts = rng.shuffle(rows.map((_, i) => i)).slice(0, counts.repeat);
  for (const i of firsts) {
    const s = rows[i].scan;
    rows.push({ scan: { ...s, badge: { ...s.badge }, scanned_at: iso(o.now - rng.int(5, 50) * 60_000), notes: REPEAT_NOTE }, kind: 'repeat' });
  }
  rng.shuffle(rows);
  return { listName: o.listName, scans: rows.map(r => r.scan), kinds: rows.map(r => r.kind) };
}

/** Posts every scan to the event_scan door, one after another with no gap, and returns the lead ids in posting order. */
export async function postList(scans: BadgeScan[], post: (payload: BadgeScan) => Promise<{ status: number; leadId: string | null }>) {
  const ids: (string | null)[] = [];
  const codes: Record<number, number> = {};
  for (const s of scans) {
    const r = await post(s);
    codes[r.status] = (codes[r.status] ?? 0) + 1;
    ids.push(r.leadId);
  }
  return { ids, codes };
}
