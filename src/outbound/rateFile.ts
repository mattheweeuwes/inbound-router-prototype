// Serif's rate search export, one CSV row per negotiated rate, read into typed rows the way the take-home's analysis.py
// reads it. Pure: the text in, rows out; the loader stores them.
import { nameNorm } from '../resolve/match';
import { csvRecords } from './csv';

/** The columns this module reads. A file without one of them is refused whole, never half-read. */
export const REQUIRED_COLUMNS = [
  'Payer', 'NetworkName', 'NetworkYearMonth', 'EntityName', 'EIN', 'FilteredNPIListLength', 'PayerSourceNPIListLength',
  'AllPayerIndividualNPIs', 'MostCommonPayerNPITaxonomyName', 'MostCommonPayerNPIRegion', 'EntityAddress', 'Code',
  'PlaceOfServiceList', 'IsBillableClaims', 'Rate', 'IsMostNpisPerEinCode', 'Baseline', 'RelativeToBaseline',
] as const;

export interface RateRow {
  ein: string;
  entity: string;
  nameNorm: string;
  state: string | null;
  /** as written in the file (upper case); titleCase() it for prose */
  city: string;
  taxonomy: string;
  npis: number;
  srcNpis: number;
  orgNpis: number;
  rate: number;
  medicare: number;
  /** RelativeToBaseline as a fraction: 0.97 for "97%" */
  pctMedicare: number;
  mostNpis: boolean;
  claimsEvidence: boolean;
  pos: string;
}

/** What the whole file is about. The export holds one payer, network, month and code; a mixed file is refused. */
export interface RateFileScope { payer: string; network: string; networkMonth: string; code: string }

export interface ParsedRateFile { scope: RateFileScope; rows: RateRow[] }

const money = (s: string, col: string): number => {
  const v = Number(s.replace(/[$,]/g, '').trim());
  if (!s.trim() || !Number.isFinite(v)) throw new Error(`${col} is not an amount: ${JSON.stringify(s)}`);
  return v;
};
const count = (s: string, col: string): number => {
  const v = Number(s.trim());
  if (!s.trim() || !Number.isInteger(v)) throw new Error(`${col} is not a whole number: ${JSON.stringify(s)}`);
  return v;
};
const percent = (s: string, col: string): number => money(s.replace(/%$/, ''), col) / 100;

/**
 * State from the street address (the contracting entity's location), else the payer's NPI region, as analysis.py does.
 * City is the part before the state and ZIP: "6410 FANNIN ST 1500, HOUSTON, TX 77030" is HOUSTON.
 */
export function placeOf(address: string, region: string): { state: string | null; city: string } {
  const m = address.match(/,\s*([A-Z]{2})\s+\d{5}/);
  const parts = address.split(',').map(p => p.trim());
  return { state: m ? m[1] : region.trim() || null, city: parts.length >= 3 ? parts[parts.length - 2] : '' };
}

export function toRateRow(r: Record<string, string>): RateRow {
  const { state, city } = placeOf(r.EntityAddress, r.MostCommonPayerNPIRegion);
  return {
    ein: r.EIN.trim(), entity: r.EntityName.trim(), nameNorm: nameNorm(r.EntityName), state, city, taxonomy: r.MostCommonPayerNPITaxonomyName,
    npis: count(r.FilteredNPIListLength, 'FilteredNPIListLength'), srcNpis: count(r.PayerSourceNPIListLength, 'PayerSourceNPIListLength'),
    orgNpis: count(r.AllPayerIndividualNPIs, 'AllPayerIndividualNPIs'),
    rate: money(r.Rate, 'Rate'), medicare: money(r.Baseline, 'Baseline'), pctMedicare: percent(r.RelativeToBaseline, 'RelativeToBaseline'),
    mostNpis: r.IsMostNpisPerEinCode === 'true', claimsEvidence: r.IsBillableClaims === 'true', pos: r.PlaceOfServiceList,
  };
}

/** Parses the export. Throws with the record number on a missing column, a bad value or a file that mixes payers, networks, months or codes. */
export function parseRateFile(text: string): ParsedRateFile {
  const records = csvRecords(text);
  if (!records.length) throw new Error('the rate file has no rows');
  const missing = REQUIRED_COLUMNS.filter(c => !(c in records[0]));
  if (missing.length) throw new Error(`the rate file is missing ${missing.join(', ')}`);
  const scopes = new Set(records.map(r => [r.Payer, r.NetworkName, r.NetworkYearMonth, r.Code].join('|')));
  if (scopes.size > 1) throw new Error(`the rate file mixes ${scopes.size} payer, network, month and code combinations; this module reads one`);
  const rows = records.map((r, i) => {
    try { return toRateRow(r); } catch (e) { throw new Error(`rate file record ${i + 1}: ${(e as Error).message}`); }
  });
  const first = records[0];
  return { scope: { payer: first.Payer, network: first.NetworkName, networkMonth: first.NetworkYearMonth, code: first.Code }, rows };
}

/** Python's str.title(), which the take-home used for city names: "OKLAHOMA CITY" is "Oklahoma City". */
export const titleCase = (s: string) => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, pre: string, c: string) => pre + c.toUpperCase());
