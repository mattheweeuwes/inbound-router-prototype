// The take-home's outbound email (a subject and five sentences) and its one-line LinkedIn follow-up, rendered from one
// group's finding. Code inserts every figure: the templates below hold no digits, each {placeholder} is filled from a named
// field, and the draft returns every value it inserted with the field it came from. No model writes any part of it.
// {first_name} stays a placeholder: the rate file names organizations, not people, and there are no contacts.
// Nothing here sends anything; there is no email code in this project.
import { createHash } from 'node:crypto';
import { cents, dollarRange, LEVERAGE_PCT, MEETING_MINUTES, pct, thousands, type Campaign } from './campaign';
import { LARGE_ABOVE, SMALL_MAX, type Finding } from './findings';
import { stateName } from './states';
import type { DraftStatus } from './targeting';

/** The two hooks the take-home tests against each other: hospital leverage, and the rate range small groups sit in. */
export const HOOKS = ['hospital_leverage', 'rate_range'] as const;
export type Hook = typeof HOOKS[number];

/** Each EIN always gets the same hook, half and half across the file, so a reply rate can be compared per hook. */
export function hookFor(ein: string): Hook {
  return HOOKS[createHash('sha256').update(ein).digest()[0] % 2];
}

const SUBJECT = "{platform}'s {payer_short} rate in {state_name}: {pct_of_medicare}% of Medicare";
const GREETING = 'Hi {first_name},';
const FACT = "In {payer}'s {month} {network} file, {platform}'s {state_name} entity ({clinicians} clinicians) is paid {rate} for a {session_minutes}-minute session ({code}), {pct_of_medicare}% of Medicare.";
const HOOK_SENTENCES: Record<Hook, [string, string]> = {
  rate_range: [
    'That is {range_position} the {range_low} to {range_high} range where {small_share} small psychiatry groups sit, which looks like one {payer_short} fee schedule paid at {tier_low}% to {tier_high}%.',
    'Every large group above {leverage_pct}% of Medicare in the file is a hospital system or academic medical center.',
  ],
  hospital_leverage: [
    'Groups with more than {large_above} clinicians are paid a median of {large_median_pct}% of Medicare in the same file, and every one above {leverage_pct}% is a hospital system or academic medical center.',
    'Groups with {small_max} or fewer clinicians sit at a median of {small_median_pct}%, so in this network scale without a hospital has not earned system rates.',
  ],
};
const PRODUCT = "Serif shows each of your entities' rates next to their peers', payer by payer and state by state, and Signal Watch emails you when one changes.";
const ASK = 'Worth {meeting_minutes} minutes before your next {payer_short} renewal?';
const LINKEDIN: Record<Hook, string> = {
  hospital_leverage: "{first_name}, I sent a note on {platform}'s {payer_short} rates ({pct_of_medicare}% of Medicare in {state_name}, while every large group above {leverage_pct}% there is a hospital system or academic medical center) and can send the state-by-state view if it's useful.",
  rate_range: "{first_name}, I sent a note on {platform}'s {payer_short} rates ({pct_of_medicare}% of Medicare in {state_name}, {range_position} the {range_low} to {range_high} range where {small_share} small groups sit) and can send the state-by-state view if it's useful.",
};

/** Every template, for the test that they carry no figures of their own. */
export const TEMPLATES = [SUBJECT, GREETING, FACT, ...HOOK_SENTENCES.rate_range, ...HOOK_SENTENCES.hospital_leverage, PRODUCT, ASK, ...Object.values(LINKEDIN)];

/** The placeholders left for a person to fill. */
export const OPEN_PLACEHOLDERS = ['{first_name}'];

export interface InsertedValue { placeholder: string; value: string; field: string }

export interface Draft {
  /** a draft is for a target; a preview is any other group, for reading only */
  kind: 'draft' | 'preview';
  status: 'ready' | 'blocked' | 'preview';
  label: string;
  /** why a draft is blocked */
  reason: string | null;
  hook: Hook;
  /** set when the assigned hook could not be used and the other one was */
  hookNote: string | null;
  subject: string;
  body: string;
  linkedin: string;
  inserted: InsertedValue[];
  placeholders: string[];
}

export interface DraftInput {
  finding: Finding;
  /** the mapped platform's name; null renders a preview under the group's own name */
  platform: string | null;
  status: DraftStatus;
  reason: string | null;
  hook: Hook;
  campaign: Campaign;
}

/** Why no draft can be rendered from this file at all, or null when one can. */
export function draftUnavailable(c: Campaign): string | null {
  return c.sessionMinutes === null ? `no session length is known for code ${c.code}, and the email names it` : null;
}

type Values = Record<string, { value: string; field: string }>;

