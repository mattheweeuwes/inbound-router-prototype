// Stage runner: normalize -> resolve -> qualify -> score -> route -> notify -> crm.
// One lead at a time (a single-flight queue), so round-robin and dedupe never race.
// Every stage is timed into stage_log. Re-running a lead replaces its derived rows and the CRM writes upsert, but a re-run can repeat an alert; boot recovery accepts that.
import { randomUUID } from 'node:crypto';
import { buildBrief } from './brief';
import type { Ctx } from './context';
import { json, parse } from './db';
import { normalizeEvent } from './normalize';
import { executeCrm, planCrm, recordDryRun } from './crm/hubspot';
import { buildSlackPayload, recordSlack } from './notify/slack';
import { qualify } from './qualify';
import { inferEmployer, resolve } from './resolve';
import { crmIdentity, matchMirror } from './mirror';
import { registryLookups } from './resolve/domain';
import { afterHours, decideRoute, type Rep } from './route';
import type { CrmMirrorEntry, CrmRequest, LeadEvent, Normalized, Qualification, Resolution, Route, Score, Team } from './schema';
import { scoreLead } from './score';
import { adapt } from './sources';

const DAY = 86_400_000;
const WEB_INTENT_POINTS = 6, WEB_INTENT_CAP = 12, OTHER_LEAD_POINTS = 4, ACCOUNT_INTENT_CAP = 12;

export interface IngestResult { leadId: string; duplicate: boolean }

