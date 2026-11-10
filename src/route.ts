// Ordered routing rules R1..R10. First match wins; every decision records the rule and a one-line reason. R10 (an enterprise
// deal, decision 25) runs after R5 and R6 and before the tier gate in R8; the ids are labels, not the order.
import type { CrmMirrorEntry, LeadEvent, Normalized, Owners, Qualification, Resolution, Route, Score, Segment, Team, UseCase } from './schema';
import { cueClause } from './dealCues';
import type { Doubt } from './decisions';
import { confidentSalesOrg, NO_DEAL_SIGNALS, type DealSignals } from './enterprise';
import { PERSON_DECIDES_IF_MODEL_ONLY } from './qualify/combine';
import { addBusinessMinutes, iso, isBusinessTime, nextBusinessOpen } from './time';

export interface DuplicateInfo { leadId: string; owner: string; team: Team; lastAlertAt: string | null }
export interface Rep { name: string; hubspotOwnerId: string }

export interface RouteInput {
  ev: LeadEvent;
  n: Normalized;
  res: Resolution;
  qual: Qualification;
  score: Score;
  duplicate: DuplicateInfo | null;
  mirror: CrmMirrorEntry | null;
  claimedOwner?: string | null; // accounts.owner: set when an earlier lead's rep alert claimed the account
  owners: Owners;
  pickRep: (team: Team) => Rep | null;
  /** the account's size and the message's deal-size cues (src/enterprise.ts, src/dealCues.ts); none when absent */
  deal?: DealSignals;
  /** the lead came through a list door (decision 24): it stays in its list's digest, enterprise or not */
  listDoor?: boolean;
}

/** The marketing lead who owns every nurture, careers and press route, and a person's not-for-sales decision. */
export const MARKETING_OWNER = 'Marketing (Sam)';
const MARKETING = MARKETING_OWNER;
const REVOPS = 'RevOps';

/** A repeat touch inside this window of the contact's last alert never alerts again (R2). */
export const REPEAT_ALERT_QUIET_MS = 24 * 3600_000;

// minutes; B/C/D/review are business minutes. enterprise is a tier-B enterprise deal (R10), clocked like A from the next business open.
export const SLA = { A: 5, enterprise: 15, B: 60, C: 540, D: 540, review: 60 } as const;

export function teamFor(segment: Segment, useCase: UseCase, source: string): Team {
  const apiish = (source === 'marketplace' || source === 'api_key') && useCase === 'data_platform_api';
  if (apiish || segment === 'innovator_api_data') return 'API';
  if (segment === 'innovator_navigation') return useCase === 'data_platform_api' || useCase === 'navigation_find_care' ? 'API' : 'BW';
  if (['health_system', 'standalone_hospital', 'provider_group'].includes(segment)) return 'HSP';
  if (['employer_self_funded', 'benefits_consultant_broker', 'tpa', 'government'].includes(segment)) return 'BW';
  if (['payer', 'life_sciences', 'pe_investor', 'consulting_advisory'].includes(segment)) return 'PLS';
  return 'BW';
}

export function nurtureTrack(segment: Segment, source: string): string {
  if (source === 'api_key' || source === 'sample_signup') return 'developer_product';
  if (['health_system', 'standalone_hospital', 'provider_group'].includes(segment)) return 'provider_education';
  if (['payer', 'life_sciences', 'pe_investor', 'consulting_advisory'].includes(segment)) return 'payer_lifesci_advisory';
  if (['benefits_consultant_broker', 'tpa', 'employer_self_funded', 'government'].includes(segment)) return 'benefits_advisors';
  if (segment === 'academic') return 'research';
  if (segment === 'non_us') return 'out_of_territory';
  return 'general';
}

function sla(tier: keyof typeof SLA, receivedAt: string): { minutes: number; dueAt: string } {
  const minutes = SLA[tier];
  const t = Date.parse(receivedAt);
  // A and an enterprise deal: the alert goes out immediately; if nobody is at their desk the clock starts at the next business open
  const due = tier === 'A' || tier === 'enterprise' ? nextBusinessOpen(t) + minutes * 60_000 : addBusinessMinutes(t, minutes);
  return { minutes, dueAt: iso(due) };
}

const repTeam = (owners: Owners, name: string): Team | null => {
  for (const [team, t] of Object.entries(owners.teams)) if (t.reps.some(r => r.name === name)) return team as Team;
  return null;
};

