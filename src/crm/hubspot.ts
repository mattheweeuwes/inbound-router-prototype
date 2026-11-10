// HubSpot request builders and the executor. Dry-run is the default: request bodies are written to out/hubspot/ and nothing is sent.
// Live mode needs a service key (HUBSPOT_SERVICE_KEY, or a legacy HUBSPOT_PRIVATE_APP_TOKEN) and HUBSPOT_LIVE=1. CI never runs live.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context';
import { parseRetryAfter } from '../retry';
import type { DealSignals, Enterprise } from '../enterprise';
import type { Referral } from '../referral';
import type { CrmRequest, LeadEvent, Normalized, Qualification, Resolution, Route, Score } from '../schema';
import { FEATURE_KEYS, type Feature } from '../usage/taxonomy';

export const PATHS = {
  contactsUpsert: '/crm/v3/objects/contacts/batch/upsert',
  companiesUpsert: '/crm/v3/objects/companies/batch/upsert',
  associateDefault: (contactId: string, companyId: string) => `/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`,
  tasks: '/crm/v3/objects/tasks',
} as const;

/** HubSpot-defined association type ids (task -> contact is documented on the Tasks page; task -> company is from HubSpot's default type list). */
export const TASK_TO_CONTACT = 204;
export const TASK_TO_COMPANY = 192;

export const LIFECYCLE = { A: 'salesqualifiedlead', B: 'marketingqualifiedlead', C: 'lead', D: 'lead' } as const;

const CONTACT_ID = '{{contact_id}}';
const COMPANY_ID = '{{company_id}}';

export interface CrmInput {
  leadId: string;
  ev: LeadEvent;
  n: Normalized;
  res: Resolution;
  qual: Qualification;
  score: Score;
  route: Route;
  isFirstTouch: boolean;
  ownerId: string | null; // synthetic hubspot_owner_id of the task owner
  companyOwnerId?: string | null; // set only on the lead whose rep alert claimed the account: the company upsert then sets its owner
  brief: string; // extractive rep brief
  /** the account's enterprise flag and the deal-size cues (decision 25); absent in callers that predate them */
  deal?: DealSignals;
  /** the named referral (decision 26), or null */
  referral?: Referral | null;
}

const prune = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));

export function contactProperties(i: CrmInput): Record<string, unknown> {
  const { n, res, qual, score, route, ev } = i;
  const competitor = res.segment === 'competitor';
  const utm = (p: string) => ({
    [`${p}_utm_source`]: n.utm.source, [`${p}_utm_medium`]: n.utm.medium, [`${p}_utm_campaign`]: n.utm.campaign,
    [`${p}_utm_content`]: n.utm.content, [`${p}_utm_term`]: n.utm.term,
  });
  const tier = score.tier === 'X' ? null : score.tier;
  return prune({
    email: n.email, firstname: n.firstName, lastname: n.lastName, jobtitle: n.title,
    company: res.accountName ?? n.companyRaw, state: n.state,
    // lifecycle is never promoted for competitors; X (disqualified) leads are not promoted either
    lifecyclestage: competitor || !tier ? undefined : LIFECYCLE[tier],
    hs_lead_status: 'NEW',
    serif_segment: res.segment, serif_use_case: qual.final.useCase, serif_urgency: qual.final.urgency, serif_tier: score.tier,
    serif_fit_score: score.fit, serif_intent_score: score.intent, serif_route_team: route.team, serif_source: ev.source,
    serif_lead_id: i.leadId, serif_account_key: res.accountId, serif_nurture_track: route.action === 'nurture' ? route.sequence : undefined,
    ...referralProperties(i.referral ?? null),
    serif_deal_cues: i.deal?.cues.map(c => c.phrase).join('; '),
    ...(i.isFirstTouch ? utm('first_touch') : {}),
    ...utm('last_touch'),
  });
}

/** Who referred the contact (decision 26): the kind, the name (the organization's when it resolved, else the words), and its key. */
function referralProperties(r: Referral | null): Record<string, unknown> {
  if (!r) return {};
  return { serif_referral_kind: r.kind, serif_referred_by: r.account?.name ?? r.referrer, serif_referrer_account_key: r.account?.key };
}

