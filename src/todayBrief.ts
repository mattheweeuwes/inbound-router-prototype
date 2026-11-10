// The team brief: one answer to "what does the team need this morning", for GET /api/brief, the cockpit's Today tab and
// `npm run brief`. It is built from read models that already exist (the dashboard, the outbound summary, the attribution
// reads, the interest reads and the accounts API) and a few id-carrying reads in src/store/today.ts. It makes no decision of
// its own: nothing here scores, routes, ranks a lead or says what a person should do (decision 31). Each item carries the
// ids a reader opens it with, and says which cockpit tab holds the detail.
import type { Ctx } from './context';
import { computeDashboard, type Dashboard } from './dashboard';
import { askedOf, groupByFeature, interestOf } from './interest/view';
import type { StoredReferral } from './referral';
import { outboundSummary } from './outbound/view';
import type { EnterpriseLeadRow, ReferralLeadRow } from './store/today';
import { expansionSignals } from './usage/expansion';

export const BRIEF_SECTIONS = ['needs_person', 'enterprise', 'referrals', 'lists', 'expansion', 'outbound', 'interest', 'health'] as const;
export type BriefSectionId = typeof BRIEF_SECTIONS[number];

/** The cockpit tab that holds an item's detail. */
export type BriefTab = 'overview' | 'stream' | 'review' | 'outbound' | 'feature-pipeline';

/** The ids that open an item: a lead in the stream, an account, a rate group, a list, a feature. */
export interface BriefIds { leadId?: string; accountKey?: string; ein?: string; list?: string; feature?: string }

export interface BriefItem {
  /** a short label for the kind of row: review item, SLA clock, enterprise account, referral, list, expansion signal, link to confirm, ... */
  kind: string;
  title: string;
  detail: string;
  tab: BriefTab;
  ids: BriefIds;
}

export interface BriefFigure { label: string; value: number | null; /** how to read the value: a count, or milliseconds */ unit: 'count' | 'ms'; tab: BriefTab }

export interface BriefSection {
  id: BriefSectionId;
  title: string;
  /** one sentence: what is in the section */
  headline: string;
  /** how many things the section is about (the items may be capped) */
  count: number;
  figures: BriefFigure[];
  items: BriefItem[];
  /** items left out of the list by the cap */
  more: number;
}

export interface TodayBrief {
  generatedAt: string;
  /** the time lead-driven sections look back over; lists, review items, trouble and outbound are shown as they stand */
  window: { hours: number; from: string; to: string };
  sections: Record<BriefSectionId, BriefSection>;
}

export const DEFAULT_WINDOW_HOURS = 24;
export const MAX_WINDOW_HOURS = 24 * 30;
/** Feature interest is "this week", whatever the window. */
export const INTEREST_DAYS = 7;
/** Rows listed per section; the section's count says how many there are. */
export const ITEM_LIMIT = 10;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A window parameter as given, in whole hours between 1 and MAX_WINDOW_HOURS; anything unusable is the default. */
export function windowHours(raw: string | null): number {
  const n = Number(raw ?? DEFAULT_WINDOW_HOURS);
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_WINDOW_HOURS, Math.floor(n)) : DEFAULT_WINDOW_HOURS;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const personName = (r: { first_name: string | null; last_name: string | null; email?: string | null }) =>
  [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || 'an unnamed contact';

/** "2026-11-10 14:05 UTC" from an ISO time; an empty value reads as unknown. */
const utc = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'an unknown time');

/** "2 h 10 min", "45 min", "under a minute". */
export function waitText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  return h ? `${h} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`;
}

function section(id: BriefSectionId, title: string, headline: string, count: number, figures: BriefFigure[], all: BriefItem[]): BriefSection {
  return { id, title, headline, count, figures, items: all.slice(0, ITEM_LIMIT), more: Math.max(0, all.length - ITEM_LIMIT) };
}

const figure = (label: string, value: number | null, tab: BriefTab, unit: BriefFigure['unit'] = 'count'): BriefFigure => ({ label, value, unit, tab });

// ---- needs a person now ----------------------------------------------------------------------------------------------

