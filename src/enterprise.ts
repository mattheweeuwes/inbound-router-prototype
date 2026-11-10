// What makes an account enterprise, in one place (decision 25). This is a starting assumption for Serif to replace with its
// own definition, not a finding: Serif's CTO wants more enterprise customers, and until now nothing in the router marked one.
// It reads only the registry's (or the CRM record's) firmographics, never the message, and it changes no score.
import type { DealCue } from './dealCues';
import type { Firmographics, Resolution, Segment } from './schema';

/** The definition, stated as data so a test, the docs and the reason sentence all read the same numbers. */
export const ENTERPRISE_DEFINITION = {
  /** a health system with at least this many hospitals */
  minHospitals: 8,
  /** or with hospitals in at least this many states */
  minStates: 3,
  /** a payer of one of these kinds (the registry's payers.kind) */
  payerKinds: ['national', 'blue'] as readonly string[],
  /** a benefits consultant or broker, or a TPA, of this size class (curated_orgs.size_class) */
  sizeClass: 'national',
} as const;

/** Which part of the definition the account met. */
export type EnterpriseBasis = 'hospitals' | 'states' | 'payer_kind' | 'size_class';

export interface Enterprise {
  enterprise: boolean;
  /** a short line of fact from the firmographics ("145 hospitals in 20 states", "national payer"), or null when there is none */
  fact: string | null;
  basis: EnterpriseBasis | null;
}

const NOT_ENTERPRISE: Enterprise = { enterprise: false, fact: null, basis: null };

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * "145 hospitals in 20 states" or "12 hospitals": what the registry says about a system's size. One state is not named: the
 * registry's state list starts from the system's headquarters, so a single state may be only where its office is.
 */
export function hospitalFact(f: Firmographics): string | null {
  const h = f.hospitals ?? null;
  const states = f.states ?? [];
  const where = states.length >= 2 ? ` in ${count(states.length, 'state')}` : '';
  if (h != null && h > 0) return `${count(h, 'hospital')}${where}`;
  return states.length >= 2 ? `hospitals in ${count(states.length, 'state')}` : null;
}

const PAYER_FACT: Record<string, string> = { national: 'national payer', blue: 'Blue plan', regional: 'regional payer' };
const SIZE_FACT: Partial<Record<Segment, string>> = { benefits_consultant_broker: 'benefits consultant or broker', tpa: 'third-party administrator' };

/** Whether an account is enterprise under ENTERPRISE_DEFINITION, with the fact line that says why (or what is known when it is not). */
export function enterpriseOf(segment: Segment, f: Firmographics): Enterprise {
  const d = ENTERPRISE_DEFINITION;
  if (segment === 'health_system') {
    const fact = hospitalFact(f);
    if ((f.hospitals ?? 0) >= d.minHospitals) return { enterprise: true, fact, basis: 'hospitals' };
    if ((f.states?.length ?? 0) >= d.minStates) return { enterprise: true, fact, basis: 'states' };
    return { ...NOT_ENTERPRISE, fact };
  }
  if (segment === 'payer') {
    const kind = f.payerKind ?? null;
    const fact = kind ? PAYER_FACT[kind] ?? `${kind} payer` : null;
    return kind && d.payerKinds.includes(kind) ? { enterprise: true, fact, basis: 'payer_kind' } : { ...NOT_ENTERPRISE, fact };
  }
  const what = SIZE_FACT[segment];
  if (what) {
    const size = f.sizeClass ?? null;
    const fact = size && size !== 'other' ? `${size} ${what}` : null;
    return size === d.sizeClass ? { enterprise: true, fact, basis: 'size_class' } : { ...NOT_ENTERPRISE, fact };
  }
  return NOT_ENTERPRISE;
}

/** What routing and the brief know about the deal beyond the classifier: the account's size and the message's deal-size cues. */
export interface DealSignals { enterprise: Enterprise; cues: DealCue[] }

export const NO_DEAL_SIGNALS: DealSignals = { enterprise: NOT_ENTERPRISE, cues: [] };

/**
 * Segments a sales team sells to. A deal-size cue counts only from one of these: a student, a reporter or an unknown company
 * asking for "the full dataset" is not an enterprise deal. Government employers are left out too; they score as weak buyers.
 */
export const SALES_SEGMENTS: readonly Segment[] = [
  'health_system', 'standalone_hospital', 'provider_group', 'payer', 'benefits_consultant_broker', 'tpa', 'employer_self_funded',
  'life_sciences', 'pe_investor', 'consulting_advisory', 'innovator_navigation', 'innovator_api_data',
];

/** Resolved to a known organization in a sales segment, with more than low confidence and not by inference. */
export const confidentSalesOrg = (res: Resolution) =>
  res.status === 'resolved' && res.confidence !== 'low' && !res.inferred && SALES_SEGMENTS.includes(res.segment);