export function companyProperties(res: Resolution, ownerId: string | null = null, enterprise: Enterprise | null = null): Record<string, unknown> {
  const domainOk = res.accountId?.startsWith('domain:') ? res.accountId.slice(7) : undefined;
  return prune({
    name: res.accountName, domain: domainOk, serif_account_key: res.accountId, serif_segment: res.segment,
    serif_hospital_count: res.firmographics.hospitals ?? undefined, serif_match_method: res.method,
    // an enterprise flag of 'no' is written too, so a HubSpot list of non-enterprise accounts is not a list of blanks
    serif_enterprise: enterprise ? (enterprise.enterprise ? 'yes' : 'no') : undefined, serif_enterprise_fact: enterprise?.fact,
    hubspot_owner_id: ownerId,
  });
}

export function buildContactUpsert(i: CrmInput): CrmRequest {
  const props = contactProperties(i);
  return { method: 'POST', path: PATHS.contactsUpsert, body: { inputs: [{ id: i.n.email, idProperty: 'email', properties: props }] }, note: 'Batch upsert keyed on email. Response results[0].id is the contact record id.' };
}

export function buildCompanyUpsert(res: Resolution, ownerId: string | null = null, enterprise: Enterprise | null = null): CrmRequest {
  return {
    method: 'POST', path: PATHS.companiesUpsert,
    body: { inputs: [{ id: res.accountId, idProperty: 'serif_account_key', properties: companyProperties(res, ownerId, enterprise) }] },
    note: 'Keyed on the unique custom property serif_account_key (AHRQ id, CCN, NPI or payer slug), not on domain or name.',
  };
}

/** What a company upsert carries for an outbound group (src/outbound): the finding about its own rate, keyed on its EIN. */
export interface OutboundCompanyInput {
  accountKey: string; ein: string; name: string; city: string; state: string | null; clinicians: number; band: string;
  rate: number; pctOfMedicare: number; form: string; cardTier: number | null; factorMultiple: number | null; cityTopRate: number;
  bandMedianPct: number; fit: string; platform: string | null;
  /** the registry account the group links to by name and state, when it does */
  registryAccountKey: string | null;
  /** payer, network, code and month the rate is from, e.g. "UnitedHealthcare Choice Plus 90837 202608" */
  rateScope: string;
}

export function outboundCompanyProperties(c: OutboundCompanyInput): Record<string, unknown> {
  return prune({
    name: c.name, city: c.city, state: c.state, serif_account_key: c.accountKey, serif_segment: 'provider_group', serif_match_method: 'ein',
    serif_ein: c.ein, serif_registry_account_key: c.registryAccountKey, serif_rate_scope: c.rateScope, serif_rate: c.rate,
    serif_rate_pct_medicare: c.pctOfMedicare, serif_contract_form: c.form, serif_card_tier_pct: c.cardTier, serif_conversion_factor: c.factorMultiple,
    serif_clinicians: c.clinicians, serif_size_band: c.band, serif_city_top_rate: c.cityTopRate, serif_band_median_pct: c.bandMedianPct,
    serif_outbound_fit: c.fit, serif_platform: c.platform,
  });
}

/** The company upsert for an outbound group, on the same unique key as every company the router writes. Dry-run only: nothing sends it. */
export function buildOutboundCompanyUpsert(c: OutboundCompanyInput): CrmRequest {
  return {
    method: 'POST', path: PATHS.companiesUpsert,
    body: { inputs: [{ id: c.accountKey, idProperty: 'serif_account_key', properties: outboundCompanyProperties(c) }] },
    note: 'Keyed on serif_account_key = ein:<EIN>, the group\'s stable id in the rate file. Carries the finding about its own rate. Built for target groups; never enqueued or sent.',
  };
}

/** What the reverse ETL knows about one account's product use: the features used in the last 30 days, the latest use, and counts per feature. */
export interface UsageRollup {
  /** features with at least one event in the 30 days up to the as-of date, in taxonomy order */
  features30d: Feature[];
  lastFeature: Feature | null;
  lastFeatureAt: string | null;
  /** events in those 30 days, for every feature (zero when unused) */
  events30d: Record<Feature, number>;
}

/** The HubSpot property name for one feature's 30-day event count. */
export const eventsProperty = (feature: Feature) => `serif_events_30d_${feature}`;

/**
 * The company properties a usage rollup writes. Not pruned: an account whose 30-day use has fallen to nothing must write
 * the empty list and the zeros, or HubSpot keeps showing last month's features.
 */