function valuesFor(f: Finding, platform: string | null, c: Campaign): Values {
  const v: Values = {
    platform: platform
      ? { value: platform, field: 'fixtures/outbound-platforms.json: platform' }
      : { value: f.name, field: 'rate_findings.name (EntityName; a preview has no platform mapping)' },
    payer: { value: c.payer, field: 'rate_file.payer (Payer)' },
    payer_short: { value: c.payerShort, field: 'rate_file.payer, short form' },
    month: { value: c.month, field: 'rate_file.network_month (NetworkYearMonth)' },
    network: { value: c.network, field: 'rate_file.network (NetworkName)' },
    code: { value: c.code, field: 'rate_file.code (Code)' },
    session_minutes: { value: String(c.sessionMinutes), field: `SESSION_MINUTES for code ${c.code} (constant)` },
    state_name: { value: stateName(f.state), field: 'rate_findings.state (from EntityAddress)' },
    clinicians: { value: thousands(f.clinicians), field: 'rate_findings.clinicians (AllPayerIndividualNPIs)' },
    rate: { value: cents(f.rate), field: 'rate_findings.rate (Rate, the one rate per group)' },
    pct_of_medicare: { value: String(f.pctOfMedicare), field: 'rate_findings.pct_medicare (RelativeToBaseline)' },
    leverage_pct: { value: String(LEVERAGE_PCT), field: 'LEVERAGE_PCT: a reading of the group names in the Aug 2026 file (constant)' },
    large_above: { value: String(LARGE_ABOVE), field: 'size band boundary (constant)' },
    small_max: { value: String(SMALL_MAX), field: 'size band boundary (constant)' },
    large_median_pct: { value: pct(c.largeMedianPct), field: 'median of rate_findings.pct_medicare, groups over 500 clinicians' },
    small_median_pct: { value: pct(c.smallMedianPct), field: 'median of rate_findings.pct_medicare, groups of 50 or fewer' },
    meeting_minutes: { value: String(MEETING_MINUTES), field: 'MEETING_MINUTES, the ask (constant)' },
  };
  if (c.card) {
    const r = c.card;
    const position = f.rate < r.low ? 'below' : f.rate > r.high ? 'above' : 'inside';
    const share = r.smallInside * 2 > r.smallTotal ? 'most' : `${r.smallInside} of the ${r.smallTotal}`;
    const [low, high] = dollarRange(r.low, r.high);
    Object.assign(v, {
      range_position: { value: position, field: `rate_findings.rate against ${cents(r.low)} to ${cents(r.high)}` },
      range_low: { value: low, field: `rate_patterns card base ${cents(r.base)} x ${r.tierLow}%, rounded down` },
      range_high: { value: high, field: `rate_patterns card base ${cents(r.base)} x ${r.tierHigh}%, rounded up` },
      tier_low: { value: String(r.tierLow), field: 'lowest card tier two or more small groups share' },
      tier_high: { value: String(r.tierHigh), field: 'highest card tier two or more small groups share' },
      small_share: { value: share, field: `small groups paid inside the range: ${r.smallInside} of ${r.smallTotal}` },
    });
  }
  return v;
}

/** Fills each {placeholder} from values and records it once, in order of first use. {first_name} is left as it is. */
function fill(template: string, values: Values, used: Map<string, InsertedValue>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    if (OPEN_PLACEHOLDERS.includes(whole)) return whole;
    const v = values[key];
    if (!v) throw new Error(`no value for ${whole}`);
    if (!used.has(key)) used.set(key, { placeholder: whole, value: v.value, field: v.field });
    return v.value;
  });
}

const LABELS: Record<DraftStatus, string> = {
  ready: 'Draft: the platform mapping is confirmed. A rep reviews it and adds the contact; nothing is sent from here.',
  blocked: 'Draft, blocked: the platform mapping is not confirmed, so it cannot go out under the platform\'s name.',
  none: 'Preview only: this group is not a target. For reading, not for sending.',
};

/** Renders the draft (a target) or preview (any other group). Call draftUnavailable first. */
export function renderDraft(i: DraftInput): Draft {
  const { finding, campaign } = i;
  const hook: Hook = i.hook === 'rate_range' && !campaign.card ? 'hospital_leverage' : i.hook;
  const hookNote = hook !== i.hook ? 'this file shows no card range, which the rate-range hook needs, so the hospital-leverage hook is used' : null;
  const values = valuesFor(finding, i.status === 'none' ? null : i.platform, campaign);
  const used = new Map<string, InsertedValue>();
  const subject = fill(SUBJECT, values, used);
  const sentences = [FACT, ...HOOK_SENTENCES[hook], PRODUCT, ASK].map(t => fill(t, values, used));
  const body = `${fill(GREETING, values, used)}\n\n${sentences.join(' ')}`;
  const linkedin = fill(LINKEDIN[hook], values, used);
  return {
    kind: i.status === 'none' ? 'preview' : 'draft', status: i.status === 'none' ? 'preview' : i.status, label: LABELS[i.status],
    reason: i.reason, hook, hookNote, subject, body, linkedin, inserted: [...used.values()], placeholders: OPEN_PLACEHOLDERS,
  };
}