const SEGMENT_LABEL: Record<Segment, string> = {
  health_system: 'health system', payer: 'payer', benefits_consultant_broker: 'benefits consultant or broker', tpa: 'third-party administrator',
  life_sciences: 'life sciences company', standalone_hospital: 'standalone hospital', employer_self_funded: 'self-funded employer',
  innovator_navigation: 'care-navigation company', innovator_api_data: 'data and API company', provider_group: 'provider group',
  pe_investor: 'private equity investor', consulting_advisory: 'consulting or advisory firm', unknown_org: 'unidentified organization',
  government: 'government employer', academic: 'academic institution', non_us: 'non-US organization', media: 'media organization', competitor: 'competitor',
};
const TRACK_LABEL: Record<string, string> = { provider_education: 'provider education', payer_lifesci_advisory: 'payer, life sciences and advisory', benefits_advisors: 'benefits advisors', developer_product: 'developer and product', research: 'research', out_of_territory: 'out-of-territory', general: 'general' };
/** "provider education" for provider_education, and so on. */
export const nurtureTrackLabel = (track: string) => TRACK_LABEL[track] ?? track.replace(/_/g, ' ');
const NUMBER_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const STATUS_TEXT: Record<string, string> = { customer: 'Existing customer account', open_opportunity: 'Account with an open opportunity', partner: 'Partner account' };

/** "Health Systems & Providers" for HSP, and so on. */
export function teamName(owners: Owners, team: Team): string {
  if (team === 'Nurture') return 'marketing nurture';
  if (team === 'Review') return 'RevOps review';
  return owners.teams[team]?.name ?? team;
}

/** What the model alone said (a non-buyer call no rule shared), for the sentence that tells a person why the lead was not dropped. */
const modelDoubt = (qual: Qualification) => {
  const what = (qual.llmDisqualifier ?? 'a non-buyer').replace(/_/g, ' ');
  const neverDropped = !!qual.llmDisqualifier && PERSON_DECIDES_IF_MODEL_ONLY.includes(qual.llmDisqualifier);
  return { what, neverDropped };
};

/**
 * The sentence a doubt that arrives after the alert carries to the alert's channel and to RevOps (decision 19). Worded like
 * the R5 and R6 reasons: what the model said, that no rule agreed, why that is not acted on alone, and who decides.
 */