export function usageCompanyProperties(u: UsageRollup): Record<string, unknown> {
  return {
    serif_features_30d: u.features30d.join(';'), serif_last_feature: u.lastFeature ?? '', serif_last_feature_at: u.lastFeatureAt ?? '',
    ...Object.fromEntries(FEATURE_KEYS.map(f => [eventsProperty(f), u.events30d[f]])),
  };
}

/** What an expansion task says and who it goes to. Every figure is a count or a date taken from the usage rows. */
export interface ExpansionTaskInput {
  accountKey: string; accountName: string; segment: string | null; ownerId: string | null;
  addOnLabel: string; priceLow: number; priceHigh: number; featureLabel: string;
  uses: number; people: number; windowFrom: string; windowTo: string; lastUseAt: string;
  /** when the task is due, ISO */
  dueAt: string;
}

const dollars = (n: number) => `$${n.toLocaleString('en-US')}`;
const dayOf = (iso: string) => iso.slice(0, 10);

/** The task body: the evidence in a few sentences, and what it does not show. */
export function expansionTaskBody(i: ExpansionTaskInput): string {
  const people = i.people === 1 ? '1 person' : `${i.people} people`;
  return `${i.accountName} used ${i.featureLabel} ${i.uses} times from ${dayOf(i.windowFrom)} to ${dayOf(i.windowTo)}, across ${people}, most recently on ${dayOf(i.lastUseAt)}. ` +
    `It has no ${i.addOnLabel} deal at any stage. ${i.addOnLabel} lists at ${dollars(i.priceLow)} to ${dollars(i.priceHigh)}. ` +
    `This is product usage, not a statement of intent from the account.`;
}

/**
 * The plan for one expansion signal: the company (so the task has something to attach to) and a task for the account's owner.
 * It is built the way a lead's plan is, and shown or written as a dry run only. It is never put in the outbox, so a live boot cannot send it.
 */
export function planExpansionTask(i: ExpansionTaskInput): { requests: CrmRequest[]; skipped: string | null } {
  const company: CrmRequest = {
    method: 'POST', path: PATHS.companiesUpsert,
    body: { inputs: [{ id: i.accountKey, idProperty: 'serif_account_key', properties: prune({ name: i.accountName, serif_account_key: i.accountKey, serif_segment: i.segment }) }] },
    note: 'Keyed on serif_account_key, as for every company. Only here so the task can be associated to it.',
  };
  const task: CrmRequest = {
    method: 'POST', path: PATHS.tasks,
    body: {
      properties: prune({
        hs_timestamp: i.dueAt, hs_task_subject: `Expansion signal: ${i.accountName} previewed ${i.addOnLabel}`, hs_task_body: expansionTaskBody(i),
        hubspot_owner_id: i.ownerId, hs_task_status: 'NOT_STARTED', hs_task_priority: 'MEDIUM', hs_task_type: 'TODO',
      }),
      associations: [{ to: { id: COMPANY_ID }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_COMPANY }] }],
    },
    note: 'A task for the account owner. Built from product usage; not sent by anything in this project.',
  };
  return { requests: [company, task], skipped: null };
}

/** What a thank-you task for a referral says and who it goes to (decision 26). */
export interface ReferralThanksInput {
  referrerKey: string; referrerName: string; ownerId: string | null;
  /** the referred lead: the person, their organization, and when they came in (ISO) */
  person: string; referredOrg: string; receivedAt: string;
  /** the prospect's own words about the referral */
  text: string;
  /** when the task is due, ISO */
  dueAt: string;
}

/** The task body: what the prospect said, quoted, and that it is the prospect's account of the referral. */
export function referralThanksBody(i: ReferralThanksInput): string {
  return `${i.person} at ${i.referredOrg} came in on ${dayOf(i.receivedAt)} and named ${i.referrerName}: "${i.text}". ` +
    `This is the prospect's account of the referral; confirm it with your contact before thanking anyone by name.`;
}

/**
 * The plan for thanking a referring account's owner: the company (so the task has something to attach to, with the latest
 * referral on it) and a task for the owner. Built like the expansion task: shown on the lead and never put in the outbox,
 * so nothing sends it, live mode included.
 */
