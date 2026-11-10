// One finding per group: the group's one rate (v_rate_groups), where it sits against Medicare, which contract form it
// fits, the top rate in its city and its size band's median. Pure: rows and patterns in, findings out.
import { baseSearch, bestPattern, contractForm, median, roundHalfEven, unitSearch, type ContractForm, type Hit } from './patterns';
import { titleCase } from './rateFile';

export const BANDS = ['1-50', '51-500', '501+'] as const;
export type Band = typeof BANDS[number];
/** The band boundaries v_rate_groups uses: 50 or fewer clinicians is small, more than 500 is large. */
export const SMALL_MAX = 50;
export const LARGE_ABOVE = 500;

/** A chosen row of v_rate_groups joined with its city's top, as the store reads it. */
export type GroupRow = {
  ein: string; entity: string; name_norm: string; state: string | null; city: string | null; org_npis: number; rate: number;
  medicare: number; pct_medicare: number; band: Band; top_rate: number; top_clinicians: number; top_ein: string;
};

export interface Pattern { kind: 'card' | 'factor'; value: number; hits: number; distinctRates: number; runnersUp: Hit[] }
export interface Patterns { card: Pattern | null; factor: Pattern | null }

/** The base and the unit, found by search over the file's distinct rates. Either is null when nothing reaches MIN_PATTERN_HITS. */
export function findPatterns(distinctRates: number[]): Patterns {
  const pattern = (kind: Pattern['kind'], ranked: Hit[]): Pattern | null => {
    const best = bestPattern(ranked);
    return best ? { kind, value: best.value, hits: best.hits, distinctRates: distinctRates.length, runnersUp: ranked.slice(1, 3) } : null;
  };
  return { card: pattern('card', baseSearch(distinctRates)), factor: pattern('factor', unitSearch(distinctRates)) };
}

export interface Finding {
  ein: string;
  /** the stable account key: the EIN, never the name */
  accountKey: string;
  name: string;
  nameNorm: string;
  /** title case, for prose */
  city: string;
  state: string | null;
  clinicians: number;
  band: Band;
  rate: number;
  medicare: number;
  /** whole percent of Medicare, from the file's RelativeToBaseline */
  pctOfMedicare: number;
  form: ContractForm;
  cardTier: number | null;
  factorMultiple: number | null;
  cityTopRate: number;
  cityTopClinicians: number;
  cityTopEin: string;
  /** the median percent of Medicare across the group's size band */
  bandMedianPct: number;
}

export const accountKeyOf = (ein: string) => `ein:${ein}`;

/** Percent of Medicare as a whole number: RelativeToBaseline is already a whole percent, so this only undoes the fraction. */
const wholePct = (fraction: number) => roundHalfEven(fraction * 100);

export function buildFindings(groups: GroupRow[], patterns: Patterns): Finding[] {
  const bandMedian = new Map(BANDS.map(b => [b, median(groups.filter(g => g.band === b).map(g => wholePct(g.pct_medicare)))]));
  return groups.map(g => ({
    ein: g.ein, accountKey: accountKeyOf(g.ein), name: g.entity, nameNorm: g.name_norm, city: titleCase(g.city ?? ''), state: g.state,
    clinicians: g.org_npis, band: g.band, rate: g.rate, medicare: g.medicare, pctOfMedicare: wholePct(g.pct_medicare),
    ...contractForm(g.rate, patterns.card?.value ?? null, patterns.factor?.value ?? null),
    cityTopRate: g.top_rate, cityTopClinicians: g.top_clinicians, cityTopEin: g.top_ein, bandMedianPct: bandMedian.get(g.band) ?? NaN,
  }));
}
