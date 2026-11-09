// Builds source-shaped webhook payloads from a plain spec. Used by the demo form and by scripts/gen-fixtures.ts.
import { createHash } from 'node:crypto';
import type { Source, Utm } from './schema';

export interface PayloadSpec {
  first: string; last: string; email: string; title?: string; company?: string; state?: string; message?: string;
  ts: string; // ISO
  utm?: Utm;
  guide?: string; formId?: string; pageUrl?: string;
  usage?: { event: 'session_start' | 'search'; code?: string; payer?: string; market?: string; at: string }[];
  marketplace?: string; listing?: string; product?: 'neuron' | 'find_care' | 'mcp';
  event?: string; notes?: string;
  seed?: string; // makes ids deterministic
}

const h = (s: string, n = 12) => createHash('sha1').update(s).digest('hex').slice(0, n);

export const UTM_PRESETS: Record<string, Utm> = {
  linkedin_paid: { source: 'LinkedIn ', medium: 'Paid-Social', campaign: 'hs-contracting-q4' },
  google_cpc: { source: 'google', medium: 'cpc', campaign: 'brand' },
  newsletter: { source: 'newsletter', medium: 'email', campaign: 'monthly-digest' },
  organic: { source: 'google', medium: 'organic' },
  none: {},
};

const utmObj = (u?: Utm) => (u ? Object.fromEntries(Object.entries({ utm_source: u.source, utm_medium: u.medium, utm_campaign: u.campaign, utm_content: u.content, utm_term: u.term }).filter(([, v]) => v !== undefined)) : {});

export function buildPayload(source: Source, s: PayloadSpec): Record<string, unknown> {
  const name = `${s.first} ${s.last}`;
  const seed = s.seed ?? `${s.email}|${s.ts}`;
  switch (source) {
    case 'calendly_demo':
      return {
        event: 'invitee.created', synthetic: true,
        payload: {
          uri: `https://api.calendly.com/scheduled_events/${h(seed + 'e', 8)}/invitees/${h(seed + 'i', 8)}`,
          email: s.email, name, first_name: s.first, last_name: s.last, created_at: s.ts,
          questions_and_answers: [
            { question: 'Job title', answer: s.title ?? '' },
            { question: 'Company', answer: s.company ?? '' },
            { question: 'State', answer: s.state ?? '' },
            { question: 'What would you like to see in the demo?', answer: s.message ?? '' },
          ],
          tracking: utmObj(s.utm),
          scheduled_event: { name: 'Signal demo (30 min)', start_time: new Date(Date.parse(s.ts) + 2 * 86_400_000).toISOString() },
        },
      };
    case 'guide_download':
    case 'signal_ask_waitlist':
      return {
        synthetic: true,
        form_id: source === 'signal_ask_waitlist' ? 'signal_ask' : (s.formId ?? 'guide_download'),
        ...(s.guide ? { guide: s.guide } : {}),
        fields: { email: s.email, firstname: s.first, lastname: s.last, jobtitle: s.title ?? '', company: s.company ?? '', state: s.state ?? '', ...(s.message ? { message: s.message } : {}) },
        page_url: s.pageUrl ?? 'https://example.org/prototype/resources', utm: utmObj(s.utm), submitted_at: s.ts,
      };
    case 'sample_signup':
      return { synthetic: true, user: { email: s.email, name, title: s.title ?? '', company: s.company ?? '', ...(s.state ? { state: s.state } : {}) }, signed_up_at: s.ts, ...(s.message ? { message: s.message } : {}), usage: s.usage ?? [{ event: 'session_start', at: s.ts }], utm: utmObj(s.utm) };
    case 'marketplace':
      return { synthetic: true, marketplace: s.marketplace ?? 'Databricks', listing: s.listing ?? 'Price transparency dataset (prototype listing)', requester: { email: s.email, name, title: s.title ?? '', company: s.company ?? '', ...(s.state ? { state: s.state } : {}) }, message: s.message ?? '', received_at: s.ts };
    case 'api_key':
      return { synthetic: true, developer: { email: s.email, name, title: s.title ?? '', company: s.company ?? '', ...(s.state ? { state: s.state } : {}) }, product: s.product ?? 'mcp', created_at: s.ts, ...(s.message ? { message: s.message } : {}) };
    case 'event_scan':
      return { synthetic: true, event: s.event ?? 'HFMA', scanned_at: s.ts, badge: { email: s.email, first: s.first, last: s.last, title: s.title ?? '', company: s.company ?? '', state: s.state ?? '' }, notes: s.notes ?? s.message ?? '' };
    case 'web_intent':
      throw new Error('web_intent is account-level; build it by hand');
  }
}