export function planReferralThanks(i: ReferralThanksInput): { requests: CrmRequest[]; skipped: string | null } {
  const company: CrmRequest = {
    method: 'POST', path: PATHS.companiesUpsert,
    body: { inputs: [{ id: i.referrerKey, idProperty: 'serif_account_key', properties: prune({ name: i.referrerName, serif_account_key: i.referrerKey, serif_last_referral: `${i.referredOrg} (${dayOf(i.receivedAt)})` }) }] },
    note: 'Keyed on serif_account_key, as for every company. Records the latest referral and lets the task attach to it.',
  };
  const task: CrmRequest = {
    method: 'POST', path: PATHS.tasks,
    body: {
      properties: prune({
        hs_timestamp: i.dueAt, hs_task_subject: `Thank ${i.referrerName} for referring ${i.referredOrg}`, hs_task_body: referralThanksBody(i),
        hubspot_owner_id: i.ownerId, hs_task_status: 'NOT_STARTED', hs_task_priority: 'MEDIUM', hs_task_type: 'TODO',
      }),
      associations: [{ to: { id: COMPANY_ID }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_COMPANY }] }],
    },
    note: 'A task for the referring account\'s owner. Dry-run only: never enqueued or sent.',
  };
  return { requests: [company, task], skipped: null };
}

export function buildAssociation(): CrmRequest {
  return { method: 'PUT', path: PATHS.associateDefault(CONTACT_ID, COMPANY_ID), body: null, note: 'Default (unlabeled) contact to company association. Ids come from the two upsert responses.' };
}

export function buildTask(i: { route: Route; person: string; orgName: string | null; brief: string; ownerId: string | null; hasContact: boolean; hasCompany: boolean }): CrmRequest {
  const { route } = i;
  const subjectByAction: Record<string, string> = {
    rep_alert: `Respond now: ${i.person}`, team_queue: `New lead for ${route.team} queue: ${i.person}`, owner_task: `Existing-account lead: ${i.person}`,
    review: `Review company match: ${i.person}`, account_signal: `Research account activity: ${i.orgName ?? 'unknown account'}`,
  };
  const associations: unknown[] = [];
  if (i.hasContact) associations.push({ to: { id: CONTACT_ID }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_CONTACT }] });
  if (i.hasCompany) associations.push({ to: { id: COMPANY_ID }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_COMPANY }] });
  return {
    method: 'POST', path: PATHS.tasks,
    body: {
      properties: prune({
        hs_timestamp: route.slaDueAt, hs_task_subject: subjectByAction[route.action] ?? `Follow up: ${i.person}`, hs_task_body: i.brief,
        hubspot_owner_id: i.ownerId, hs_task_status: 'NOT_STARTED', hs_task_priority: route.action === 'rep_alert' ? 'HIGH' : 'MEDIUM', hs_task_type: 'TODO',
      }),
      associations,
    },
    note: 'hs_timestamp is the SLA due time; hs_task_body is the extractive brief.',
  };
}

const NO_CRM_ACTIONS = new Set(['drop', 'careers', 'press']);
const TASK_ACTIONS = new Set(['rep_alert', 'team_queue', 'owner_task', 'review', 'account_signal']);

export function planCrm(i: CrmInput): { requests: CrmRequest[]; skipped: string | null } {
  const { route, ev, res } = i;
  if (NO_CRM_ACTIONS.has(route.action)) return { requests: [], skipped: `no CRM write for action ${route.action}` };
  const reqs: CrmRequest[] = [];
  const hasPerson = ev.source !== 'web_intent' && !!i.n.email;
  const hasCompany = !!res.accountId && res.status === 'resolved';
  if (hasCompany) reqs.push(buildCompanyUpsert(res, i.companyOwnerId ?? null, i.deal?.enterprise ?? null));
  if (hasPerson) reqs.push(buildContactUpsert(i));
  if (hasPerson && hasCompany) reqs.push(buildAssociation());
  if (TASK_ACTIONS.has(route.action)) {
    reqs.push(buildTask({ route, person: [i.n.firstName, i.n.lastName].filter(Boolean).join(' ') || i.n.email || 'unknown', orgName: res.accountName, brief: i.brief, ownerId: i.ownerId, hasContact: hasPerson, hasCompany }));
  }
  return { requests: reqs, skipped: reqs.length ? null : 'nothing to write' };
}

