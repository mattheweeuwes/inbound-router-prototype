// npm run replay: all fixtures, in timestamp order, through the real inbound handler. Prints a table, writes out/replay.json.
//   (default)       each post waits until the pipeline is idle, so no lead queues behind another
//   --pace <ms>     posts every <ms> without waiting, as the cockpit's Replay a day does (2000 there)
//   --burst         posts every event with no gap and no wait
// Then waits for everything, second opinions included, and prints time to alert and where the model ran.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCtx } from '../src/context';
import { warmOllama } from '../src/qualify/llm';
import { runReplay } from '../src/replay';
import { leadDetail } from '../src/view';
import { computeDashboard, percentile } from '../src/dashboard';
import { computeMetrics, resolutionCount } from '../src/hygiene';
import { signedDoorWarning } from '../src/sources';
import { checkTtrBudget, parseBudget } from './lib/ttr-budget';
import { refuseLiveCrmInCi } from './lib/outside-writes';

const ctx = createCtx();
const unkeyed = signedDoorWarning(ctx.cfg);
if (unkeyed) { console.error(`${unkeyed}\nThe replay posts signed fixtures through the real handler; run it with npm run replay (which sets a local demo key) or set CALENDLY_SIGNING_KEY, and rerun.`); process.exit(1); }
console.log(`registry=${ctx.registry.kind} llm=${ctx.cfg.llmProvider} hubspot=${ctx.cfg.hubspotLive ? 'LIVE' : 'dry-run'}`);
// CI never writes to a CRM: refuse before anything is posted.
const refusal = refuseLiveCrmInCi(process.env, ctx.cfg.hubspotLive);
if (refusal) { console.error(refusal); process.exit(1); }
// TTR_P90_BUDGET_MS, when set, is a hard budget on the p90 time to route. An unusable value stops the run before it starts.
let budgetMs: number | null = null;
if (process.env.TTR_P90_BUDGET_MS !== undefined) {
  try { budgetMs = parseBudget(process.env.TTR_P90_BUDGET_MS); } catch (e) { console.error((e as Error).message); process.exit(1); }
}
const mode = parseMode(process.argv.slice(2));
function parseMode(args: string[]): { label: string; wait: boolean; paceMs: number } {
  if (args.includes('--burst')) return { label: 'burst (no gap between posts)', wait: false, paceMs: 0 };
  const i = args.indexOf('--pace');
  if (i >= 0) {
    const ms = Number(args[i + 1]);
    if (!Number.isFinite(ms) || ms < 0) { console.error(`--pace needs a number of milliseconds, got ${JSON.stringify(args[i + 1])}`); process.exit(1); }
    return { label: `paced, ${ms} ms between posts`, wait: false, paceMs: ms };
  }
  return { label: 'each post waits for the pipeline', wait: true, paceMs: 0 };
}
console.log(`posting: ${mode.label}; model before route: ${ctx.cfg.modelBeforeRoute}`);
if (ctx.cfg.llmProvider === 'ollama') console.log(await warmOllama(ctx) ? 'ollama warm' : 'ollama unavailable: rules only');

const results = await runReplay(ctx, { wait: mode.wait, paceMs: mode.paceMs });
const rows = results.map(r => {
  const d: any = r.leadId && !r.duplicate ? leadDetail(ctx, r.leadId) : null;
  return {
    fixture: r.fixture.id, source: r.fixture.source, httpStatus: r.status, leadId: r.leadId, noop: r.duplicate,
    segment: d?.resolution?.segment ?? null, method: d?.resolution?.method ?? null, confidence: d?.resolution?.confidence ?? null,
    account: d?.resolution?.accountId ?? null, resolutionStatus: d?.resolution?.status ?? null,
    useCase: d?.qualification?.final?.useCase ?? null, urgency: d?.qualification?.final?.urgency ?? null, disqualifier: d?.qualification?.final?.disqualifier ?? null,
    llmUsed: !!d?.qualification?.llm, tier: d?.tier ?? null, score: d?.score?.total ?? null,
    action: r.duplicate ? 'no_op' : (d?.route?.action ?? null), team: d?.route?.team ?? null, owner: d?.route?.owner ?? null, rule: d?.route?.rule ?? null,
    flags: d?.flags ?? [], timeToRouteMs: d?.timeToRouteMs ?? null, status: d?.status ?? null,
    timings: d?.timings ?? null, secondOpinion: d?.secondOpinion?.result ?? null,
  };
});

