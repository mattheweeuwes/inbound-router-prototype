// The two contract forms the take-home found in the rate file, as pure functions ported from its analysis.py with the
// same tolerances. A rate card: a rate is a whole percent of one base, to the cent. A conversion factor: a rate is a
// whole-dollar multiple of one unit, exactly. Neither base nor unit is hard-coded; both are found by search.

/** Python's round(): half to even. Rates are whole cents, so this only matters on an exact .5, but the port keeps it. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** To the cent. Differs from Python's round(x, 2) only on exact binary ties, which the 0.011 tolerance below absorbs. */
const toCent = (x: number) => Number(x.toFixed(2));

/** A card tier must sit in this range of percents to count. */
export const TIER_MIN = 50;
export const TIER_MAX = 300;
/** The rate must equal base x tier / 100 to within this many dollars: one cent, plus float slack. */
export const TIER_TOLERANCE = 0.011;

/** The whole-number percent of `base` that `rate` equals to the cent, or null. analysis.py: tier(). */
export function tier(rate: number, base: number): number | null {
  const p = roundHalfEven((rate / base) * 100);
  return p >= TIER_MIN && p <= TIER_MAX && Math.abs(toCent((base * p) / 100) - rate) < TIER_TOLERANCE ? p : null;
}

/** The whole-dollar multiple of `unit` that `rate` equals exactly, in cents, or null. analysis.py: factor(). */
export function factor(rate: number, unit: number): number | null {
  const cents = roundHalfEven(rate * 100), unitCents = roundHalfEven(unit * 100);
  return cents % unitCents === 0 ? cents / unitCents : null;
}

export interface Hit { value: number; hits: number }

/** Best first: more hits, then the larger value, as Python's sorted(reverse=True) orders (hits, value) tuples. */
const byHitsThenValue = (a: Hit, b: Hit) => b.hits - a.hits || b.value - a.value;

/** Every rate between these is tried as the card's base. */
export const BASE_MIN = 100;
export const BASE_MAX = 200;

/**
 * Every distinct rate from BASE_MIN to BASE_MAX tried as the card's base, best first: how many of the distinct rates are a
 * whole percent of it. analysis.py: the `candidates` list in main().
 */
export function baseSearch(distinctRates: number[]): Hit[] {
  return distinctRates
    .filter(b => b >= BASE_MIN && b <= BASE_MAX)
    .map(b => ({ value: b, hits: distinctRates.filter(r => tier(r, b) !== null).length }))
    .sort(byHitsThenValue);
}

/** Every per-unit amount from $2.00 to $10.00, by the cent, is tried as the unit. */
export const UNIT_MIN_CENTS = 200;
export const UNIT_MAX_CENTS = 1000;

/**
 * Every unit from $2.00 to $10.00 tried, best first: how many of the rates are exact whole multiples of it. A
 * conversion-factor contract shows up here and not in the base search, because the unit is not itself a rate.
 * analysis.py: unit_search().
 */
export function unitSearch(rates: number[]): Hit[] {
  const cents = rates.map(r => roundHalfEven(r * 100));
  const out: Hit[] = [];
  for (let u = UNIT_MIN_CENTS; u <= UNIT_MAX_CENTS; u++) out.push({ value: u / 100, hits: cents.filter(c => c % u === 0).length });
  return out.sort(byHitsThenValue);
}

/**
 * A pattern needs at least this many distinct rates. Every base explains itself (at 100%), so one hit is no pattern; the
 * take-home ruled out chance with a nudged-rates test (at most 10 hits for a base, 4 for a unit, against 15 and 16 found).
 * That test is random and is not ported, so the hit count is stored next to the pattern for a reader to judge.
 */
export const MIN_PATTERN_HITS = 3;

/** The best hit, when it explains enough rates to count as a pattern. */
export const bestPattern = (ranked: Hit[]): Hit | null => (ranked[0] && ranked[0].hits >= MIN_PATTERN_HITS ? ranked[0] : null);

export type ContractForm = 'card' | 'factor' | 'both' | 'neither';

/** Which form a rate fits, given the patterns found (either may be absent). */
export function contractForm(rate: number, base: number | null, unit: number | null): { form: ContractForm; cardTier: number | null; factorMultiple: number | null } {
  const cardTier = base === null ? null : tier(rate, base);
  const factorMultiple = unit === null ? null : factor(rate, unit);
  const form: ContractForm = cardTier !== null && factorMultiple !== null ? 'both' : cardTier !== null ? 'card' : factorMultiple !== null ? 'factor' : 'neither';
  return { form, cardTier, factorMultiple };
}

/** The median, as Python's statistics.median: the mean of the two middle values when the count is even. NaN when empty. */
export function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
