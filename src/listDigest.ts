// List digests (decision 24). A list lead whose route is not a rep's alert keeps its route, SLA, review item and CRM plan, but
// its alert is folded: the lead records which list and team digest it waits for (src/stages.ts notifyStage). When the list
// has settled (none of its leads waiting or in flight, and none accepted for cfg.listQuietMs), one digest per team is built
// from the stored rows and recorded through the same Slack recorder as every other alert, and each folded lead gets the
// digest's time as its alert time. One timer per process watches for that moment; flushListDigests is also called directly,
// by a test with an injected clock and by the replay once it has posted everything.
import type { Ctx } from './context';
import { json, parse, tx } from './db';
import { digestChannel, summarizeDigest, type DigestRow, type ListBatch } from './lists';
import { buildListDigest, buildReviewDigest, recordSlack, type SlackPayload } from './notify/slack';
import { WakeUp } from './retry';
import { teamName } from './route';
import type { Resolution, Team } from './schema';
import type { ListBatchRow, PendingListRow } from './store/lists';

/** The longest a digest timer is set for at once; setTimeout cannot hold more than about 24 days, and a fire only rechecks. */
const MAX_TIMER_MS = 3_600_000;

const timers = new WeakMap<Ctx, WakeUp>();
const timer = (ctx: Ctx) => {
  let w = timers.get(ctx);
  if (!w) timers.set(ctx, (w = new WakeUp(() => { flushListDigests(ctx); armListDigests(ctx); })));
  return w;
};

/** A list may be digested once nothing of it is unfinished and its quiet period has passed (or the caller forces it). */
const settledBy = (l: PendingListRow, nowMs: number, quietMs: number, force: boolean) =>
  l.unfinished === 0 && (force || Date.parse(l.last_accepted) + quietMs <= nowMs);

/**
 * Sets the timer for the earliest list that will be quiet enough to digest. A list with a lead still in flight is left
 * alone: the commit that finishes it calls this again.
 */
export function armListDigests(ctx: Ctx) {
  const now = ctx.cfg.now();
  const due = ctx.store.lists.pending().filter(l => l.unfinished === 0).map(l => Date.parse(l.last_accepted) + ctx.cfg.listQuietMs);
  if (!due.length) return;
  timer(ctx).at(Math.min(Math.min(...due), now + MAX_TIMER_MS), now);
}

/** What a flush recorded: one entry per digest. */
export interface FlushedDigest { id: number; list: string; team: string; channel: string; rows: number }

/**
 * Records a digest for every settled list that owes one, one per team, and returns them. `force` skips the quiet period (the
 * replay calls it once everything is posted); a list with a lead still waiting or in flight is never digested.
 */
export function flushListDigests(ctx: Ctx, opts: { force?: boolean } = {}): FlushedDigest[] {
  const now = ctx.cfg.now();
  const out: FlushedDigest[] = [];
  for (const l of ctx.store.lists.pending()) {
    if (settledBy(l, now, ctx.cfg.listQuietMs, !!opts.force)) out.push(...digestList(ctx, l.list));
  }
  return out;
}

/** One list's current batch: its digests by team, recorded in one transaction, then written to the Slack record. */
function digestList(ctx: Ctx, list: string): FlushedDigest[] {
  const rows = ctx.store.lists.batch(list, ctx.store.lists.watermark(list));
  if (!rows.length) return [];
  const batch = batchOf(list, rows);
  const at = new Date(ctx.cfg.now()).toISOString();
  const synthetic = rows.every(r => !!r.synthetic);
  const folded = groupByTeam(rows.filter(r => r.digest_team && r.digest_id == null));
  const recorded: { digest: FlushedDigest; payload: SlackPayload }[] = [];
  tx(ctx.db, () => {
    for (const [team, teamRows] of folded) {
      const channel = digestChannel(team);
      const digestRows = teamRows.map(digestRowOf);
      const input = { batch, teamLabel: teamName(ctx.owners, team as Team), channel, summary: summarizeDigest(digestRows), synthetic };
      const payload = team === 'Review' ? buildReviewDigest({ ...input, rows: digestRows }) : buildListDigest(input);
      const id = ctx.store.lists.insertDigest({ list, team, channel, rows: teamRows.length, batchFrom: batch.from, batchTo: batch.to, at, payloadJson: json(payload)! });
      for (const r of teamRows) ctx.store.lists.markDigested(r.id, id, at, Math.max(0, Date.parse(at) - Date.parse(r.created_at)));
      recorded.push({ digest: { id, list, team, channel, rows: teamRows.length }, payload });
    }
  });
  for (const r of recorded) {
    recordSlack(ctx, `list:${list}`, r.payload, at);
    ctx.bus.emit('list', { list, team: r.digest.team, status: 'digested' });
  }
  return recorded.map(r => r.digest);
}

/** The list-wide figures every digest of the batch carries. */
function batchOf(list: string, rows: ListBatchRow[]): ListBatch {
  const accepted = rows.map(r => r.accepted_at).sort();
  return {
    list, rows: rows.length,
    repeatsAttached: rows.filter(r => r.route_action === 'attach_to_existing').length,
    unknownOrgs: rows.filter(r => isUnknownOrg(parse<Resolution>(r.resolution_json))).length,
    from: accepted[0], to: accepted[accepted.length - 1],
  };
}

/** Folded rows by the team whose digest they wait for, teams in the order their first row was accepted. */
function groupByTeam(rows: ListBatchRow[]): Map<string, ListBatchRow[]> {
  const m = new Map<string, ListBatchRow[]>();
  for (const r of rows) if (r.digest_team) m.set(r.digest_team, [...(m.get(r.digest_team) ?? []), r]);
  return m;
}

/** The router could not place the organization, or placed it only by inference (a benefits contact at an unknown company). */
const isUnknownOrg = (res: Resolution | null) => !res || res.status !== 'resolved' || res.inferred;

function digestRowOf(r: ListBatchRow): DigestRow {
  const res = parse<Resolution>(r.resolution_json);
  return {
    leadId: r.id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || 'Unknown', title: r.title,
    org: res?.status === 'resolved' ? res.accountName : null, companyTyped: r.company_name_raw, tier: r.tier, score: r.score,
    action: r.route_action, note: r.message, slaDueAt: r.sla_due_at, reviewReason: r.review_reason, unknownOrg: isUnknownOrg(res),
    enterprise: !!r.enterprise,
  };
}