export function doubtAfterAlert(d: Doubt, owner: string): string {
  const what = d.disqualifier.replace(/_/g, ' ');
  const why = PERSON_DECIDES_IF_MODEL_ONLY.includes(d.disqualifier)
    ? `, and ${what} is never dropped on the model's word alone`
    : d.heldForPerson ? ' and the model was less than 0.8 confident' : `, at ${d.confidence.toFixed(2)} confidence`;
  return `After the alert went out, the model flagged this lead as ${what} but no rule agreed${why}, so RevOps is checking it. ${owner} keeps the lead unless RevOps withdraws it.`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function decideRoute(i: RouteInput): Route {
  const { ev, n, res, qual, score, owners } = i;
  const f = qual.final;
  const tier = score.tier;
  const base = { slaMinutes: null as number | null, slaDueAt: null as string | null };

  // R1 spam or disposable domain
  if (n.isDisposable || f.disqualifier === 'spam') {
    return { ...base, action: 'drop', team: 'Nurture', owner: 'unassigned', rule: 'R1', reason: n.isDisposable ? `The email domain ${n.emailDomain} is a disposable-mail service, so the lead is dropped and nothing is written to the CRM.` : 'The message reads as spam, so the lead is dropped and nothing is written to the CRM.' };
  }

  // R2 contact duplicate (an idempotent replay never reaches here: the inbound handler returns before a lead exists)
  if (i.duplicate) {
    const d = i.duplicate;
    const recent = d.lastAlertAt != null && Date.parse(ev.receivedAt) - Date.parse(d.lastAlertAt) < REPEAT_ALERT_QUIET_MS;
    // Inside 24h of the last alert: always quiet. After that, only a tier-A touch re-alerts; everything else just lands on the record.
    const suppressed = recent || tier !== 'A';
    return {
      ...base, action: 'attach_to_existing', team: d.team, owner: d.owner, rule: 'R2', alertSuppressed: suppressed,
      reason: suppressed
        ? `This contact already has a lead from the last 30 days, so this touch is attached to it, stays with ${d.owner}, and sends no new alert${recent ? ' because the last alert was under 24 hours ago' : ''}.`
        : `This contact already has a lead from the last 30 days, so this touch is attached to it and stays with ${d.owner}; it is tier A and the last alert is over 24 hours old, so ${d.owner} is alerted again.`,
    };
  }

  // R9 web intent is account-level: it never alerts a rep (checked here because it has no person to run R3 to R8 on)
  if (ev.source === 'web_intent') {
    const team = teamFor(res.segment, 'other', ev.source);
    const acctOwner = i.mirror?.owner ?? i.claimedOwner ?? null;
    const owner = acctOwner ?? `${team} queue`;
    const t = acctOwner ? (repTeam(owners, acctOwner) ?? team) : team;
    const s = sla('B', ev.receivedAt);
    return { action: 'account_signal', team: t, owner, rule: 'R9', slaMinutes: s.minutes, slaDueAt: s.dueAt, reason: acctOwner ? `Web visits from ${res.accountName ?? n.emailDomain}, an account owned by ${owner}, so ${owner} gets a research task and no rep is alerted.` : `Web visits from ${res.accountName ?? n.emailDomain} with no named person, so the ${teamName(owners, team)} team gets a research task and no rep is alerted.` };
  }

  // R3 competitor domain
  if (res.segment === 'competitor') {
    return { ...base, action: 'competitor_flag', team: 'Nurture', owner: MARKETING, rule: 'R3', reason: `${res.accountName ?? n.emailDomain} is a competitor, so the marketing lead is told and the contact gets no sales route and no lifecycle promotion.` };
  }

  // R4 disqualifier or out-of-scope segment
  if (f.disqualifier === 'job_seeker') return { ...base, action: 'careers', team: 'Nurture', owner: MARKETING, rule: 'R4', reason: 'The message is from a job seeker, so they get the careers-page reply instead of a sales route.' };
  if (f.disqualifier === 'media') return { ...base, action: 'press', team: 'Nurture', owner: MARKETING, rule: 'R4', reason: 'This is a press inquiry, so it is forwarded to the press inbox instead of a sales route.' };
  if (f.disqualifier === 'vendor_pitch') return { ...base, action: 'drop', team: 'Nurture', owner: 'unassigned', rule: 'R4', reason: 'This is a vendor pitch, so it is dropped.' };
  if (f.disqualifier === 'student' || res.segment === 'academic') return { ...base, action: 'nurture', team: 'Nurture', owner: MARKETING, rule: 'R4', sequence: 'research', reason: `${f.disqualifier === 'student' ? 'The contact is a student' : 'The organization is an academic institution'}, so they go to the research nurture track instead of a sales route.` };
  if (res.segment === 'non_us') return { ...base, action: 'nurture', team: 'Nurture', owner: MARKETING, rule: 'R4', sequence: 'out_of_territory', reason: `The organization is outside US territory (${res.evidence.find(e => e.step === 'tld')?.detail ?? 'non-US'}), so it goes to the out-of-territory nurture track.` };

  // R5 existing account owner beats round-robin: the seeded CRM owner first, otherwise a rep who claimed the account on an earlier lead
  const acctOwner = i.mirror?.owner ?? i.claimedOwner ?? null;
  if (acctOwner) {
    const team = repTeam(owners, acctOwner) ?? teamFor(res.segment, f.useCase, ev.source);
    const t: 'A' | 'B' | 'C' | 'D' = tier === 'X' ? 'D' : tier;
    const s = sla(t, ev.receivedAt);
    const who = res.accountName ?? n.companyRaw ?? 'This account';
    const doubt = qual.reviewReason ? modelDoubt(qual) : null;
    return {
      action: t === 'A' ? 'rep_alert' : 'owner_task', team, owner: acctOwner, rule: 'R5', slaMinutes: s.minutes, slaDueAt: s.dueAt,
      reason: (i.mirror
        ? `${STATUS_TEXT[i.mirror.status] ?? 'Existing account'} owned by ${acctOwner}, so it goes to ${acctOwner} whatever the tier; tier ${t} only sets the response time.`
        : `${who} is already owned by ${acctOwner} from an earlier lead, so it goes to ${acctOwner} whatever the tier; tier ${t} only sets the response time.`)
        // R6 never sees this lead (the owner keeps it), so the owner is told about the model's doubt here
        + (doubt ? ` The model alone flagged it as ${doubt.what}${doubt.neverDropped ? '' : ' at under 0.8 confidence'} and no rule agreed, so check it before acting.` : ''),
    };
  }

  // R6 unresolved, ambiguous, or an LLM-only disqualifier (spam or vendor pitch at any confidence, anything else under 0.8)
  if (res.status !== 'resolved' || qual.reviewReason) {
    const s = sla('review', ev.receivedAt);
    let why: string;
    if (qual.reviewReason) {
      const { what, neverDropped } = modelDoubt(qual);
      why = `The model flagged this lead as ${what} but no rule agreed${neverDropped ? `, and ${what} is never dropped on the model's word alone` : ' and the model was less than 0.8 confident'}, so RevOps decides before any rep is alerted.`;
    } else if (res.status === 'ambiguous') {
      const top = res.candidates[0]?.score ?? 1;
      const close = Math.max(2, res.candidates.filter(c => top - c.score < 0.1 + 1e-9).length);
      const kind = res.candidates.length && res.candidates.every(c => c.accountId.startsWith('ahrq:')) ? 'health systems' : 'organizations';
      why = `${n.companyRaw ?? 'The company'} matches ${NUMBER_WORD[close] ?? close} ${kind} about equally${n.state ? '' : ' and no state was given'}, so RevOps picks the account before any rep is alerted.`;
    } else {
      why = `${n.companyRaw ? `"${n.companyRaw}"` : 'The company'} could not be matched to any known organization, so RevOps looks at it before any rep is alerted.`;
    }
    return { action: 'review', team: 'Review', owner: REVOPS, rule: 'R6', slaMinutes: s.minutes, slaDueAt: s.dueAt, reason: why };
  }

  // R7 team
  const team = teamFor(res.segment, f.useCase, ev.source);

  // R10 an enterprise deal never waits in a team queue
  const enterprise = enterpriseDeal(i);
  if (enterprise) {
    const rep = i.pickRep(team);
    const s = sla(tier === 'A' ? 'A' : 'enterprise', ev.receivedAt);
    const queue = teamName(owners, team);
    const who = rep
      ? `${tier === 'A' ? 'a named rep gets it and holds the account' : `a named rep gets it now instead of the ${queue} queue`}: round-robin assigned ${rep.name} in ${queue}, with a ${s.minutes}-minute response time`
      : `it goes to the ${queue} queue because no rep was available`;
    return { action: 'rep_alert', team, owner: rep?.name ?? `${team} queue`, rule: 'R10', slaMinutes: s.minutes, slaDueAt: s.dueAt, reason: `${enterprise}, so ${who}.` };
  }

  // R8 tier gate
  if (tier === 'A') {
    const rep = i.pickRep(team);
    const s = sla('A', ev.receivedAt);
    return {
      action: 'rep_alert', team, owner: rep?.name ?? `${team} queue`, rule: 'R8', slaMinutes: s.minutes, slaDueAt: s.dueAt,
      reason: `Tier A (${score.total}) ${SEGMENT_LABEL[res.segment]} with no account owner, so ${rep ? `round-robin assigned ${rep.name} in ${teamName(owners, team)}` : `it goes to the ${teamName(owners, team)} queue because no rep was available`}.`,
    };
  }
  if (tier === 'B') {
    const s = sla('B', ev.receivedAt);
    return { action: 'team_queue', team, owner: `${team} queue`, rule: 'R8', slaMinutes: s.minutes, slaDueAt: s.dueAt, reason: `Tier B (${score.total}) ${SEGMENT_LABEL[res.segment]}, so it goes to the ${teamName(owners, team)} queue with a ${s.minutes} business-minute response time.` };
  }
  const track = nurtureTrack(res.segment, ev.source);
  return { ...base, action: 'nurture', team, owner: MARKETING, rule: 'R8', sequence: track, reason: `Tier ${tier} (${score.total}) ${SEGMENT_LABEL[res.segment]}, which is below the rep threshold, so it goes to marketing's ${TRACK_LABEL[track] ?? track} nurture track.` };
}

/**
 * Why R10 applies, as the start of its reason sentence, or null when it does not. A person (not an account-level signal,
 * not a list door) with no disqualifier and tier B or better, at an enterprise account, or at a confidently resolved
 * sales-segment organization whose message carries a deal-size cue.
 */
function enterpriseDeal(i: RouteInput): string | null {
  const { n, res, qual, score } = i;
  const deal = i.deal ?? NO_DEAL_SIGNALS;
  if (i.listDoor || !n.email || qual.final.disqualifier !== 'none' || (score.tier !== 'A' && score.tier !== 'B')) return null;
  const name = res.accountName ?? n.companyRaw ?? 'This organization';
  const cue = deal.cues[0] ? ` and the message ${cueClause(deal.cues[0])}` : '';
  if (deal.enterprise.enterprise) return `${name} is an enterprise account${deal.enterprise.fact ? ` (${deal.enterprise.fact})` : ''}${cue}`;
  if (cue && confidentSalesOrg(res)) return `${name} is a known ${SEGMENT_LABEL[res.segment]}${cue}`;
  return null;
}

export const afterHours = (receivedAt: string) => !isBusinessTime(Date.parse(receivedAt));
