// API read models for GET /api/outbound and GET /api/outbound/<ein>. Read-only: everything comes from the tables the
// loader filled and the link decisions people recorded; each group's play, link review, suppression and status are read
// through groupState.ts, and drafts and the HubSpot body are rendered on request from the stored finding.
import type { Ctx } from '../context';
import { buildOutboundCompanyUpsert } from '../crm/hubspot';
import type { CrmRecord } from '../crm/outbox';
import type { OutboundGroup } from '../store/outbound';
import { campaignOf, fileTerms } from './campaign';
import { draftUnavailable } from './draft';
import { rateLine } from './fact';
import { BANDS, type Patterns } from './findings';
import { belongsTo, draftOf, groupState, groupStates, type GroupState } from './groupState';
import { LINK_STATUSES } from './linkReview';
import type { ContractForm } from './patterns';
import { BASE_MAX, BASE_MIN, TIER_MAX, TIER_MIN, UNIT_MAX_CENTS, UNIT_MIN_CENTS } from './patterns';
import { PLAY_NAMES, PLAY_TEAMS, PLAYS } from './plays';
import { STATUSES, type OutboundStatus } from './status';

/** How each pattern was searched for, so a reader can check the numbers. */
function describePatterns(p: Patterns) {
  return {
    card: p.card && {
      base: p.card.value, hits: p.card.hits, distinctRates: p.card.distinctRates, runnersUp: p.card.runnersUp,
      rule: `every distinct rate from $${BASE_MIN} to $${BASE_MAX} tried as the base; a rate counts when it is a whole percent of it from ${TIER_MIN} to ${TIER_MAX}, to the cent`,
    },
    factor: p.factor && {
      unit: p.factor.value, hits: p.factor.hits, distinctRates: p.factor.distinctRates, runnersUp: p.factor.runnersUp,
      rule: `every amount from $${(UNIT_MIN_CENTS / 100).toFixed(2)} to $${(UNIT_MAX_CENTS / 100).toFixed(2)} by the cent tried as the unit; a rate counts when it is an exact whole multiple of it`,
    },
    note: 'Both patterns are inferred from the rates, not documented in the file.',
  };
}

const FORMS: ContractForm[] = ['card', 'factor', 'both', 'neither'];

/** Per play: how many groups are in it and where they stand. */
function playCounts(states: GroupState[]) {
  return Object.fromEntries(PLAYS.map(play => {
    const inPlay = states.filter(s => s.choice.play === play);
    const n = (status: OutboundStatus) => inPlay.filter(s => s.status.status === status).length;
    return [play, { name: PLAY_NAMES[play], team: PLAY_TEAMS[play], groups: inPlay.length, ready: n('ready'), blocked: n('blocked'), suppressed: n('suppressed') }];
  }));
}

function summarize(ctx: Ctx, groups: OutboundGroup[], states: GroupState[]) {
  const cells = ctx.store.outbound.bandForm();
  const count = (band: string | null, form: ContractForm) => cells.filter(c => (!band || c.band === band) && c.form === form).reduce((a, c) => a + c.groups, 0);
  return {
    bands: BANDS.map(band => {
      const inBand = groups.filter(g => g.band === band);
      return {
        band, groups: inBand.length, medianPctOfMedicare: inBand[0]?.bandMedianPct ?? null,
        // card and factor count a group that fits both in both columns, as the take-home's table does
        card: count(band, 'card') + count(band, 'both'), factor: count(band, 'factor') + count(band, 'both'), both: count(band, 'both'), neither: count(band, 'neither'),
      };
    }),
    forms: Object.fromEntries(FORMS.map(f => [f, count(null, f)])),
    fit: { target: groups.filter(g => g.fit === 'target').length, notTarget: groups.filter(g => g.fit === 'not_target').length },
    // the platform play's mapping as the loader stored it (decision 20); what a team can send now is in plays and statuses
    drafts: { ready: groups.filter(g => g.draftStatus === 'ready').length, blocked: groups.filter(g => g.draftStatus === 'blocked').length },
    plays: playCounts(states),
    statuses: Object.fromEntries(STATUSES.map(st => [st, states.filter(s => s.status.status === st).length])),
    links: Object.fromEntries(LINK_STATUSES.map(st => [st, states.filter(s => s.review.status === st).length])),
  };
}

