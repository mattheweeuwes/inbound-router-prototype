// Prompt v1. Bump PROMPT_VERSION when anything below changes, so eval runs stay comparable.
import type { LeadEvent, Normalized, Resolution } from '../schema';

export const PROMPT_VERSION = 'v1';

/** Property order matters: `reasons` comes first, so the model writes its reasoning before it decides. */
export const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    reasons: { type: 'string', maxLength: 240 },
    use_case: { type: 'string', enum: ['contract_negotiation', 'rate_benchmarking_market', 'payer_competitive_intel', 'network_design_benefits', 'navigation_find_care', 'data_platform_api', 'life_sciences_access', 'investment_diligence', 'research_media', 'job_seeker', 'vendor_pitch', 'other'] },
    urgency: { type: 'string', enum: ['now', 'this_quarter', 'exploring', 'unknown'] },
    buying_role: { type: 'string', enum: ['decision_maker', 'influencer', 'user', 'unknown'] },
    disqualifier: { type: 'string', enum: ['none', 'job_seeker', 'vendor_pitch', 'student', 'media', 'spam'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['reasons', 'use_case', 'urgency', 'buying_role', 'disqualifier', 'confidence'],
} as const;

export const SYSTEM_PROMPT = `You classify inbound leads for a healthcare price-transparency data company (negotiated-rate data for hospitals, payers, benefits advisors and data teams).
Read the lead and answer with JSON only. Write "reasons" first: one or two short sentences that quote the prospect's own words where you can.

use_case, pick exactly one:
- contract_negotiation: preparing for or renegotiating a payer-provider contract.
- rate_benchmarking_market: wants market or peer rate comparisons, not tied to an active negotiation.
- payer_competitive_intel: a health plan comparing its rates or fee schedules to competing plans.
- network_design_benefits: employer, broker or TPA building or comparing provider networks and benefits.
- navigation_find_care: a care-navigation or cost-estimate product that needs rate data.
- data_platform_api: wants the data by API, feed, warehouse, marketplace listing or license.
- life_sciences_access: pharma or life-sciences market access or pricing work.
- investment_diligence: investor evaluating healthcare companies.
- research_media: student, academic research, reporter or journalist.
- job_seeker: asking about jobs or hiring.
- vendor_pitch: selling their own services to us.
- other: none of the above, or not enough information.

urgency, relative to the date the lead was received:
- now: an explicit need within about 90 days ("next month", "Q1 renewals", "ASAP", "expires", "starts in December").
- this_quarter: about 3 to 6 months out, or a budget or planning cycle ("next spring", "2027 budget").
- exploring: curiosity, evaluation, no timeline.
- unknown: no timing information.

buying_role: decision_maker (director level or above, or owns the budget), influencer (manager level), user (analyst or individual contributor), unknown.
disqualifier: none, job_seeker, vendor_pitch, student, media or spam. Use "none" for anyone who could plausibly buy. Never call a lead a competitor.
confidence: 0 to 1, how sure you are of use_case and urgency.`;

const FEW_SHOT: { user: string; assistant: object }[] = [
  {
    user: 'Received: 2026-03-02 (Monday)\nSource: calendly_demo\nTitle: Director, Provider Contracting\nOrganization type: health_system\nMessage: "Our largest commercial agreement is up for renewal on April 1 and we want to see where our outpatient rates sit against regional peers."',
    assistant: { reasons: 'Quotes "up for renewal on April 1" and wants peer rate comparison: an active renegotiation within 30 days.', use_case: 'contract_negotiation', urgency: 'now', buying_role: 'decision_maker', disqualifier: 'none', confidence: 0.9 },
  },
  {
    user: 'Received: 2026-03-02 (Monday)\nSource: marketplace\nTitle: Senior Data Scientist\nOrganization type: innovator_api_data\nMessage: "Evaluating whether we can pull your hospital rate files into our warehouse through the marketplace listing."',
    assistant: { reasons: 'Wants rate files "into our warehouse" via a listing, no date given: a data/API evaluation.', use_case: 'data_platform_api', urgency: 'exploring', buying_role: 'user', disqualifier: 'none', confidence: 0.8 },
  },
  {
    user: 'Received: 2026-03-02 (Monday)\nSource: calendly_demo\nTitle: Growth Lead\nOrganization type: unknown_org\nMessage: "Can I get 20 minutes to show how our outbound service books meetings for companies like yours?"',
    assistant: { reasons: 'Offers "our outbound service": a sales pitch, not a buyer.', use_case: 'vendor_pitch', urgency: 'unknown', buying_role: 'unknown', disqualifier: 'vendor_pitch', confidence: 0.95 },
  },
];

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function userMessage(ev: LeadEvent, n: Normalized, res: Resolution | null): string {
  const d = new Date(ev.receivedAt);
  const lines = [
    `Received: ${ev.receivedAt.slice(0, 10)} (${DOW[d.getUTCDay()]})`,
    `Source: ${ev.source}`,
    `Title: ${n.title ?? 'unknown'}`,
    `Organization type: ${res?.segment ?? 'unknown'}`,
  ];
  if (ev.context.guide) lines.push(`Guide downloaded: ${ev.context.guide}`);
  lines.push(`Message: "${(n.message ?? '').replace(/"/g, "'")}"`);
  return lines.join('\n');
}

export function buildMessages(ev: LeadEvent, n: Normalized, res: Resolution | null) {
  const msgs: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const s of FEW_SHOT) {
    msgs.push({ role: 'user', content: s.user }, { role: 'assistant', content: JSON.stringify(s.assistant) });
  }
  msgs.push({ role: 'user', content: userMessage(ev, n, res) });
  return msgs;
}