function needsPerson(d: Dashboard): BriefSection {
  const reviews: BriefItem[] = d.review.map(r => ({
    kind: 'review item', title: `${r.name ?? 'Unnamed contact'}${r.company ? ` at ${r.company}` : ''}`,
    detail: `${r.reason}. Waiting ${waitText(r.waitMs)}${r.tier ? `, tier ${r.tier}` : ''}${r.list ? `, from the ${r.list} list` : ''}.`,
    tab: 'review', ids: { leadId: r.leadId },
  }));
  const clocks: BriefItem[] = d.sla.open.map(c => ({
    kind: 'SLA clock', title: `${c.name ?? 'Unnamed contact'}${c.org ? ` at ${c.org}` : ''}`,
    detail: `Tier ${c.tier ?? '?'}, ${(c.action ?? 'routed').replace(/_/g, ' ')} to ${c.owner ?? c.team ?? 'a team'}, due ${utc(c.dueAt)}.`,
    tab: 'stream', ids: { leadId: c.leadId },
  }));
  const headline = `${plural(d.review.length, 'review item')} waiting for a person${d.kpis.needsPerson.oldestWaitMs != null ? `, the oldest ${waitText(d.kpis.needsPerson.oldestWaitMs)}` : ''}; ${plural(d.sla.openCount, 'SLA clock')} still running.`;
  return section('needs_person', 'Needs a person now', headline, d.review.length + d.sla.openCount, [
    figure('Review items', d.review.length, 'review'),
    figure('Oldest review item waiting', d.kpis.needsPerson.oldestWaitMs, 'review', 'ms'),
    figure('SLA clocks running', d.sla.openCount, 'stream'),
  ], [...reviews, ...clocks]);
}

// ---- enterprise ------------------------------------------------------------------------------------------------------

/** The enterprise leads of the window grouped by account, newest account first, each with the people in and the rep they went to. */
function enterprise(ctx: Ctx, since: string): BriefSection {
  const rows = ctx.store.today.enterpriseLeads(since);
  const byAccount = new Map<string, EnterpriseLeadRow[]>();
  for (const r of rows) byAccount.set(r.account_id ?? r.lead_id, [...(byAccount.get(r.account_id ?? r.lead_id) ?? []), r]);
  const items = [...byAccount.values()].map((mine): BriefItem => {
    const first = mine[0];
    const people = [...new Set(mine.filter(r => r.source !== 'web_intent').map(personName))];
    // a named rep is a rep alert or an owner task; a team queue, nurture or review row has no one's name on it yet
    const reps = [...new Set(mine.flatMap(r => (r.owner && (r.route_action === 'rep_alert' || r.route_action === 'owner_task') ? [r.owner] : [])))];
    const queues = [...new Set(mine.flatMap(r => (r.owner && !reps.includes(r.owner) && r.route_action !== 'review' ? [r.owner] : [])))];
    const best = ['A', 'B', 'C', 'D'].find(t => mine.some(r => r.tier === t));
    return {
      kind: 'enterprise account', title: first.account_name ?? 'Organization not identified',
      detail: `${first.enterprise_fact ?? 'Enterprise account'}. ${people.length ? `${plural(people.length, 'person', 'people')} in: ${people.join(', ')}.` : 'Account-level web visits, no person.'} ${reps.length ? `Rep: ${reps.join(', ')}.` : `No named rep${queues.length ? `, in ${queues.join(', ')}` : ''}.`}${best ? ` Best tier ${best}.` : ''}`,
      tab: 'stream', ids: { leadId: first.lead_id, ...(first.account_id ? { accountKey: first.account_id } : {}) },
    };
  });
  const toRep = rows.filter(r => r.rule === 'R10').length;
  return section('enterprise', 'Enterprise', `${plural(rows.length, 'lead')} at ${plural(byAccount.size, 'enterprise account')} in the window; ${toRep} went to a named rep under R10.`, byAccount.size, [
    figure('Enterprise leads', rows.length, 'stream'), figure('Enterprise accounts', byAccount.size, 'stream'), figure('Sent to a named rep (R10)', toRep, 'stream'),
  ], items);
}

