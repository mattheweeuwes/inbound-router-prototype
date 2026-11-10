// calendly_demo: "Book a Demo" (Calendly v2 invitee.created-like payload).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { splitName } from '../normalize';
import { base, isoOr, needObject, needString, str, utmFrom, type Adapter } from './common';
import { REFERRAL_QUESTION, type ReferralAnswer } from '../referral';
import type { LeadEvent } from '../schema';

const answer = (qa: any[], re: RegExp): string | null => {
  for (const x of qa) if (x && typeof x.question === 'string' && re.test(x.question) && typeof x.answer === 'string' && x.answer.trim()) return x.answer.trim();
  return null;
};

/** A booking question such as "How did you hear about us?", carried as ev.context.referral like a form's field. */
function referralQuestion(qa: any[]): { referral?: ReferralAnswer } {
  for (const x of qa) {
    if (x && typeof x.question === 'string' && REFERRAL_QUESTION.test(x.question) && typeof x.answer === 'string' && x.answer.trim()) {
      return { referral: { field: x.question.trim(), answer: x.answer.trim() } };
    }
  }
  return {};
}

export const calendly: Adapter = (payload, nowIso): LeadEvent => {
  const p = needObject(payload, 'calendly payload');
  const inv = needObject(p.payload, 'calendly payload.payload');
  const uri = needString(inv.uri, 'payload.uri');
  const email = needString(inv.email, 'payload.email');
  const qa: any[] = Array.isArray(inv.questions_and_answers) ? inv.questions_and_answers : [];
  const sp = splitName(str(inv.name));
  const ev = base('calendly_demo', uri, isoOr(inv.created_at, nowIso), p);
  ev.email = email;
  ev.firstName = str(inv.first_name) ?? sp.first;
  ev.lastName = str(inv.last_name) ?? sp.last;
  ev.title = answer(qa, /title|role/i);
  ev.company = answer(qa, /company|organi[sz]ation|employer/i);
  ev.state = answer(qa, /\bstate\b/i);
  ev.message = answer(qa, /see|help|anything|share|looking|message|notes|discuss/i);
  ev.utm = utmFrom(inv.tracking);
  ev.landingPage = str(inv.tracking?.landing_page);
  ev.context = { eventName: inv.scheduled_event?.name ?? null, startTime: inv.scheduled_event?.start_time ?? null, ...referralQuestion(qa) };
  return ev;
};

/** Calendly-Webhook-Signature: t=<ts>,v1=<hex hmac_sha256(key, t + '.' + body)> */
export function signCalendly(key: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', key).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export function verifyCalendly(key: string, body: string, header: string | null, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): { ok: boolean; reason?: string } {
  if (!header) return { ok: false, reason: 'missing Calendly-Webhook-Signature header' };
  const parts = Object.fromEntries(header.split(',').map(s => s.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!parts.t || !parts.v1 || Number.isNaN(t)) return { ok: false, reason: 'malformed signature header' };
  if (Math.abs(nowSec - t) > toleranceSec) return { ok: false, reason: 'signature timestamp outside tolerance' };
  const expected = createHmac('sha256', key).update(`${parts.t}.${body}`).digest();
  let given: Buffer;
  try { given = Buffer.from(parts.v1, 'hex'); } catch { return { ok: false, reason: 'bad hex' }; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}
