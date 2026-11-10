// GET /api/outbound/export.csv and GET /api/outbound/export: the ready drafts as rows a sequencer or a HubSpot list import
// can take, and beside them the counts of everything that is not a row and why. One row per ready draft, nothing else:
// a blocked draft, a group someone already has, a link waiting for a person and a group in no play are counted, not exported.
// {first_name} stays open in the texts, because the file names organizations, not people.
import type { Ctx } from '../context';
import { campaignOf } from './campaign';
import { draftUnavailable } from './draft';
import { belongsTo, draftOf, groupStates, type GroupState } from './groupState';
import { PLAY_TEAMS, PLAYS, type Play } from './plays';
import type { OutboundStatus } from './status';

/** The columns, in order. Money is in dollars to the cent; percents are whole numbers. */
export const EXPORT_COLUMNS = [
  'ein', 'account_keys', 'play', 'team', 'group_name', 'city', 'state', 'clinicians', 'rate', 'pct_of_medicare', 'city_top_rate',
  'contract_form', 'card_tier', 'conversion_factor', 'subject', 'body', 'linkedin',
] as const;
export type ExportColumn = typeof EXPORT_COLUMNS[number];
export type ExportRow = Record<ExportColumn, string>;

/** RFC 4180: a field with a comma, a quote or a line break is quoted, with its quotes doubled. Records end in CRLF. */
export function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
export const toCsv = (rows: ExportRow[]): string =>
  [EXPORT_COLUMNS.join(','), ...rows.map(r => EXPORT_COLUMNS.map(c => csvField(r[c])).join(','))].map(line => `${line}\r\n`).join('');

const money = (n: number) => n.toFixed(2);
const orEmpty = (n: number | null) => (n === null ? '' : String(n));

function rowOf(s: GroupState, play: Play, draft: { subject: string; body: string; linkedin: string }): ExportRow {
  const g = s.group;
  const system = belongsTo(s.review);
  return {
    ein: g.ein, account_keys: [g.accountKey, system?.accountId].filter(Boolean).join(';'), play, team: PLAY_TEAMS[play],
    group_name: g.name, city: g.city, state: g.state ?? '', clinicians: String(g.clinicians), rate: money(g.rate),
    pct_of_medicare: String(g.pctOfMedicare), city_top_rate: money(g.cityTopRate), contract_form: g.form,
    card_tier: orEmpty(g.cardTier), conversion_factor: orEmpty(g.factorMultiple),
    subject: draft.subject, body: draft.body, linkedin: draft.linkedin,
  };
}

/** One row per ready draft, platform play first, then system gap, each by EIN. Empty when no file is loaded. */
export function exportRows(ctx: Ctx): ExportRow[] {
  const file = ctx.store.outbound.file();
  if (!file) return [];
  const groups = ctx.store.outbound.allGroups();
  const campaign = campaignOf(file.scope, groups, ctx.store.outbound.patterns());
  const ready = groupStates(ctx, groups).filter(s => s.status.status === 'ready' && s.choice.play !== null);
  const rows: ExportRow[] = [];
  for (const play of PLAYS) {
    for (const s of ready.filter(r => r.choice.play === play).sort((a, b) => a.group.ein.localeCompare(b.group.ein))) {
      const draft = draftOf(s, campaign);
      if (draft && draft.kind === 'draft' && draft.status === 'ready') rows.push(rowOf(s, play, draft));
    }
  }
  return rows;
}

/** How many groups share each reason, most first. */
function tally<T extends string>(items: T[]): { reason: T; groups: number }[] {
  const n = new Map<T, number>();
  for (const i of items) n.set(i, (n.get(i) ?? 0) + 1);
  return [...n].map(([reason, groups]) => ({ reason, groups })).sort((a, b) => b.groups - a.groups || a.reason.localeCompare(b.reason));
}

/** GET /api/outbound/export: the counts beside the CSV. Every group is in exactly one of ready, blocked, suppressed, waiting and not a target. */
export function exportCounts(ctx: Ctx) {
  const file = ctx.store.outbound.file();
  if (!file) return { loaded: false as const, reason: ctx.outbound.message, rows: 0 };
  const groups = ctx.store.outbound.allGroups();
  const states = groupStates(ctx, groups);
  const campaign = campaignOf(file.scope, groups, ctx.store.outbound.patterns());
  const by = (status: OutboundStatus) => states.filter(s => s.status.status === status);
  const ready = by('ready');
  const suppressed = by('suppressed');
  const waiting = by('link_to_confirm');
  return {
    loaded: true as const,
    csv: '/api/outbound/export.csv',
    rows: exportRows(ctx).length,
    draftUnavailable: draftUnavailable(campaign),
    groups: groups.length,
    ready: { total: ready.length, byPlay: Object.fromEntries(PLAYS.map(p => [p, ready.filter(s => s.choice.play === p).length])) as Record<Play, number> },
    blocked: { total: by('blocked').length, why: tally(by('blocked').map(s => s.group.draftReason ?? 'the platform mapping is not confirmed')) },
    suppressed: {
      total: suppressed.length,
      why: tally(suppressed.map(s => `${s.hold?.owner ?? 'someone'} (${s.hold?.by ?? 'unknown'})`)),
      inAPlay: suppressed.filter(s => s.choice.play !== null).length,
    },
    waitingForLinkDecision: { total: waiting.length, wouldJoinSystemGap: waiting.filter(s => s.choice.ifConfirmed === 'system_gap').length },
    notTarget: by('not_target').length,
  };
}