export function recordDryRun(ctx: Ctx, leadId: string, requests: CrmRequest[], at: string) {
  if (!requests.length) return;
  const dir = join(ctx.cfg.outDir, 'hubspot');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${at.slice(0, 10)}.jsonl`);
  for (const r of requests) appendFileSync(file, JSON.stringify({ leadId, at, ...r }) + '\n');
}

export interface CrmResponse { path: string; status: number; error?: string; reused?: string }
export interface OwnerMapping { from: string; to: string | null }

/** A 429 or 5xx answer: HubSpot may take the same request later, so the delivery is retried, not recorded as final. */
export interface TransientAnswer { status: number; retryAfterMs: number | null }

export interface CrmExecution {
  mode: CrmMode;
  ok?: boolean;
  responses?: CrmResponse[];
  ownerMapped?: OwnerMapping[];
  /** set when the plan stopped at a 429 or 5xx; the requests after it were not sent */
  transient?: TransientAnswer;
}

export type CrmMode = 'dry_run' | 'live';

/** Live only with HUBSPOT_LIVE=1 and a key; everything else is dry-run. */
export const crmMode = (cfg: Ctx['cfg']): CrmMode => (cfg.hubspotLive && cfg.hubspotToken ? 'live' : 'dry_run');

export const isTransientStatus = (status: number) => status === 429 || status >= 500;

type Props = Record<string, unknown>;
const isObject = (v: unknown): v is Props => !!v && typeof v === 'object' && !Array.isArray(v);

/** HubSpot list answers (owners, search, batch upsert) all carry `results`. */
interface HubspotResults { results?: { id?: string | number; archived?: boolean }[] }

/** The property objects in a request body that set hubspot_owner_id: company upsert inputs and task properties. */
function ownerSlots(body: unknown): Props[] {
  if (!isObject(body)) return [];
  const slots: Props[] = [];
  if (isObject(body.properties) && 'hubspot_owner_id' in body.properties) slots.push(body.properties);
  for (const input of Array.isArray(body.inputs) ? body.inputs : []) if (isObject(input) && isObject(input.properties) && 'hubspot_owner_id' in input.properties) slots.push(input.properties);
  return slots;
}

/** The record id of the first result, or '' when the answer has none. */
const firstResultId = (answer: HubspotResults): string => String(answer.results?.[0]?.id ?? '');

const ownerCache = new WeakMap<object, Promise<string[]>>();

/**
 * The portal's active owner ids, read once per context. A failed read gives [], so owners are dropped, never invented.
 * Only a successful read is cached: after a failed one the next write asks again, so a retry after an outage keeps its owners.
 */
function realOwners(ctx: Ctx): Promise<string[]> {
  let p = ownerCache.get(ctx);
  if (!p) {
    p = ctx.fetch('https://api.hubapi.com/crm/v3/owners?limit=100', { headers: { Authorization: `Bearer ${ctx.cfg.hubspotToken}` }, signal: AbortSignal.timeout(10_000) })
      .then(async res => {
        if (!res.ok) throw new Error(`owners lookup answered ${res.status}`);
        const answer = (await res.json()) as HubspotResults;
        return (answer.results ?? []).filter(o => !o.archived).map(o => String(o.id));
      })
      .catch(() => { ownerCache.delete(ctx); return [] as string[]; });
    ownerCache.set(ctx, p);
  }
  return p;
}

/**
 * An open task with this subject already on the contact (or the company), if any: one open follow-up per person per
 * action, so a repeat lead or a replay does not stack a second one. HubSpot's search index trails writes by a few
 * seconds, so two identical leads seconds apart can both still create one; the door's event-id dedupe covers true
 * redeliveries. A failed search returns null and the task is created, because a duplicate costs less than a missed follow-up.
 */
async function findOpenTask(ctx: Ctx, subject: string, to: { prop: string; id: string }): Promise<string | null> {
  try {
    const res = await ctx.fetch('https://api.hubapi.com/crm/v3/objects/tasks/search', {
      method: 'POST', headers: { Authorization: `Bearer ${ctx.cfg.hubspotToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filterGroups: [{ filters: [
        { propertyName: 'hs_task_subject', operator: 'EQ', value: subject },
        { propertyName: 'hs_task_status', operator: 'NEQ', value: 'COMPLETED' },
        { propertyName: to.prop, operator: 'EQ', value: to.id },
      ] }], properties: ['hs_task_subject'], limit: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return firstResultId((await res.json()) as HubspotResults) || null;
  } catch {
    return null;
  }
}