/** One group's play, link review and status as the list shows them. */
function workOf(s: GroupState) {
  const r = s.review;
  return {
    play: s.choice.play, playReason: s.choice.reason, team: s.choice.play ? PLAY_TEAMS[s.choice.play] : null,
    status: s.status.status, statusReason: s.status.reason,
    link: {
      status: r.status, why: r.why, accountKey: belongsTo(r)?.accountId ?? null, accountName: belongsTo(r)?.accountName ?? null,
      probable: r.probable, decision: r.decision, ifConfirmed: s.choice.ifConfirmed,
    },
    holder: s.hold && { by: s.hold.by, owner: s.hold.owner, detail: s.hold.detail, accountKey: s.hold.accountKey, leadId: s.hold.leadId },
  };
}

/** GET /api/outbound */
export function outboundSummary(ctx: Ctx) {
  const store = ctx.store.outbound;
  const file = store.file();
  if (!file) return { loaded: false, status: ctx.outbound.status, reason: ctx.outbound.message, file: { path: ctx.outbound.path }, patterns: null, summary: null, groups: [] };
  const groups = store.allGroups();
  const states = groupStates(ctx, groups);
  const linked = store.linkedAccounts();
  return {
    loaded: true, status: ctx.outbound.status, reason: null,
    file: { path: file.path, sha256: file.sha256, rows: file.rows, groups: groups.length, ...file.scope, loadedAt: file.loadedAt },
    patterns: describePatterns(store.patterns()),
    summary: summarize(ctx, groups, states),
    // link decisions are written through the demo actions, since sign-in is not built (decision 28)
    actions: { linkDecisions: ctx.cfg.demoRoutes, export: '/api/outbound/export.csv' },
    groups: states.map(({ group: g, ...rest }) => ({
      ein: g.ein, accountKey: g.accountKey, name: g.name, city: g.city, state: g.state, clinicians: g.clinicians, band: g.band, rate: g.rate,
      medicare: g.medicare, pctOfMedicare: g.pctOfMedicare, form: g.form, cardTier: g.cardTier, factorMultiple: g.factorMultiple,
      fit: g.fit, fitReason: g.fitReason, platform: g.platform, platformConfirmed: g.platformConfirmed, draftStatus: g.draftStatus,
      draftReason: g.draftReason, hook: g.hook, registryAccountKey: linked.get(g.ein) ?? null,
      ...workOf({ group: g, ...rest }),
    })),
  };
}

/**
 * The dry-run HubSpot record for a group: a company upsert for a group in a play, carrying the play and the link status;
 * nothing for a group someone already has or a group in no play. Never enqueued, never sent.
 */
function hubspotPlan(s: GroupState, rateScope: string): CrmRecord {
  const g = s.group;
  if (s.hold) return { mode: 'dry_run', requests: [], skipped: `suppressed: ${s.hold.detail}` };
  if (!s.choice.play) return { mode: 'dry_run', requests: [], skipped: `not a target: ${s.choice.reason}` };
  const upsert = buildOutboundCompanyUpsert({ ...g, registryAccountKey: belongsTo(s.review)?.accountId ?? null, rateScope, play: s.choice.play, linkStatus: s.review.status });
  return { mode: 'dry_run', requests: [upsert], skipped: null };
}

/** GET /api/outbound/<ein>, or null when there is no such group. */
export function outboundDetail(ctx: Ctx, ein: string) {
  const store = ctx.store.outbound;
  const file = store.file();
  const g = file ? store.group(ein) : null;
  if (!file || !g) return null;
  const patterns = store.patterns();
  const campaign = campaignOf(file.scope, store.allGroups(), patterns);
  const state = groupState(ctx, g);
  const rateScope = `${file.scope.payer} ${file.scope.network} ${file.scope.code} ${file.scope.networkMonth}`;
  return {
    finding: g,
    sourceRows: store.sourceRows(ein),
    // the loader's own link record, with its candidates; linkReview below is what it means now
    link: store.link(ein),
    work: workOf(state),
    linkReview: state.review,
    draft: draftOf(state, campaign),
    draftUnavailable: draftUnavailable(campaign),
    // the line an inbound lead from this organization would carry in its brief, alert and task
    rateLine: rateLine(g, fileTerms(file.scope), patterns.card?.value ?? null, 1),
    hubspot: hubspotPlan(state, rateScope),
  };
}

/** The no-file explanation for a detail request, or null when a file is loaded. */
export const outboundNotLoaded = (ctx: Ctx): string | null => (ctx.store.outbound.file() ? null : ctx.outbound.message);