const pad = (v: unknown, n: number) => String(v ?? '-').slice(0, n).padEnd(n);
console.log(['id', 'segment', 'method/conf', 'use_case', 'urgency', 'tier', 'scr', 'action', 'team', 'owner', 'ms'].map((h, i) => pad(h, [4, 27, 20, 25, 12, 4, 4, 18, 8, 18, 6][i])).join(' '));
for (const r of rows) {
  console.log([
    pad(r.fixture, 4), pad(r.noop ? '(idempotent re-delivery)' : r.segment, 27), pad(r.method ? `${r.method}/${r.confidence}` : null, 20), pad(r.useCase, 25), pad(r.urgency, 12),
    pad(r.tier, 4), pad(r.score, 4), pad(r.action, 18), pad(r.team, 8), pad(r.owner, 18), pad(r.timeToRouteMs, 6),
  ].join(' '));
}
const failed = rows.filter(r => r.status === 'failed');
console.log(`\n${rows.length} fixtures posted, ${rows.filter(r => r.noop).length} idempotent no-op(s), ${failed.length} failed`);
const m = computeMetrics(ctx);
const rc = resolutionCount(ctx);
console.log(`time to route p50=${m.timeToRouteMs.p50}ms p90=${m.timeToRouteMs.p90}ms max=${m.timeToRouteMs.max}ms; resolved ${rc.resolved} of ${rc.of} (web intent and drops not counted); review ${m.reviewCount}`);
const sp = computeDashboard(ctx).speed;
const so = sp.secondOpinion;
const salesAlerts = rows.filter(r => ['rep_alert', 'owner_task', 'team_queue'].includes(String(r.action)) && typeof r.timings?.alerted === 'number' && !r.flags.includes('idempotent_replay'));
const slowest = salesAlerts.reduce<(typeof rows)[number] | null>((a, r) => (!a || r.timings.alerted > a.timings.alerted ? r : a), null);
const waitedSpread = { p50: percentile(rows.filter(r => r.timings).map(r => r.timings.waitedForPrepare ?? 0), 50), p90: percentile(rows.filter(r => r.timings).map(r => r.timings.waitedForPrepare ?? 0), 90) };
const modelPath = {
  posting: mode.label, modelBeforeRoute: ctx.cfg.modelBeforeRoute,
  timeToAlert: { n: sp.timeToAlert.n, p50: sp.timeToAlert.p50, p90: sp.timeToAlert.p90, slowest: slowest ? { fixture: slowest.fixture, ms: slowest.timings.alerted } : null },
  queued: { p50: sp.queue.p50, p90: sp.queue.p90 }, waitedForPrepare: waitedSpread,
  waitedForModel: sp.model ? { n: sp.model.n, p50: sp.model.p50, p90: sp.model.p90 } : { n: 0 },
  secondOpinions: { ran: so.ran, answered: so.answered, agreed: so.agreed, changed: so.changed, roleFilled: so.roleFilled, doubts: so.doubts, followedUp: so.followedUp, p50: so.p50, p90: so.p90, afterAlertP50: so.afterAlert.p50, afterAlertP90: so.afterAlert.p90 },
};
console.log(`time to alert on ${modelPath.timeToAlert.n} sales-routed leads: p50=${modelPath.timeToAlert.p50}ms p90=${modelPath.timeToAlert.p90}ms slowest=${slowest ? `${slowest.timings.alerted}ms (${slowest.fixture})` : 'n/a'}`);
console.log(`queue wait p50=${sp.queue.p50}ms p90=${sp.queue.p90}ms; waited for own prepare p50=${waitedSpread.p50}ms p90=${waitedSpread.p90}ms`);
console.log(`model before route on ${modelPath.waitedForModel.n} lead(s)${sp.model ? ` (p50 ${sp.model.p50}ms, p90 ${sp.model.p90}ms)` : ''}; second opinions ${so.ran} (answered ${so.answered}, agreed ${so.agreed}, would change a field ${so.changed}, role filled ${so.roleFilled}, doubts ${so.doubts}, followed up ${so.followedUp})`);
const budget = budgetMs == null ? null : checkTtrBudget(m.timeToRouteMs.p90, budgetMs);
if (budget) console.log(budget.line);
mkdirSync(ctx.cfg.outDir, { recursive: true });
writeFileSync(join(ctx.cfg.outDir, 'replay.json'), JSON.stringify({ generatedAt: new Date().toISOString(), registry: ctx.registry.kind, llmProvider: ctx.cfg.llmProvider, rows, metrics: m, modelPath, ...(budget ? { ttrBudget: budget } : {}) }, null, 2));
process.exit(failed.length || (budget && !budget.pass) ? 1 : 0);