/** The body with synthetic owner ids swapped for a real portal owner (or removed), and the swaps made. */
async function withRealOwners(ctx: Ctx, body: unknown): Promise<{ body: unknown; mapped: OwnerMapping[] }> {
  if (!ownerSlots(body).length) return { body, mapped: [] };
  const owners = await realOwners(ctx);
  const copy: unknown = JSON.parse(JSON.stringify(body));
  const mapped: OwnerMapping[] = [];
  for (const props of ownerSlots(copy)) {
    const from = props.hubspot_owner_id == null ? null : String(props.hubspot_owner_id);
    if (from == null || owners.includes(from)) continue;
    const to = owners[0] ?? null;
    if (to) props.hubspot_owner_id = to; else delete props.hubspot_owner_id;
    mapped.push({ from, to });
  }
  return { body: copy, mapped };
}

/**
 * Executes a plan. Dry-run unless HUBSPOT_LIVE=1 and a key are both present. Never logs the key.
 * The router's reps are synthetic, so an owner id the portal does not have is mapped to the portal's first real owner
 * (or dropped when it has none), and the mapping is returned: HubSpot would otherwise reject the whole write.
 * Every response status comes back, with HubSpot's error text on a failure, so a failed write is never reported as sent.
 * A task is created only when the same open task is not already on the contact (findOpenTask).
 * A 429 or 5xx stops the plan there and is returned as `transient`, with Retry-After when HubSpot sent one: the caller
 * retries the whole plan later, which is safe because every step upserts or checks first. A network error or the 10 s
 * timeout throws. Any other 4xx is recorded and the plan goes on, as a retry would get the same answer.
 */
export async function executeCrm(ctx: Ctx, requests: CrmRequest[]): Promise<CrmExecution> {
  if (crmMode(ctx.cfg) === 'dry_run') return { mode: 'dry_run' };
  const ids: Record<string, string> = {};
  const responses: CrmResponse[] = [];
  const ownerMapped: OwnerMapping[] = [];
  const settled = (transient?: TransientAnswer): CrmExecution => ({
    mode: 'live', ok: !transient && responses.every(x => x.status < 300), responses, ...(ownerMapped.length ? { ownerMapped } : {}), ...(transient ? { transient } : {}),
  });
  for (const r of requests) {
    const { body, mapped } = await withRealOwners(ctx, r.body);
    ownerMapped.push(...mapped);
    const sub = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => ids[k] ?? `{{${k}}}`);
    const path = sub(r.path);
    if (r.method === 'POST' && r.path === PATHS.tasks) {
      const subject = isObject(body) && isObject(body.properties) ? body.properties.hs_task_subject : undefined;
      const to = ids.contact_id ? { prop: 'associations.contact', id: ids.contact_id } : ids.company_id ? { prop: 'associations.company', id: ids.company_id } : null;
      const existing = subject && to ? await findOpenTask(ctx, String(subject), to) : null;
      if (existing) { responses.push({ path, status: 200, reused: existing }); continue; }
    }
    const res = await ctx.fetch(`https://api.hubapi.com${path}`, {
      method: r.method, headers: { Authorization: `Bearer ${ctx.cfg.hubspotToken}`, 'Content-Type': 'application/json' },
      body: body == null ? undefined : sub(JSON.stringify(body)), signal: AbortSignal.timeout(10_000),
    });
    const entry: CrmResponse = { path, status: res.status };
    if (!res.ok) entry.error = (await res.text().catch(() => '')).slice(0, 300);
    responses.push(entry);
    if (isTransientStatus(res.status)) return settled({ status: res.status, retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), ctx.cfg.now()) });
    if (res.ok && r.path.includes('/contacts/batch/upsert')) ids.contact_id = firstResultId((await res.json()) as HubspotResults);
    else if (res.ok && r.path.includes('/companies/batch/upsert')) ids.company_id = firstResultId((await res.json()) as HubspotResults);
  }
  return settled();
}

// ------- property definitions (one-time setup; also written to docs/hubspot-properties.json) -------
interface Prop { name: string; label: string; type: 'string' | 'number' | 'enumeration'; fieldType: 'text' | 'number' | 'select'; options?: string[]; hasUniqueValue?: boolean; description: string }

