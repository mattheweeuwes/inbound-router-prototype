// Named referrals (decision 26). Serif says inbound referral is its main source of conversion, and until now the router's only
// notion of a referral was a web referrer or a UTM medium. A referral here is a person or an organization the prospect names:
// in an answer to "How did you hear about us?" (or a form field for it), or in their message ("the contracting VP at
// Wrenfield Health recommended you"). Rules only: none of this goes to the model, and none of it is in the hashed classifier.
// Capture and resolution are pure functions; src/leadSignals.ts supplies the lookups (the CRM mirror, the registry matcher, owners).
import type { CrmRequest } from './schema';

/** How the referral was found: a form answer, or one of the message patterns. */
export type ReferralCue = 'form_answer' | 'referred_by' | 'recommended_by' | 'recommended_you' | 'heard_from' | 'told_us' | 'suggested';

/** What a door carried for "How did you hear about us?": the field or question it came from, and the answer as typed. */
export interface ReferralAnswer { field: string; answer: string }

export interface ReferralCapture {
  cue: ReferralCue;
  /** the answer, or the sentence of the message, as written */
  text: string;
  /** the words naming who referred them ("The contracting VP at Wrenfield Health") */
  referrer: string;
}

/** The referring organization, when the words name one the router knows. */
export interface ReferrerAccount {
  key: string;
  name: string;
  /** the account is a customer in the CRM */
  customer: boolean;
  /** the account's owner: the CRM owner, or a rep who claimed it; null when nobody owns it */
  owner: string | null;
  matchedBy: 'crm' | 'registry';
}

export type ReferralKind = 'customer' | 'known_org' | 'unknown_org';

/** What is stored on the lead (leads.referral_json). */
export interface Referral {
  cue: ReferralCue;
  text: string;
  referrer: string;
  account: ReferrerAccount | null;
  kind: ReferralKind;
  points: number;
}

/**
 * What leads.referral_json holds: the referral, and, when the referring account has an owner, the dry-run HubSpot plan for
 * that owner's thank-you task (src/crm/hubspot.ts planReferralThanks). The plan is shown, never sent.
 */
export interface StoredReferral extends Referral {
  thanks: { mode: 'dry_run'; requests: CrmRequest[] } | null;
}

/** Hand-set starting weights, like every other weight in src/score.ts: closed-won data would be needed to fit them. */
export const REFERRAL_POINTS: Record<ReferralKind, number> = { customer: 10, known_org: 6, unknown_org: 3 };

// ---- capture ---------------------------------------------------------------------------------------------------------

/** Form fields a door may carry the answer in. */
export const REFERRAL_FIELDS = ['referred_by', 'referral', 'how_did_you_hear', 'how_did_you_hear_about_us'] as const;
/** A booking question that asks for it. */
export const REFERRAL_QUESTION = /hear (?:about|of)|how did you find|referr|who sent you/i;

/** The answer a door carried, from the context the adapters fill (ev.context.referral), or null. */
export function referralAnswerOf(context: Record<string, unknown>): ReferralAnswer | null {
  const r = context.referral;
  if (!r || typeof r !== 'object') return null;
  const { field, answer } = r as Record<string, unknown>;
  return typeof field === 'string' && typeof answer === 'string' && answer.trim() ? { field, answer: answer.trim() } : null;
}

// An answer to "How did you hear about us?" is often a channel, not a referral. It counts as a referral when it uses a referral
// word, or when it names no channel at all (a bare organization name, say).
const REFERRAL_WORDS = /\b(?:referr\w*|recommend\w*|colleague|friend|peer|word of mouth|told|introduc\w*|customer|client)\b/i;
const CHANNEL_WORDS = /\b(?:google|bing|search|linkedin|twitter|facebook|instagram|youtube|reddit|podcast|webinar|conference|trade show|booth|event|ads?|advert\w*|newsletter|email|blog|article|press|news|website|online|other|n\/a|none)\b/i;
const ANSWER_LEAD_IN = /^(?:a\s+)?(?:referral|referred|recommendation|recommended)\s+(?:from|by)\s+/i;