// ---- referrals -------------------------------------------------------------------------------------------------------

function referralItem(r: ReferralLeadRow): BriefItem {
  const ref = JSON.parse(r.referral_json) as StoredReferral;
  const who = ref.account?.name ?? `"${ref.referrer}"`;
  const standing = ref.kind === 'customer' ? `a customer owned by ${ref.account?.owner ?? 'nobody'}` : ref.kind === 'known_org' ? 'not a customer' : 'organization not identified';
  return {
    kind: 'referral', title: `${who} referred ${personName(r)}${r.account_name ?? r.company_name_raw ? ` at ${r.account_name ?? r.company_name_raw}` : ''}`,
    detail: `${who}: ${standing}. ${r.tier ? `Tier ${r.tier}. ` : ''}${ref.thanks ? 'A thank-you task for the owner is planned, not sent.' : 'No thank-you task, no owner to give it to.'}`,
    tab: 'stream', ids: { leadId: r.lead_id, ...(ref.account?.key ? { accountKey: ref.account.key } : {}) },
  };
}

function referrals(ctx: Ctx, since: string): BriefSection {
  const rows = ctx.store.today.referralLeads(since);
  const fromCustomers = rows.filter(r => (JSON.parse(r.referral_json) as StoredReferral).kind === 'customer').length;
  return section('referrals', 'Referrals', `${plural(rows.length, 'person', 'people')} named who sent them in the window; ${fromCustomers} named a customer.`, rows.length, [
    figure('Named referrals', rows.length, 'stream'), figure('Referred by a customer', fromCustomers, 'stream'),
  ], rows.map(referralItem));
}

// ---- list uploads ----------------------------------------------------------------------------------------------------

function lists(ctx: Ctx, d: Dashboard, since: string): BriefSection {
  const digests = ctx.store.today.digests();
  const mine = d.lists.filter(l => (l.lastAccepted ?? '') >= since);
  const items = mine.map((l): BriefItem => {
    const sent = digests.filter(x => x.list_name === l.name);
    const byTeam = new Map<string, number>();
    for (const x of sent) byTeam.set(x.team, (byTeam.get(x.team) ?? 0) + 1);
    const tiers = (['A', 'B', 'C', 'D', 'X'] as const).filter(t => l.byTier[t]).map(t => `${l.byTier[t]} ${t}`).join(', ');
    return {
      kind: 'list upload', title: `${l.name}: ${plural(l.rows, 'row')}`,
      detail: `Tiers ${tiers || 'none yet'}. ${l.folded} rows folded into ${plural(sent.length, 'digest')}${byTeam.size ? ` (${[...byTeam].map(([t, n]) => `${t} ${n}`).join(', ')})` : ''}, ${l.waitingForDigest} waiting for one. ${plural(l.repeatsAttached, 'repeat scan')} attached, ${plural(l.unknownOrgs, 'unknown organization')}, ${l.inFlight} still being routed.`,
      tab: 'overview', ids: { list: l.name },
    };
  });
  const rows = mine.reduce((a, l) => a + l.rows, 0);
  const sent = mine.reduce((a, l) => a + l.digests, 0);
  return section('lists', 'List uploads', `${plural(mine.length, 'list')} uploaded in the window, ${plural(rows, 'row')}, ${plural(sent, 'digest')} sent.`, mine.length, [
    figure('Lists', mine.length, 'overview'), figure('Rows', rows, 'overview'), figure('Digests sent', sent, 'overview'),
  ], items);
}

// ---- expansion signals -----------------------------------------------------------------------------------------------