const enumProp = (name: string, label: string, options: string[], description: string): Prop => ({ name, label, type: 'enumeration', fieldType: 'select', options, description });
const text = (name: string, label: string, description: string, extra: Partial<Prop> = {}): Prop => ({ name, label, type: 'string', fieldType: 'text', description, ...extra });

export const CONTACT_PROPERTIES: Prop[] = [
  enumProp('serif_segment', 'Segment', ['health_system', 'payer', 'benefits_consultant_broker', 'tpa', 'life_sciences', 'standalone_hospital', 'employer_self_funded', 'innovator_navigation', 'innovator_api_data', 'provider_group', 'pe_investor', 'consulting_advisory', 'unknown_org', 'government', 'academic', 'non_us', 'media', 'competitor'], 'Resolved account segment.'),
  enumProp('serif_use_case', 'Use case', ['contract_negotiation', 'rate_benchmarking_market', 'payer_competitive_intel', 'network_design_benefits', 'navigation_find_care', 'data_platform_api', 'life_sciences_access', 'investment_diligence', 'research_media', 'job_seeker', 'vendor_pitch', 'other'], 'Classified use case (rules, model-assisted).'),
  enumProp('serif_urgency', 'Urgency', ['now', 'this_quarter', 'exploring', 'unknown'], 'Classified urgency relative to the lead date.'),
  enumProp('serif_tier', 'Tier', ['A', 'B', 'C', 'D', 'X'], 'Score tier. X is disqualified.'),
  { name: 'serif_fit_score', label: 'Fit score', type: 'number', fieldType: 'number', description: 'Fit points, 0 to 50.' },
  { name: 'serif_intent_score', label: 'Intent score', type: 'number', fieldType: 'number', description: 'Intent points, 0 to 50.' },
  enumProp('serif_route_team', 'Route team', ['HSP', 'BW', 'PLS', 'API', 'Nurture', 'Review'], 'Team the lead was routed to.'),
  text('serif_source', 'Source', 'Inbound door: calendly_demo, guide_download, and so on.'),
  text('serif_lead_id', 'Lead id', 'Id of the lead in the router.'),
  text('serif_account_key', 'Account key', 'Stable account id (ahrq:, ccn:, payer:, npi:, domain:).'),
  text('serif_nurture_track', 'Nurture track', 'Track a HubSpot workflow enrolls the contact in.'),
  // a named referral and the deal-size cues (decisions 25 and 26)
  enumProp('serif_referral_kind', 'Referral kind', ['customer', 'known_org', 'unknown_org'], 'Who the contact named as referring them: a customer, another known organization, or one the router could not identify.'),
  text('serif_referred_by', 'Referred by', 'The referring organization, or the words the contact used when it could not be identified.'),
  text('serif_referrer_account_key', 'Referrer account key', 'Stable account key of the referring organization, when it resolved.'),
  text('serif_deal_cues', 'Deal-size cues', 'Deal-size phrases quoted from the message (bulk license, full dataset, all states, multi-year, several entities, approved budget), separated by semicolons.'),
  ...(['first', 'last'] as const).flatMap(p => (['source', 'medium', 'campaign', 'content', 'term'] as const).map(k => text(`${p}_touch_utm_${k}`, `${p === 'first' ? 'First' : 'Last'} touch UTM ${k}`, `Normalized utm_${k} at the ${p} touch.`))),
];

