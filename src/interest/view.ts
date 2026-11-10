// Feature interest as the attribution API serves it: per feature, how many leads and accounts showed interest, how, and the
// list of who asked, newest first. This is the list customer success works from when a feature launches. Reads the tag rows
// (src/store/interest.ts) and shapes them; it decides nothing, and nothing that scores or routes reads it.
import type { Ctx } from '../context';
import { isCustomerAccount, ownerOf } from '../accounts';
import { cutNote } from '../lists';
import type { Source } from '../schema';
import type { InterestRow } from '../store/interest';
import { CUE_KINDS, type CueKind } from './cues';

/** The longest quote of a message the asked list carries. */
export const QUOTE_CHARS = 220;
/** The most people one feature's asked list shows; the interest counts say how many there are in all. */
export const ASKED_LIMIT = 50;

export type TierMix = Record<'A' | 'B' | 'C' | 'D' | 'X' | 'pending', number>;

export interface FeatureInterest {
  /** people who showed interest: one per contact, so a repeat contact counts once */
  leads: number;
  /** distinct accounts those people belong to; a person the router could not place adds none */
  accounts: number;
  /** tier A or B, the dashboard's sales-ready */
  salesReady: number;
  byTier: TierMix;
  /** people per cue kind; one person can show more than one */
  byCue: Record<CueKind, number>;
  /** of the people, those who came in at or after the feature's launch; null when it has none */
  sinceLaunch: number | null;
}

export interface AskedItem {
  leadId: string;
  accountKey: string | null;
  accountName: string | null;
  /** the CRM owner, else the rep who claimed the account on a rep alert */
  owner: string | null;
  customer: boolean;
  /** null for an account-level web visit, which has no person */
  person: { name: string; title: string | null } | null;
  door: Source;
  /** the strongest way they showed it, and every way they did */
  cue: CueKind;
  cues: CueKind[];
  evidence: string[];
  /** their own words, cut at QUOTE_CHARS; null when the interest came from the door, a guide or a page */
  quote: string | null;
  at: string;
}

/** One person's rows for one feature: their newest lead, and every cue across their leads. */
interface Asker { rows: InterestRow[] }

const emptyTiers = (): TierMix => ({ A: 0, B: 0, C: 0, D: 0, X: 0, pending: 0 });
const tierOf = (t: string | null): keyof TierMix => (t === 'A' || t === 'B' || t === 'C' || t === 'D' || t === 'X' ? t : 'pending');
const isCue = (c: string): c is CueKind => (CUE_KINDS as readonly string[]).includes(c);

/** The rows of one feature grouped by person, newest first (the rows arrive newest first, and the group keeps that order). */
function askers(rows: readonly InterestRow[]): Asker[] {
  const by = new Map<string, Asker>();
  for (const r of rows) {
    const key = r.contact_key ?? r.lead_id;
    const a = by.get(key) ?? { rows: [] };
    a.rows.push(r);
    by.set(key, a);
  }
  return [...by.values()];
}

/** The counts for one feature's rows. `launchedAt` is the feature's launch time, or null when it has not launched. */
export function interestOf(rows: readonly InterestRow[], launchedAt: string | null): FeatureInterest {
  const people = askers(rows);
  const byTier = emptyTiers();
  const byCue: Record<CueKind, number> = { message: 0, door: 0, path: 0, guide: 0 };
  const accounts = new Set<string>();
  for (const { rows: mine } of people) {
    const newest = mine[0];
    byTier[tierOf(newest.tier)]++;
    if (newest.account_id) accounts.add(newest.account_id);
    for (const cue of new Set(mine.map(r => r.cue))) if (isCue(cue)) byCue[cue]++;
  }
  return {
    leads: people.length, accounts: accounts.size, salesReady: byTier.A + byTier.B, byTier, byCue,
    sinceLaunch: launchedAt === null ? null : people.filter(a => a.rows[0].received_at >= launchedAt).length,
  };
}

/** One person as the asked list shows them. Owner and customer come from the CRM mirror and the account, as the accounts API reads them. */
function askedItem(ctx: Ctx, a: Asker): AskedItem {
  const r = a.rows[0];
  const domain = r.account_domain ?? r.company_domain;
  const name = r.account_name ?? r.company_name_raw;
  const cues = CUE_KINDS.filter(c => a.rows.some(x => x.cue === c));
  const personName = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email;
  return {
    leadId: r.lead_id, accountKey: r.account_id, accountName: name,
    owner: ownerOf(ctx, { domain, name, claimed_owner: r.claimed_owner }).owner,
    customer: isCustomerAccount(ctx, { domain, name }),
    person: r.source === 'web_intent' || !personName ? null : { name: personName, title: r.title },
    door: r.source, cue: cues[0], cues, evidence: [...new Set(cues.flatMap(c => a.rows.filter(x => x.cue === c).map(x => x.evidence)))],
    quote: cutNote(a.rows.find(x => x.cue === 'message')?.message ?? null, QUOTE_CHARS), at: r.received_at,
  };
}

/** The people who asked, newest first, at most ASKED_LIMIT. */
export const askedOf = (ctx: Ctx, rows: readonly InterestRow[]): AskedItem[] => askers(rows).slice(0, ASKED_LIMIT).map(a => askedItem(ctx, a));

/** The tag rows grouped by feature key. */
export function groupByFeature(rows: readonly InterestRow[]): Map<string, InterestRow[]> {
  const by = new Map<string, InterestRow[]>();
  for (const r of rows) by.set(r.feature, [...(by.get(r.feature) ?? []), r]);
  return by;
}

/** How much of the interest the page shows is invented: the distinct people behind every tag, and how many of them are synthetic. */
export function interestProvenance(rows: readonly InterestRow[]) {
  const people = new Map<string, boolean>();
  for (const r of rows) people.set(r.contact_key ?? r.lead_id, !!r.synthetic);
  const synthetic = [...people.values()].filter(Boolean).length;
  return { leads: people.size, synthetic, allSynthetic: people.size === synthetic };
}