function expansion(ctx: Ctx): BriefSection {
  const store = ctx.store.usage;
  if (!store.features().length) return section('expansion', 'Expansion signals', `The usage fixtures are not loaded (${ctx.usage.status}), so there are no expansion signals.`, 0, [figure('Expansion signals', 0, 'feature-pipeline')], []);
  const signals = expansionSignals(ctx, store.asOf());
  const items = signals.map((s): BriefItem => ({
    kind: 'expansion signal', title: s.account.name,
    detail: `${plural(s.evidence.uses, 'use')} of ${s.feature.label} by ${plural(s.evidence.people, 'person', 'people')}, the last on ${s.evidence.lastUse.slice(0, 10)}; no ${s.addOn.label} deal at any stage. Owner ${s.account.owner ?? 'none'}.`,
    tab: 'feature-pipeline', ids: { accountKey: s.account.key, feature: s.feature.key },
  }));
  return section('expansion', 'Expansion signals', `${plural(signals.length, 'customer')} using an add-on's preview with no deal for it.`, signals.length, [figure('Expansion signals', signals.length, 'feature-pipeline')], items);
}

// ---- outbound --------------------------------------------------------------------------------------------------------

function outbound(ctx: Ctx): BriefSection {
  const o = outboundSummary(ctx);
  if (!o.loaded || !o.summary) return section('outbound', 'Outbound', `The rate file is not loaded (${o.status}).`, 0, [figure('Ready drafts', 0, 'outbound')], []);
  const plays = Object.values(o.summary.plays) as { name: string; ready: number }[];
  const status = (s: string) => Number((o.summary.statuses as Record<string, number>)[s] ?? 0);
  const ready = status('ready');
  const waiting: BriefItem[] = o.groups.filter(g => g.status === 'link_to_confirm').map(g => ({
    kind: 'link to confirm', title: `${g.name}${g.state ? ` (${g.state})` : ''}`,
    detail: `${g.link.why.replace(/\.?$/, '.')} Confirming it ${g.link.ifConfirmed ? `puts the group in the ${g.link.ifConfirmed.replace('_', ' ')} play` : 'puts it in no play'}.`,
    tab: 'outbound', ids: { ein: g.ein },
  }));
  const held: BriefItem[] = o.groups.filter(g => g.status === 'suppressed').map(g => ({
    kind: 'suppressed', title: `${g.name}${g.state ? ` (${g.state})` : ''}`, detail: g.statusReason, tab: 'outbound', ids: { ein: g.ein, ...(g.holder?.accountKey ? { accountKey: g.holder.accountKey } : {}) },
  }));
  return section('outbound', 'Outbound', `${plural(ready, 'draft')} ready (${plays.map(p => `${p.ready} ${p.name}`).join(', ')}), ${status('blocked')} blocked, ${status('suppressed')} suppressed, ${plural(status('link_to_confirm'), 'link')} waiting for a person.`,
    status('link_to_confirm') + status('suppressed'), [
      ...plays.map(p => figure(`Ready: ${p.name}`, p.ready, 'outbound')), figure('Blocked', status('blocked'), 'outbound'),
      figure('Suppressed', status('suppressed'), 'outbound'), figure('Links waiting for a decision', status('link_to_confirm'), 'outbound'),
    ], [...waiting, ...held]);
}

// ---- feature interest this week --------------------------------------------------------------------------------------

function interest(ctx: Ctx, now: number): BriefSection {
  const since = new Date(now - INTEREST_DAYS * DAY).toISOString();
  const byFeature = groupByFeature(ctx.store.interest.rows(since));
  const refs = ctx.store.usage.features();
  const keys = refs.length ? refs.map(f => f.feature) : [...byFeature.keys()];
  const items: BriefItem[] = [];
  for (const key of keys) {
    const rows = byFeature.get(key) ?? [];
    const ref = refs.find(f => f.feature === key);
    const i = interestOf(rows, ref?.launchedAt ?? null);
    if (!i.leads) continue;
    const newest = askedOf(ctx, rows)[0];
    items.push({
      kind: 'feature interest', title: ref?.label ?? key,
      detail: `${plural(i.leads, 'person', 'people')} at ${plural(i.accounts, 'account')}, ${i.salesReady} sales-ready. Newest: ${newest.accountName ?? 'unplaced'}${newest.customer ? ' (a customer)' : ''}, ${newest.at.slice(0, 10)}.${ref?.status === 'preview' ? ' Not launched.' : ''}`,
      tab: 'feature-pipeline', ids: { feature: key },
    });
  }
  const distinct = new Set([...byFeature.values()].flat().map(r => r.contact_key ?? r.lead_id)).size;
  return section('interest', 'Feature interest this week', `${plural(distinct, 'person', 'people')} asked about ${plural(items.length, 'feature')} in the last ${INTEREST_DAYS} days.`, items.length, [
    figure('People who asked', distinct, 'feature-pipeline'), figure('Features asked about', items.length, 'feature-pipeline'),
  ], items);
}