export const COMPANY_PROPERTIES: Prop[] = [
  text('serif_account_key', 'Account key', 'Unique stable account id. Companies are upserted on this property.', { hasUniqueValue: true }),
  text('serif_segment', 'Segment', 'Resolved account segment.'),
  { name: 'serif_hospital_count', label: 'Hospital count', type: 'number', fieldType: 'number', description: 'AHRQ hospital count for health systems.' },
  text('serif_match_method', 'Match method', 'How the account was resolved.'),
  enumProp('serif_enterprise', 'Enterprise account', ['yes', 'no'], 'Whether the account meets the router\'s enterprise definition (a starting assumption: 8+ hospitals or 3+ states, a national or Blue payer, a national broker or TPA).'),
  text('serif_enterprise_fact', 'Enterprise fact', 'The fact line behind the enterprise flag, from the registry (for example "145 hospitals in 20 states").'),
  text('serif_last_referral', 'Last referral', 'The latest organization a contact said this account referred, with the day.'),
  { name: 'serif_account_score', label: 'Account score', type: 'number', fieldType: 'number', description: 'Reverse-ETL account score (max lead score at the account).' },
  { name: 'serif_open_leads', label: 'Leads (30d)', type: 'number', fieldType: 'number', description: 'Reverse-ETL count of leads in the last 30 days.' },
  { name: 'serif_web_intent_points', label: 'Web intent points', type: 'number', fieldType: 'number', description: 'Reverse-ETL account-level web intent points.' },
  // written by the outbound module for target groups in the rate file (dry-run)
  text('serif_ein', 'EIN', 'Employer identification number of the group in the rate file.'),
  text('serif_registry_account_key', 'Registry account key', 'Registry account the rate group links to by name and state, when it does.'),
  text('serif_rate_scope', 'Rate scope', 'Payer, network, code and month the rate is from.'),
  { name: 'serif_rate', label: 'Negotiated rate', type: 'number', fieldType: 'number', description: 'The group\'s one negotiated rate for the code (the row covering the most NPIs).' },
  { name: 'serif_rate_pct_medicare', label: 'Rate, % of Medicare', type: 'number', fieldType: 'number', description: 'The rate as a whole percent of the local Medicare rate.' },
  enumProp('serif_contract_form', 'Contract form', ['card', 'factor', 'both', 'neither'], 'Whether the rate is a whole percent of the rate card, a whole-dollar conversion factor, both or neither.'),
  { name: 'serif_card_tier_pct', label: 'Card tier (%)', type: 'number', fieldType: 'number', description: 'The percent of the rate card base the rate equals.' },
  { name: 'serif_conversion_factor', label: 'Conversion factor ($)', type: 'number', fieldType: 'number', description: 'The whole-dollar factor the rate is a multiple of the unit by.' },
  { name: 'serif_clinicians', label: 'Clinicians', type: 'number', fieldType: 'number', description: 'Individual NPIs linked to the EIN in the network (AllPayerIndividualNPIs).' },
  enumProp('serif_size_band', 'Size band', ['1-50', '51-500', '501+'], 'Clinicians in the group, banded.'),
  { name: 'serif_city_top_rate', label: 'Top rate in the city', type: 'number', fieldType: 'number', description: 'The highest group rate in the same city for the same code.' },
  { name: 'serif_band_median_pct', label: 'Band median, % of Medicare', type: 'number', fieldType: 'number', description: 'Median percent of Medicare across the group\'s size band.' },
  enumProp('serif_outbound_fit', 'Outbound fit', ['target', 'not_target'], 'Whether the outbound finding is for this group.'),
  text('serif_platform', 'Platform', 'The behavioral health platform the EIN is mapped to by hand.'),
  // written by the reverse ETL from product usage (src/usage); the counts are for the 30 days up to the newest event
  text('serif_features_30d', 'Features used (30d)', 'Features the account used in the last 30 days, separated by semicolons (signal_search, signal_watch, api, mcp, network_benchmarking, quality_preview).'),
  text('serif_last_feature', 'Last feature used', 'The feature the account used most recently.'),
  text('serif_last_feature_at', 'Last feature use', 'When the account last used any feature, as a UTC ISO time.'),
  ...FEATURE_KEYS.map((f): Prop => ({ name: eventsProperty(f), label: `Events (30d): ${f}`, type: 'number', fieldType: 'number', description: `Product events for ${f} in the last 30 days.` })),
];

export function propertyDefinitions() {
  const toDef = (p: Prop) => ({ name: p.name, label: p.label, type: p.type, fieldType: p.fieldType, groupName: 'inbound_router', description: p.description,
    ...(p.options ? { options: p.options.map((o, idx) => ({ label: o, value: o, displayOrder: idx })) } : {}), ...(p.hasUniqueValue ? { hasUniqueValue: true } : {}) });
  return {
    _readme: 'One-time property definitions for the inbound router. npm run hubspot:setup creates the group (POST /crm/v3/properties/{objectType}/groups), then each property (POST /crm/v3/properties/{objectType}), in the portal the key belongs to. It is safe to re-run.',
    propertyGroup: { name: 'inbound_router', label: 'Inbound router', displayOrder: -1 },
    contacts: CONTACT_PROPERTIES.map(toDef),
    companies: COMPANY_PROPERTIES.map(toDef),
  };
}
