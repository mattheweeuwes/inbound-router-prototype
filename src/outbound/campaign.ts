// The file-wide facts every draft and rate line draws on: who the file is about (payer, network, month, code), the card's
// common range, and the band medians. Computed by code from the stored findings and patterns; nothing here is written by hand
// except the three constants marked as such.
import { BANDS, type Finding, type Patterns } from './findings';
import type { RateFileScope } from './rateFile';

/** Short payer names for prose. A payer not listed keeps its full name. */
const PAYER_SHORT: Record<string, string> = { UnitedHealthcare: 'UHC' };

/** Session length by CPT code, for "a 60-minute session". A code not listed gets no draft (the email names the session). */
export const SESSION_MINUTES: Record<string, number> = { '90837': 60 };

/**
 * A reading of the names, not a field in the file: in the Aug 2026 UHC Choice Plus file every group over 500 clinicians paid
 * above 115% of Medicare is a hospital system or academic medical center (the take-home, Part 1). A different file needs the
 * reading done again before a draft repeats it.
 */
export const LEVERAGE_PCT = 115;

/** The length of the meeting the email asks for. */
export const MEETING_MINUTES = 20;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The card's common range: the tiers that two or more small groups share, lowest to highest, in percent and in dollars. */
export interface CardRange {
  base: number;
  tierLow: number;
  tierHigh: number;
  low: number;
  high: number;
  /** small groups paid inside [low, high], of all small groups */
  smallInside: number;
  smallTotal: number;
}

/** What the file is about, in words for prose: the payer, network, code and month. */
export interface FileTerms {
  payer: string;
  payerShort: string;
  network: string;
  code: string;
  /** "August", "Aug" and "2026", from NetworkYearMonth 202608 */
  month: string;
  monthShort: string;
  year: string;
  sessionMinutes: number | null;
}

export interface Campaign extends FileTerms {
  smallMedianPct: number;
  largeMedianPct: number;
  card: CardRange | null;
}

/** Two or more small groups on a tier make it part of the card's common range; one group alone could be a coincidence. */
export const COMMON_TIER_GROUPS = 2;

export function cardRange(findings: Finding[], patterns: Patterns): CardRange | null {
  if (!patterns.card) return null;
  const small = findings.filter(f => f.band === BANDS[0]);
  const perTier = new Map<number, number>();
  for (const f of small) if (f.cardTier !== null) perTier.set(f.cardTier, (perTier.get(f.cardTier) ?? 0) + 1);
  const common = [...perTier].filter(([, n]) => n >= COMMON_TIER_GROUPS).map(([t]) => t).sort((a, b) => a - b);
  if (!common.length) return null;
  const base = patterns.card.value;
  const [tierLow, tierHigh] = [common[0], common[common.length - 1]];
  const [low, high] = [Number(((base * tierLow) / 100).toFixed(2)), Number(((base * tierHigh) / 100).toFixed(2))];
  return { base, tierLow, tierHigh, low, high, smallInside: small.filter(f => f.rate >= low && f.rate <= high).length, smallTotal: small.length };
}

export function fileTerms(scope: RateFileScope): FileTerms {
  const month = MONTHS[Number(scope.networkMonth.slice(4, 6)) - 1] ?? scope.networkMonth;
  return {
    payer: scope.payer, payerShort: PAYER_SHORT[scope.payer] ?? scope.payer, network: scope.network, code: scope.code,
    month, monthShort: month.slice(0, 3), year: scope.networkMonth.slice(0, 4), sessionMinutes: SESSION_MINUTES[scope.code] ?? null,
  };
}

export function campaignOf(scope: RateFileScope, findings: Finding[], patterns: Patterns): Campaign {
  const bandMedian = (band: Finding['band']) => findings.find(f => f.band === band)?.bandMedianPct ?? NaN;
  return { ...fileTerms(scope), smallMedianPct: bandMedian(BANDS[0]), largeMedianPct: bandMedian(BANDS[2]), card: cardRange(findings, patterns) };
}

/** A range in whole dollars that still holds both ends: $106.10 to $148.54 reads as $106 to $149. */
export const dollarRange = (low: number, high: number): [string, string] => [`$${Math.floor(low)}`, `$${Math.ceil(high)}`];
/** To the cent: $163.09. */
export const cents = (x: number) => `$${x.toFixed(2)}`;
/** A percent that may be a half (an even-sized band's median): 86 or 86.5. */
export const pct = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
export const thousands = (n: number) => n.toLocaleString('en-US');