// The words that name the referrer stop at the end of the clause.
const CLAUSE_END = /,|\s+(?:and|but|so|because|who|which|when|since|after)\s+/i;
const lastClause = (s: string) => s.split(CLAUSE_END).filter(Boolean).pop()?.trim() ?? '';
const firstClause = (s: string) => s.split(CLAUSE_END)[0]?.trim() ?? '';

/** Words that name nobody outside the prospect's own team, so they are not a referral. */
const NOT_A_REFERRER = /^(?:we|i|you|they|it|he|she|nobody|no one|none|anyone|anybody|our team|my team|us|me)$/i;
const REFERRER_MAX = 100;

const MESSAGE_PATTERNS: { cue: ReferralCue; re: RegExp; side: 'after' | 'before' }[] = [
  { cue: 'referred_by', re: /\breferred\s+(?:us\s+|me\s+)?(?:to\s+(?:you|serif)\s+)?by\s+(.+)$/i, side: 'after' },
  { cue: 'recommended_by', re: /\brecommended\s+(?:to\s+(?:us|me)\s+)?by\s+(.+)$/i, side: 'after' },
  { cue: 'heard_from', re: /\bheard\s+(?:about|of)\s+(?:you|serif|your\s+[\w-]+)\s+(?:from|through|via)\s+(.+)$/i, side: 'after' },
  { cue: 'recommended_you', re: /^(.+?)\s+(?:has\s+|had\s+|have\s+)?recommended\s+(?:you|serif|your\s+[\w-]+)\b/i, side: 'before' },
  { cue: 'told_us', re: /^(.+?)\s+told\s+(?:us|me|our\s+[\w-]+)\s+to\s+(?:reach out|contact you|talk to you|get in touch|call you|speak (?:to|with) you|look at (?:you|serif))/i, side: 'before' },
  // "suggested" alone is too common ("our CFO suggested we benchmark"), so it counts only when what was suggested is Serif
  { cue: 'suggested', re: /^(.+?)\s+suggested\s+(?:(?:that\s+)?(?:we|i)\s+(?:reach out|contact you|talk to you|get in touch|speak (?:to|with) you|look at (?:you|serif))|(?:you|serif)\b)/i, side: 'before' },
];

