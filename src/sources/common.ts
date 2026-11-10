import { createHash } from 'node:crypto';
import { REFERRAL_FIELDS, type ReferralAnswer } from '../referral';
import type { LeadEvent, Source, Utm } from '../schema';

export class PayloadError extends Error {}

export const sha = (...parts: unknown[]) => createHash('sha1').update(parts.map(p => String(p ?? '')).join('|')).digest('hex').slice(0, 20);

/** The payload with its object keys sorted at every level, so the same content always serializes to the same text. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/**
 * The idempotency key for a door whose payload carries its own timestamp: the identifying fields plus that timestamp, as before.
 * With no timestamp the key is a SHA-256 of the canonical JSON body. Server time never enters a key, so a re-delivery of the same body
 * is the same event whenever it arrives.
 */
export function eventKey(stamp: unknown, payload: unknown, ...parts: unknown[]): string {
  if (stamp != null && stamp !== '') return sha(...parts, stamp);
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function needObject(p: unknown, what: string): Record<string, any> {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new PayloadError(`${what}: expected a JSON object`);
  return p as Record<string, any>;
}

export function needString(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new PayloadError(`${what} is required`);
  return v;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

export function utmFrom(o: any): Utm {
  if (!o || typeof o !== 'object') return {};
  const g = (k: string) => (typeof o[`utm_${k}`] === 'string' ? o[`utm_${k}`] : typeof o[k] === 'string' ? o[k] : undefined);
  return { source: g('source'), medium: g('medium'), campaign: g('campaign'), content: g('content'), term: g('term') };
}

/**
 * The first field answering "How did you hear about us?" that the object carries, as `{ field, answer }` for
 * ev.context.referral, or null. Carried as given: capture and resolution happen after normalize (src/referral.ts), and
 * nothing here reaches the model (src/qualify/prompt.ts reads only the guide from the context).
 */
export function referralFieldOf(o: unknown): ReferralAnswer | null {
  if (!o || typeof o !== 'object') return null;
  for (const field of REFERRAL_FIELDS) {
    const answer = str((o as Record<string, unknown>)[field]);
    if (answer) return { field, answer: answer.trim() };
  }
  return null;
}

/** `{ referral }` for an adapter's context when any of the objects carries a referral field, else nothing, so other contexts stay as they were. */
export function referralContext(...objects: unknown[]): { referral?: ReferralAnswer } {
  for (const o of objects) {
    const referral = referralFieldOf(o);
    if (referral) return { referral };
  }
  return {};
}

export function isoOr(v: unknown, fallback: string): string {
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return fallback;
}

export function base(source: Source, sourceEventId: string, receivedAt: string, payload: Record<string, any>): LeadEvent {
  return {
    source, sourceEventId, receivedAt, synthetic: payload.synthetic === true,
    email: null, firstName: null, lastName: null, title: null, company: null, state: null, country: null, message: null,
    utm: {}, landingPage: null, referrer: null, context: {}, raw: payload,
  };
}

export type Adapter = (payload: unknown, nowIso: string) => LeadEvent;