// ---- health ----------------------------------------------------------------------------------------------------------

function health(ctx: Ctx, d: Dashboard): BriefSection {
  const trouble = ctx.store.today.troubledLeads();
  const failing = trouble.filter(t => t.status === 'failed' || t.status === 'retrying');
  const undelivered = trouble.filter(t => t.delivery === 'pending' || t.delivery === 'retrying' || t.delivery === 'dead');
  const items: BriefItem[] = [
    ...failing.map((t): BriefItem => ({
      kind: t.status === 'failed' ? 'failed lead' : 'retrying lead', title: `${t.source.replace(/_/g, ' ')} lead ${t.status}`,
      detail: `${plural(t.attempts, 'attempt')} so far; received ${utc(t.received_at)}.`, tab: 'stream', ids: { leadId: t.lead_id },
    })),
    ...undelivered.map((t): BriefItem => ({
      kind: t.delivery === 'dead' ? 'HubSpot write dead' : 'HubSpot write waiting', title: `${t.source.replace(/_/g, ' ')} lead`,
      detail: t.delivery === 'dead' ? 'The delivery gave up after its last retry.' : 'The plan is in the outbox, not yet delivered.', tab: 'stream', ids: { leadId: t.lead_id },
    })),
  ];
  const p90 = (v: number | null) => (v == null ? 'no data' : `${v} ms`);
  return section('health', 'Health', `Queue wait p90 ${p90(d.speed.queue.p90)}, time to alert p90 ${p90(d.speed.timeToAlert.p90)} (all leads with their own alert; list rows wait for their digest); ${plural(failing.length, 'lead')} failed or retrying; ${undelivered.length} HubSpot writes waiting or dead.`,
    items.length, [
      figure('Queue wait p90', d.speed.queue.p90, 'overview', 'ms'), figure('Time to alert p90', d.speed.timeToAlert.p90, 'overview', 'ms'),
      figure('Failed or retrying leads', failing.length, 'stream'), figure('HubSpot writes waiting or dead', undelivered.length, 'stream'),
    ], items);
}

/** The brief as of the context's clock, looking back `hours` hours for the sections that depend on when a lead came in. */
export function buildBrief(ctx: Ctx, hours = DEFAULT_WINDOW_HOURS): TodayBrief {
  const now = ctx.cfg.now();
  const since = new Date(now - hours * HOUR).toISOString();
  const d = computeDashboard(ctx, { now });
  return {
    generatedAt: new Date(now).toISOString(),
    window: { hours, from: since, to: new Date(now).toISOString() },
    sections: {
      needs_person: needsPerson(d), enterprise: enterprise(ctx, since), referrals: referrals(ctx, since), lists: lists(ctx, d, since),
      expansion: expansion(ctx), outbound: outbound(ctx), interest: interest(ctx, now), health: health(ctx, d),
    },
  };
}

// ---- plain text ------------------------------------------------------------------------------------------------------

/** The brief as plain text, for the terminal and for out/brief.txt. */
export function briefText(b: TodayBrief): string {
  const lines = [`Team brief, ${b.generatedAt} (looking back ${b.window.hours} hours)`, ''];
  for (const id of BRIEF_SECTIONS) {
    const s = b.sections[id];
    lines.push(s.title.toUpperCase(), `  ${s.headline}`);
    for (const i of s.items) lines.push(`  - [${i.kind}] ${i.title}. ${i.detail} (${Object.entries(i.ids).map(([k, v]) => `${k} ${v}`).join(', ')}; ${i.tab})`);
    if (s.more) lines.push(`  ... and ${s.more} more`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}