/** The referrer words, trimmed to the clause that names them, or null when they name nobody outside the prospect's team. */
function referrerWords(raw: string, side: 'after' | 'before'): string | null {
  const words = (side === 'after' ? firstClause(raw) : lastClause(raw)).replace(/^["'\s]+|["'\s]+$/g, '');
  if (!words || NOT_A_REFERRER.test(words)) return null;
  return words.slice(0, REFERRER_MAX);
}

/** The answer to "How did you hear about us?" as a capture, or null when it names a channel rather than a referrer. */
export function captureAnswer(a: ReferralAnswer): ReferralCapture | null {
  const named = a.field === 'referred_by';
  if (!named && !REFERRAL_WORDS.test(a.answer) && CHANNEL_WORDS.test(a.answer)) return null;
  const referrer = referrerWords(a.answer.replace(ANSWER_LEAD_IN, ''), 'after');
  return referrer ? { cue: 'form_answer', text: a.answer, referrer } : null;
}

/** Referral phrases in the message, one per sentence, in the order written. */
export function captureMessage(message: string | null): ReferralCapture[] {
  if (!message) return [];
  const out: ReferralCapture[] = [];
  for (const sentence of message.split(/(?<=[.!?;])\s+|\n+/).map(s => s.trim()).filter(Boolean)) {
    const body = sentence.replace(/[.!?;]+$/, '');
    for (const p of MESSAGE_PATTERNS) {
      const m = p.re.exec(body);
      const referrer = m ? referrerWords(m[1], p.side) : null;
      if (referrer) { out.push({ cue: p.cue, text: sentence, referrer }); break; }
    }
  }
  return out;
}

/** Every referral the lead carries: the form answer first, then the message. */
export function captureReferrals(answer: ReferralAnswer | null, message: string | null): ReferralCapture[] {
  const fromAnswer = answer ? captureAnswer(answer) : null;
  return [...(fromAnswer ? [fromAnswer] : []), ...captureMessage(message)];
}

// ---- which organization ----------------------------------------------------------------------------------------------

/**
 * The names to try for the referring organization, most specific first: the words after the last "at", "from" or "of"
 * ("the managed care team at Emory" gives "Emory"), the owner of a possessive ("Emory's managed care team"), then the
 * whole phrase without a leading article.
 */
export function orgCandidates(referrer: string): string[] {
  const out: string[] = [];
  for (const sep of [' at ', ' from ', ' of ', ' with ']) {
    const i = referrer.toLowerCase().lastIndexOf(sep);
    if (i >= 0) out.push(referrer.slice(i + sep.length));
  }
  const possessive = referrer.match(/^(?:the\s+)?(.+?)['’]s\b/i);
  if (possessive) out.push(possessive[1]);
  out.push(referrer.replace(/^(?:the|a|an|our|my)\s+/i, ''));
  return [...new Set(out.map(s => s.trim()).filter(Boolean))];
}

/** What resolving a referrer needs from the world, supplied by the caller so this stays pure. */
export interface ReferrerLookups {
  /** the CRM account whose name the words contain (fixtures/crm-mirror.json, matched as the router matches a company) */
  crm(words: string): ReferrerAccount | null;
  /** a unique, strong registry match for a name, with its owner and customer status; null on a tie or a weak match */
  registry(name: string): ReferrerAccount | null;
}

const kindOf = (account: ReferrerAccount | null): ReferralKind => (!account ? 'unknown_org' : account.customer ? 'customer' : 'known_org');

/**
 * The lead's referral: the first capture whose referrer resolves to an organization (the CRM's fictional customers first,
 * then the registry, confident matches only), or else the first capture with the referrer unknown. A referrer at the lead's
 * own account is a colleague, not a referral, and is skipped.
 */
export function resolveReferral(captures: ReferralCapture[], lookups: ReferrerLookups, ownAccountKey: string | null): Referral | null {
  let unresolved: ReferralCapture | null = null;
  for (const c of captures) {
    const account = lookups.crm(c.referrer) ?? orgCandidates(c.referrer).map(n => lookups.registry(n)).find(a => !!a) ?? null;
    if (account && account.key === ownAccountKey) continue;
    if (account) return referralOf(c, account);
    unresolved ??= c;
  }
  return unresolved ? referralOf(unresolved, null) : null;
}

function referralOf(c: ReferralCapture, account: ReferrerAccount | null): Referral {
  const kind = kindOf(account);
  return { cue: c.cue, text: c.text, referrer: c.referrer, account, kind, points: REFERRAL_POINTS[kind] };
}

const KIND_TEXT: Record<ReferralKind, string> = { customer: 'a customer', known_org: 'not a customer', unknown_org: 'organization not identified' };

/** The itemized score line: "Referral: Wrenfield Health (a customer)". */
export const referralScoreLabel = (r: Referral) => `Referral: ${r.account?.name ?? `"${r.referrer}"`} (${KIND_TEXT[r.kind]})`;

/** The brief's referral line: who, whether a customer and whose account, and the words it came from. */
export function referralLine(r: Referral): string {
  const who = r.account
    ? `${r.account.name}, ${r.account.customer ? 'a customer' : 'not a customer'}${r.account.owner ? ` owned by ${r.account.owner}` : ''}`
    : 'referrer unknown';
  return `Referral: ${who} ("${r.text}")`;
}
