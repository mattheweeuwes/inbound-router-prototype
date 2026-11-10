// The system-gap play's email and LinkedIn line, for the Health Systems team (decision 27). Same rules as the platform
// play's drafts (draft.ts): the templates hold no digits, code inserts every figure from a named field and returns each one,
// and {first_name} stays open. {system} is the registry organization the group belongs to, by an exact link or a person's
// confirmation, never a probable candidate; {group_name} is the file's own name for the group. The draft never names the
// group paid the top rate. No model writes any part of it, and nothing here sends anything.
import { cents, MEETING_MINUTES, pct, thousands, type Campaign } from './campaign';
import { LARGE_ABOVE, type Finding } from './findings';
import { cityGap } from './plays';
import { fill, joinParts, OPEN_PLACEHOLDERS, textOf, type InsertedValue, type Part, type Values } from './template';

const SUBJECT = "{system}'s {payer_short} rate for {code} in {city}: {pct_of_medicare}% of Medicare";
const GREETING = 'Hi {first_name},';
const SENTENCES = [
  "In {payer}'s {month} {network} file, {group_name} ({clinicians} clinicians) is paid {rate} for a {session_minutes}-minute session ({code}), {pct_of_medicare}% of Medicare.",
  'The top rate for the same session in {city} is {city_top_rate}, {gap_pct}% above yours, and groups with more than {large_above} clinicians sit at a median of {band_median_pct}% of Medicare in the same file.',
  'That is one code in one network.',
  'Serif shows the same comparison for every code, payer and service line you contract, next to your peers.',
  'Worth {meeting_minutes} minutes before your next {payer_short} renewal?',
];
const LINKEDIN = "{first_name}, I sent a note on {system}'s {payer_short} rate for {code} in {city} ({pct_of_medicare}% of Medicare, against a top rate of {city_top_rate}) and can send the full comparison if it's useful.";

/** Every template, for the test that they carry no figures of their own. */
export const SYSTEM_GAP_TEMPLATES = [SUBJECT, GREETING, ...SENTENCES, LINKEDIN];

/** Small words a name keeps in lower case, unless it starts with one. */
const LOWER_WORDS = new Set(['of', 'and', 'the', 'for', 'at', 'in', 'on']);
/** Legal suffixes and initials a name keeps in capitals. */
const UPPER_WORDS = new Set(['llc', 'pllc', 'llp', 'lp', 'pa', 'pc', 'psc', 'md', 'do', 'dba', 'ii', 'iii', 'iv']);
/** Abbreviations with no vowel that read as words: "ST LUKES" is "St Lukes". */
const TITLE_WORDS = new Set(['st', 'mt', 'ft', 'dr']);

/**
 * The file's own name in ordinary capitalization: "PECOS VALE PHYSICIANS PLLC" reads "Pecos Vale Physicians PLLC". A word
 * with no vowel ("SSM"), a two-letter word that is not a small English word ("OU", "UT") and a legal suffix stay in capitals.
 */
export function ordinaryName(name: string): string {
  return name.trim().split(/\s+/).map((word, i) => {
    const w = word.toLowerCase();
    const letters = w.replace(/[^a-z]/g, '');
    const upper = !TITLE_WORDS.has(letters) && ((letters.length >= 2 && !/[aeiouy]/.test(letters)) || (letters.length === 2 && !LOWER_WORDS.has(letters)));
    if (UPPER_WORDS.has(letters) || upper) return word.toUpperCase();
    if (i > 0 && LOWER_WORDS.has(w)) return w;
    return w.replace(/(^|[^a-z'])([a-z])/g, (_m, pre: string, c: string) => pre + c.toUpperCase());
  }).join(' ');
}

export interface SystemGapDraft {
  kind: 'draft';
  status: 'ready';
  label: string;
  reason: null;
  /** the platform play's drafts test two hooks; this play has one text, so there is no hook (kept so both drafts read alike) */
  hook: null;
  hookNote: null;
  subject: string;
  body: string;
  linkedin: string;
  /** the same three texts as runs, so each inserted value can be marked where it stands */
  parts: { subject: Part[]; body: Part[]; linkedin: Part[] };
  inserted: InsertedValue[];
  placeholders: string[];
}

export interface SystemGapInput {
  finding: Finding;
  /** the registry organization the group belongs to, and how that is known */
  system: { name: string; how: 'exact' | 'confirmed' };
  campaign: Campaign;
}

function valuesFor(f: Finding, system: SystemGapInput['system'], c: Campaign): Values {
  const gap = cityGap(f);
  if (gap === null) throw new Error(`EIN ${f.ein} holds the top rate in its city; it has no system gap`);
  return {
    system: { value: system.name, field: system.how === 'exact' ? 'rate_links.account_name (an exact name and state match)' : 'rate_link_decisions.account_name (confirmed by a person)' },
    group_name: { value: ordinaryName(f.name), field: 'rate_findings.name (EntityName), in ordinary capitalization' },
    payer: { value: c.payer, field: 'rate_file.payer (Payer)' },
    payer_short: { value: c.payerShort, field: 'rate_file.payer, short form' },
    month: { value: c.month, field: 'rate_file.network_month (NetworkYearMonth)' },
    network: { value: c.network, field: 'rate_file.network (NetworkName)' },
    code: { value: c.code, field: 'rate_file.code (Code)' },
    session_minutes: { value: String(c.sessionMinutes), field: `SESSION_MINUTES for code ${c.code} (constant)` },
    city: { value: f.city, field: 'rate_findings.city (from EntityAddress)' },
    clinicians: { value: thousands(f.clinicians), field: 'rate_findings.clinicians (AllPayerIndividualNPIs)' },
    rate: { value: cents(f.rate), field: 'rate_findings.rate (Rate, the one rate per group)' },
    pct_of_medicare: { value: String(f.pctOfMedicare), field: 'rate_findings.pct_medicare (RelativeToBaseline)' },
    city_top_rate: { value: cents(f.cityTopRate), field: 'rate_findings.city_top_rate (the top rate in the city and state)' },
    gap_pct: { value: String(gap), field: 'city_top_rate over rate, minus one, in whole percent rounded down' },
    large_above: { value: String(LARGE_ABOVE), field: 'size band boundary (constant)' },
    band_median_pct: { value: pct(c.largeMedianPct), field: 'median of rate_findings.pct_medicare, groups over 500 clinicians' },
    meeting_minutes: { value: String(MEETING_MINUTES), field: 'MEETING_MINUTES, the ask (constant)' },
  };
}

const LABEL = 'Draft: the system-gap play. The group belongs to the named system by an exact name match or a person\'s confirmation. A rep reviews it and adds the contact.';

/** Renders the system-gap draft. Call draftUnavailable (draft.ts) first: the email names the session length. */
export function renderSystemGapDraft(i: SystemGapInput): SystemGapDraft {
  const values = valuesFor(i.finding, i.system, i.campaign);
  const used = new Map<string, InsertedValue>();
  const subject = fill(SUBJECT, values, used);
  const sentences = SENTENCES.map(t => fill(t, values, used));
  const body = joinParts([fill(GREETING, values, used), joinParts(sentences, ' ')], '\n\n');
  const linkedin = fill(LINKEDIN, values, used);
  return {
    kind: 'draft', status: 'ready', label: LABEL, reason: null, hook: null, hookNote: null,
    subject: textOf(subject), body: textOf(body), linkedin: textOf(linkedin), parts: { subject, body, linkedin },
    inserted: [...used.values()], placeholders: OPEN_PLACEHOLDERS,
  };
}