export function ingest(ctx: Ctx, ev: LeadEvent): IngestResult {
  const existing = ctx.db.prepare(`SELECT id FROM lead_events WHERE source = ? AND source_event_id = ?`).get(ev.source, ev.sourceEventId) as { id: string } | undefined;
  if (existing) {
    // Idempotent replay: no new lead, no new work. Only a stage_log row so the cockpit can show it happened.
    ctx.db.prepare(`INSERT INTO stage_log (lead_id, stage, started_at, ms, ok, note) VALUES (?, 'idempotent_replay', ?, 0, 1, ?)`)
      .run(existing.id, new Date(ctx.cfg.now()).toISOString(), `duplicate delivery of ${ev.source}:${ev.sourceEventId}`);
    ctx.bus.emit('lead', { id: existing.id, status: 'idempotent_replay' });
    return { leadId: existing.id, duplicate: true };
  }
  const id = randomUUID();
  const nowIso = new Date(ctx.cfg.now()).toISOString();
  // One transaction: an event recorded without its lead would block the re-delivery (same key) and never be processed.
  ctx.db.exec('BEGIN');
  try {
    ctx.db.prepare(`INSERT INTO lead_events (id, source, source_event_id, received_at, synthetic, raw_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, ev.source, ev.sourceEventId, ev.receivedAt, ev.synthetic ? 1 : 0, JSON.stringify(ev.raw));
    ctx.db.prepare(`INSERT INTO leads (id, status, created_at, updated_at) VALUES (?, 'received', ?, ?)`).run(id, nowIso, nowIso);
    ctx.db.exec('COMMIT');
  } catch (e) { ctx.db.exec('ROLLBACK'); throw e; }
  ctx.bus.emit('lead', { id, status: 'received' });
  enqueue(ctx, id);
  return { leadId: id, duplicate: false };
}

export function enqueue(ctx: Ctx, leadId: string) {
  ctx.q.pending++;
  ctx.q.chain = ctx.q.chain.then(() => processLead(ctx, leadId)).catch(() => {}).finally(() => { ctx.q.pending--; });
}

export async function whenIdle(ctx: Ctx) {
  while (ctx.q.pending > 0) await ctx.q.chain;
}

/** Boot recovery: anything accepted (202) but not finished is processed again. */
export function resumePending(ctx: Ctx): number {
  const rows = ctx.db.prepare(`SELECT l.id FROM leads l JOIN lead_events e ON e.id = l.id WHERE l.status NOT IN ('done', 'failed') ORDER BY e.received_at`).all() as { id: string }[];
  for (const r of rows) enqueue(ctx, r.id);
  // HubSpot writes that threw twice before the restart are sent again, behind the leads above in the same queue
  ctx.q.pending++;
  ctx.q.chain = ctx.q.chain.then(() => retryCrmWrites(ctx)).catch(() => {}).finally(() => { ctx.q.pending--; });
  return rows.length;
}

/** A live HubSpot call that threw (network error or the 10 s timeout), after the one retry. */
class CrmUnreachable extends Error {}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** executeCrm, retried once after a short pause when it throws. Dry-run never fetches, so it never throws and never waits. */
async function executeWithRetry(ctx: Ctx, requests: CrmRequest[]): ReturnType<typeof executeCrm> {
  try {
    return await executeCrm(ctx, requests);
  } catch {
    await sleep(ctx.cfg.crmRetryDelayMs);
    try {
      return await executeCrm(ctx, requests);
    } catch (e) {
      throw new CrmUnreachable((e as Error).message);
    }
  }
}

/**
 * Boot recovery for HubSpot writes that threw twice (crm_json.retryPending). Sends each stored plan once more.
 * Re-sending is safe: contacts upsert on email, companies upsert on serif_account_key, the association PUT is a no-op
 * when it exists, and a task is created only when no open task with the same subject is already on the contact or
 * company (findOpenTask). The one gap is HubSpot's search lag, which can let a task through twice; that was accepted
 * in executeCrm (a duplicate costs less than a missed follow-up). So every request is repeated, none is skipped.
 * Live mode only: dry-run never calls fetch, and a lead never has retryPending in dry-run.
 */
export async function retryCrmWrites(ctx: Ctx): Promise<{ attempted: number; sent: number }> {
  if (!ctx.cfg.hubspotLive || !ctx.cfg.hubspotToken) return { attempted: 0, sent: 0 };
  const rows = ctx.db.prepare(`SELECT id, crm_json FROM leads WHERE status = 'done' AND crm_json LIKE '%retryPending%' ORDER BY created_at`).all() as { id: string; crm_json: string }[];
  let attempted = 0, sent = 0;
  for (const r of rows) {
    const crm = parse<any>(r.crm_json);
    if (!crm?.retryPending || !Array.isArray(crm.requests)) continue;
    attempted++;
    const startedAt = new Date(ctx.cfg.now()).toISOString();
    const t = performance.now();
    const log = (ok: number, note: string | null) => ctx.db.prepare(`INSERT INTO stage_log (lead_id, stage, started_at, ms, ok, note) VALUES (?, 'crm_retry', ?, ?, ?, ?)`).run(r.id, startedAt, Math.round(performance.now() - t), ok, note);
    try {
      const exec = await executeCrm(ctx, crm.requests);
      // HTTP error responses are stored like a first-time write (ok false, per-request status) and are not retried again
      const { retryPending: _r, error: _e, ...rest } = crm;
      ctx.db.prepare(`UPDATE leads SET crm_json = ?, updated_at = ? WHERE id = ?`)
        .run(json({ ...rest, mode: exec.mode, ok: exec.ok, responses: exec.responses, ...(exec.ownerMapped ? { ownerMapped: exec.ownerMapped } : {}) }), new Date(ctx.cfg.now()).toISOString(), r.id);
      log(1, exec.ok ? 'retried at boot: sent' : 'retried at boot: HubSpot answered with an error status');
      sent++;
    } catch (e) {
      log(0, (e as Error).message.slice(0, 300));
    }
  }
  return { attempted, sent };
}

function setStatus(ctx: Ctx, id: string, status: string, extra: Record<string, unknown> = {}) {
  const cols = Object.keys(extra);
  const sql = `UPDATE leads SET status = ?, updated_at = ?${cols.map(c => `, ${c} = ?`).join('')} WHERE id = ?`;
  ctx.db.prepare(sql).run(status, new Date(ctx.cfg.now()).toISOString(), ...cols.map(c => extra[c] as never), id);
  const row = ctx.db.prepare(`SELECT tier, route_action FROM leads WHERE id = ?`).get(id) as any;
  ctx.bus.emit('lead', { id, status, ...(row?.tier ? { tier: row.tier } : {}), ...(row?.route_action ? { routeAction: row.route_action } : {}) });
}

async function timed<T>(ctx: Ctx, id: string, stage: string, timings: Record<string, number>, fn: () => Promise<T> | T): Promise<T> {
  const startedAt = new Date(ctx.cfg.now()).toISOString();
  const t = performance.now();
  try {
    const out = await fn();
    const ms = Math.round(performance.now() - t);
    timings[stage] = ms;
    ctx.db.prepare(`INSERT INTO stage_log (lead_id, stage, started_at, ms, ok, note) VALUES (?, ?, ?, ?, 1, NULL)`).run(id, stage, startedAt, ms);
    return out;
  } catch (e) {
    const ms = Math.round(performance.now() - t);
    ctx.db.prepare(`INSERT INTO stage_log (lead_id, stage, started_at, ms, ok, note) VALUES (?, ?, ?, ?, 0, ?)`).run(id, stage, startedAt, ms, (e as Error).message.slice(0, 300));
    throw e;
  }
}

function findMirror(ctx: Ctx, res: Resolution, n: Normalized): CrmMirrorEntry | null {
  return matchMirror(ctx.mirror, n.companyDomain, res.accountName);
}

/** The owner a rep claimed on an earlier lead (accounts.owner). Seeded CRM owners are never stored here; they live in the mirror file. */
function claimedOwnerOf(ctx: Ctx, accountId: string | null): string | null {
  if (!accountId) return null;
  return ((ctx.db.prepare(`SELECT owner FROM accounts WHERE id = ?`).get(accountId) as any)?.owner as string | null) ?? null;
}

export function upsertAccount(ctx: Ctx, res: Resolution, n: Normalized, owner: string | null, atIso: string) {
  if (!res.accountId) return;
  const ids: Record<string, unknown> = {};
  const [kind, val] = [res.accountId.split(':')[0], res.accountId.slice(res.accountId.indexOf(':') + 1)];
  ids[kind] = val;
  if (res.firmographics.ccns?.length) ids.ccns = res.firmographics.ccns;
  if (res.firmographics.npi) ids.npi = res.firmographics.npi;
  ctx.db.prepare(`INSERT INTO accounts (id, name, segment, subsegment, domain, ids_json, firmographics_json, owner, intent_points, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, segment = excluded.segment, subsegment = excluded.subsegment,
      domain = COALESCE(excluded.domain, accounts.domain), ids_json = excluded.ids_json, firmographics_json = excluded.firmographics_json,
      owner = COALESCE(excluded.owner, accounts.owner), updated_at = excluded.updated_at`)
    .run(res.accountId, res.accountName, res.segment, res.subsegment, n.companyDomain, json(ids), json(res.firmographics), owner, atIso, atIso);
}

function pickRepFromDb(ctx: Ctx, team: Team, atIso: string): Rep | null {
  const reps = ctx.owners.teams[team]?.reps ?? [];
  if (!reps.length) return null;
  const since = new Date(Date.parse(atIso) - DAY).toISOString();
  const stats = reps.map((r, order) => {
    const last = (ctx.db.prepare(`SELECT MAX(at) a FROM assignments WHERE owner = ?`).get(r.name) as any).a as string | null;
    const load = (ctx.db.prepare(`SELECT COUNT(*) c FROM assignments WHERE owner = ? AND at >= ?`).get(r.name, since) as any).c as number;
    return { r, order, last: last ?? '', load };
  });
  const open = stats.filter(s => s.load < s.r.capacity);
  const pool = open.length ? open : [...stats].sort((a, b) => a.load - b.load).slice(0, 1);
  pool.sort((a, b) => (a.last < b.last ? -1 : a.last > b.last ? 1 : a.order - b.order));
  return { name: pool[0].r.name, hubspotOwnerId: pool[0].r.hubspotOwnerId };
}

function ownerId(ctx: Ctx, owner: string): string | null {
  for (const t of Object.values(ctx.owners.teams)) for (const r of t.reps) if (r.name === owner) return r.hubspotOwnerId;
  for (const q of Object.values(ctx.owners.queues)) if (q.owner === owner) return q.hubspotOwnerId;
  return null;
}

function wipeDerived(ctx: Ctx, id: string, receivedAt: string) {
  // a re-run releases any account this lead claimed, so the claim is made again (or not) on the fresh result
  for (const c of ctx.db.prepare(`SELECT account_id, detail FROM account_signals WHERE type = 'claim' AND detail LIKE ?`).all(`[${id}]%`) as any[]) {
    const owner = String(c.detail).replace(/^\[[^\]]+\]\s*/, '').split(' ')[0];
    ctx.db.prepare(`UPDATE accounts SET owner = NULL WHERE id = ? AND owner = ?`).run(c.account_id, owner);
  }
  ctx.db.prepare(`DELETE FROM account_signals WHERE type = 'claim' AND detail LIKE ?`).run(`[${id}]%`);
  ctx.db.prepare(`DELETE FROM stage_log WHERE lead_id = ? AND stage != 'idempotent_replay'`).run(id);
  ctx.db.prepare(`DELETE FROM assignments WHERE lead_id = ?`).run(id);
  ctx.db.prepare(`DELETE FROM review_queue WHERE lead_id = ?`).run(id);
  ctx.db.prepare(`DELETE FROM account_signals WHERE type = 'web_intent' AND at = ? AND detail LIKE ?`).run(receivedAt, `[${id}]%`);
}

export async function processLead(ctx: Ctx, id: string): Promise<void> {
  const row = ctx.db.prepare(`SELECT e.source, e.received_at, e.raw_json, e.synthetic, l.created_at FROM lead_events e JOIN leads l ON l.id = e.id WHERE e.id = ?`).get(id) as any;
  if (!row) return;
  // Time to route is measured from receipt (the 202), because that is what the prospect experiences. The part spent waiting for this
  // prototype's single-flight queue is reported separately as timings.queued; a production queue would run workers in parallel.
  const t0 = Date.parse(row.created_at);
  const timings: Record<string, number> = { queued: Math.max(0, ctx.cfg.now() - t0) };
  try {
    const ev = adapt(row.source, JSON.parse(row.raw_json), row.received_at);
    ev.receivedAt = row.received_at;
    wipeDerived(ctx, id, ev.receivedAt);

    // ---- normalize + dedupe
    const { n, duplicate, priorTouches, lastAlertAt } = await timed(ctx, id, 'normalize', timings, () => {
      const n = normalizeEvent(ev, registryLookups(ctx.db));
      let duplicate: { leadId: string; owner: string; team: Team } | null = null;
      let priorTouches = 0, lastAlertAt: string | null = null;
      if (n.contactKey) {
        const since = new Date(Date.parse(ev.receivedAt) - 30 * DAY).toISOString();
        const prior = ctx.db.prepare(`SELECT l.id, l.owner, l.route_team, l.route_action, l.alert_json, e.received_at FROM leads l JOIN lead_events e ON e.id = l.id
          WHERE l.contact_key = ? AND l.id != ? AND e.received_at < ? AND e.received_at >= ? AND l.status = 'done' ORDER BY e.received_at ASC`)
          .all(n.contactKey, id, ev.receivedAt, since) as any[];
        const live = prior.filter(p => !['drop', 'careers', 'press'].includes(p.route_action));
        priorTouches = live.length; // every live touch counts for scoring
        // Only a touch that went to sales carries an owner worth attaching to. A guide download that went to nurture (Marketing) must not
        // swallow the demo request that follows it: R2 would attach the demo to Marketing and write no CRM task.
        const withOwner = live.filter(p => ['rep_alert', 'owner_task', 'team_queue', 'review'].includes(p.route_action));
        if (withOwner.length) {
          const first = withOwner[0];
          duplicate = { leadId: first.id, owner: first.owner, team: first.route_team as Team };
          for (const p of live) if (parse<any>(p.alert_json)?.slack && !parse<any>(p.alert_json)?.suppressed) lastAlertAt = p.received_at;
        }
      }
      setStatus(ctx, id, 'normalized', {
        email: n.email, email_domain: n.emailDomain, is_free_mail: n.isFreeMail ? 1 : 0, is_disposable: n.isDisposable ? 1 : 0,
        first_name: n.firstName, last_name: n.lastName, title: n.title, title_function: n.titleFunction, title_seniority: n.titleSeniority,
        company_name_raw: n.companyRaw, company_domain: n.companyDomain, state: n.state, country: n.country, message: n.message,
        utm_source: n.utm.source ?? null, utm_medium: n.utm.medium ?? null, utm_campaign: n.utm.campaign ?? null, utm_content: n.utm.content ?? null, utm_term: n.utm.term ?? null,
        channel: n.channel, landing_page: n.landingPage, referrer: n.referrer, contact_key: n.contactKey, duplicate_of: duplicate?.leadId ?? null,
        normalized_json: json(n),
      });
      return { n, duplicate, priorTouches, lastAlertAt };
    });

    // ---- resolve
    let res = await timed(ctx, id, 'resolve', timings, async () => {
      const r = await resolve(ctx, ev, n);
      // an account in the CRM that no public registry knows keeps the CRM record's identity and segment (before anything stores or scores it)
      return crmIdentity(r, n, ctx.mirror);
    });
    upsertAccount(ctx, res, n, null, ev.receivedAt);
    setStatus(ctx, id, 'resolved', { resolution_json: json(res), account_id: res.accountId, segment: res.segment });

    // ---- qualify
    const qual: Qualification = await timed(ctx, id, 'qualify', timings, () => qualify(ctx, ev, n, res));
    const refined = inferEmployer(res, n, qual.final.useCase);
    if (refined !== res) { res = refined; upsertAccount(ctx, res, n, null, ev.receivedAt); }
    setStatus(ctx, id, 'qualified', { qualification_json: json(qual), resolution_json: json(res), segment: res.segment });

    // ---- score
    const score: Score = await timed(ctx, id, 'score', timings, () => {
      const since = new Date(Date.parse(ev.receivedAt) - 30 * DAY).toISOString();
      let accountIntent = 0; const notes: string[] = [];
      if (res.accountId && ev.source !== 'web_intent') {
        const wi = (ctx.db.prepare(`SELECT COUNT(*) c FROM account_signals WHERE account_id = ? AND type = 'web_intent' AND at >= ? AND at <= ?`).get(res.accountId, since, ev.receivedAt) as any).c as number;
        const web = Math.min(WEB_INTENT_CAP, wi * WEB_INTENT_POINTS);
        const others = (ctx.db.prepare(`SELECT COUNT(DISTINCT l.contact_key) c FROM leads l JOIN lead_events e ON e.id = l.id
          WHERE l.account_id = ? AND l.id != ? AND l.contact_key IS NOT NULL AND l.contact_key != ? AND e.received_at >= ? AND e.received_at < ? AND l.status = 'done' AND COALESCE(l.route_action,'') NOT IN ('drop','careers','press')`)
          .get(res.accountId, id, n.contactKey ?? '', since, ev.receivedAt) as any).c as number;
        accountIntent = Math.min(ACCOUNT_INTENT_CAP, web + others * OTHER_LEAD_POINTS);
        if (web) notes.push(`${wi} web-intent signal(s)`);
        if (others) notes.push(`${others} other contact(s) at this account`);
      }
      const s = scoreLead({ ev, n, res, final: qual.final, priorTouches, accountIntent, accountIntentNote: notes.join(', ') });
      setStatus(ctx, id, 'scored', { score_json: json(s), score: s.total, tier: s.tier });
      return s;
    });

    // ---- route
    let claimed: string | null = null; // set when this lead's rep alert claimed the account
    const route: Route = await timed(ctx, id, 'route', timings, () => {
      const mirror = findMirror(ctx, res, n);
      const claimedOwner = claimedOwnerOf(ctx, res.accountId);
      const route = decideRoute({
        ev, n, res, qual, score, mirror, claimedOwner, owners: ctx.owners,
        duplicate: duplicate ? { ...duplicate, lastAlertAt } : null,
        pickRep: team => pickRepFromDb(ctx, team, ev.receivedAt),
      });
      if (route.action === 'rep_alert' && !route.alertSuppressed) {
        // A rep alert under R8 to a named rep on an account nobody owns claims the account, in the same transaction as the assignment.
        // This simulates HubSpot's company owner being set by the company upsert, and it is what keeps two reps off one account.
        const namedRep = (ctx.owners.teams[route.team]?.reps ?? []).some(r => r.name === route.owner);
        const claims = route.rule === 'R8' && namedRep && !!res.accountId && !claimedOwner && !mirror && ev.source !== 'web_intent';
        ctx.db.exec('BEGIN');
        try {
          ctx.db.prepare(`INSERT INTO assignments (owner, team, lead_id, at) VALUES (?, ?, ?, ?)`).run(route.owner, route.team, id, ev.receivedAt);
          if (claims) {
            const upd = ctx.db.prepare(`UPDATE accounts SET owner = ?, updated_at = ? WHERE id = ? AND owner IS NULL`).run(route.owner, ev.receivedAt, res.accountId);
            if (Number(upd.changes) > 0) {
              claimed = route.owner;
              ctx.db.prepare(`INSERT INTO account_signals (account_id, type, detail, at) VALUES (?, 'claim', ?, ?)`)
                .run(res.accountId, `[${id}] ${route.owner} claimed this account on a rep alert to ${[n.firstName, n.lastName].filter(Boolean).join(' ') || n.email}`, ev.receivedAt);
            }
          }
          ctx.db.exec('COMMIT');
        } catch (e) { ctx.db.exec('ROLLBACK'); throw e; }
      }
      if (route.action === 'review') {
        const reason = qual.reviewReason ?? (res.status === 'ambiguous' ? 'ambiguous_company' : 'unresolved_company');
        ctx.db.prepare(`INSERT INTO review_queue (lead_id, reason, candidates_json, created_at, resolved) VALUES (?, ?, ?, ?, 0)`)
          .run(id, reason, json(res.candidates.slice(0, 5)), new Date(ctx.cfg.now()).toISOString());
      }
      if (route.action === 'account_signal' && res.accountId) {
        const c = ev.context as any;
        const detail = `[${id}] ${(c.visits ?? []).length} page view(s), ${c.visitors ?? '?'} visitor(s): ${(c.paths ?? []).join(', ')}`;
        ctx.db.prepare(`INSERT INTO account_signals (account_id, type, detail, at) VALUES (?, 'web_intent', ?, ?)`).run(res.accountId, detail, ev.receivedAt);
        const cnt = (ctx.db.prepare(`SELECT COUNT(*) c FROM account_signals WHERE account_id = ? AND type = 'web_intent'`).get(res.accountId) as any).c as number;
        ctx.db.prepare(`UPDATE accounts SET intent_points = ? WHERE id = ?`).run(Math.min(WEB_INTENT_CAP, cnt * WEB_INTENT_POINTS), res.accountId);
      }
      const ttr = ctx.cfg.now() - t0;
      setStatus(ctx, id, 'routed', { route_json: json(route), route_action: route.action, route_team: route.team, owner: route.owner, sla_due_at: route.slaDueAt, time_to_route_ms: ttr });
      return route;
    });
    const ttr = (ctx.db.prepare(`SELECT time_to_route_ms t FROM leads WHERE id = ?`).get(id) as any).t as number;

    // ---- notify
    // The alert goes out before the HubSpot write, so Slack never waits on HubSpot. The Slack payload is built from the brief, the score
    // and the route; nothing in it comes from the CRM stage, so there is nothing to carry across.
    const brief = buildBrief(ev, n, res, qual);
    await timed(ctx, id, 'notify', timings, () => {
      const wantsSlack = ['rep_alert', 'team_queue', 'owner_task', 'review', 'competitor_flag'].includes(route.action) || (route.action === 'attach_to_existing' && !route.alertSuppressed);
      const alert: { slack: unknown; suppressed?: boolean } = { slack: null, suppressed: route.alertSuppressed ?? false };
      if (wantsSlack) {
        const slack = buildSlackPayload({ brief, score, route, timeToRouteMs: ttr, synthetic: ev.synthetic, afterHours: afterHours(ev.receivedAt) });
        recordSlack(ctx, id, slack, new Date(ctx.cfg.now()).toISOString());
        alert.slack = slack;
      }
      setStatus(ctx, id, 'notified', { alert_json: json(alert) });
    });
    timings.alerted = ctx.cfg.now() - t0; // when the alert was out, which is what the response-time clock measures

    // ---- crm
    // A HubSpot write that throws (network error, timeout) is retried once, and if it still fails the lead finishes with the plan
    // stored as retryPending, which retryCrmWrites sends again at boot. The alert has already gone out by now.
    // (An HTTP error response does not throw; it is stored in responses and the pipeline continues, as before.)
    let plan = null as ReturnType<typeof planCrm> | null;
    try {
      await timed(ctx, id, 'crm', timings, async () => {
        plan = planCrm({ leadId: id, ev, n, res, qual, score, route, isFirstTouch: !duplicate, ownerId: ownerId(ctx, route.owner), companyOwnerId: claimed ? ownerId(ctx, claimed) : null, brief: brief.text });
        const exec = await executeWithRetry(ctx, plan.requests);
        if (exec.mode === 'dry_run') recordDryRun(ctx, id, plan.requests, new Date(ctx.cfg.now()).toISOString());
        setStatus(ctx, id, 'synced', { crm_json: json({ mode: exec.mode, requests: plan.requests, skipped: plan.skipped, ...(exec.mode === 'live' ? { ok: exec.ok, responses: exec.responses, ownerMapped: exec.ownerMapped } : {}) }) });
      });
    } catch (e) {
      if (!(e instanceof CrmUnreachable) || !plan) throw e; // only a HubSpot call that threw is survivable; the stage_log row is already written
      setStatus(ctx, id, 'synced', { crm_json: json({ mode: 'live', requests: plan.requests, skipped: plan.skipped, ok: false, error: e.message.slice(0, 300), retryPending: true }) });
    }

    timings.total = ctx.cfg.now() - t0;
    setStatus(ctx, id, 'done', { timings_json: json(timings) });
  } catch (e) {
    ctx.db.prepare(`INSERT INTO stage_log (lead_id, stage, started_at, ms, ok, note) VALUES (?, 'pipeline', ?, 0, 0, ?)`).run(id, new Date(ctx.cfg.now()).toISOString(), (e as Error).message.slice(0, 300));
    setStatus(ctx, id, 'failed');
  }
}
