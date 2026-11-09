// npm run replay: all fixtures, in timestamp order, through the real inbound handler. Prints a table, writes out/replay.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCtx } from '../src/context';
import { warmOllama } from '../src/qualify/llm';
import { runReplay } from '../src/replay';
import { leadDetail } from '../src/view';
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
if (ctx.cfg.llmProvider === 'ollama') console.log(await warmOllama(ctx) ? 'ollama warm' : 'ollama unavailable: rules only');

const results = await runReplay(ctx, { wait: true });
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
const budget = budgetMs == null ? null : checkTtrBudget(m.timeToRouteMs.p90, budgetMs);
if (budget) console.log(budget.line);
mkdirSync(ctx.cfg.outDir, { recursive: true });
writeFileSync(join(ctx.cfg.outDir, 'replay.json'), JSON.stringify({ generatedAt: new Date().toISOString(), registry: ctx.registry.kind, llmProvider: ctx.cfg.llmProvider, rows, metrics: m, ...(budget ? { ttrBudget: budget } : {}) }, null, 2));
process.exit(failed.length || (budget && !budget.pass) ? 1 : 0);
