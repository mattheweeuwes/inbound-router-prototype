// Replays the fixture day through the real inbound handler, in timestamp order.
import { rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import inbound from '../api/inbound';
import type { Ctx } from './context';
import { clearAppData } from './db';
import { loadFixtures, type Fixture } from './fixtures';
import { flushListDigests } from './listDigest';
import { whenIdle } from './pipeline';
import { signCalendly, signingKey } from './sources';

export function clearGeneratedOut(ctx: Ctx) {
  for (const sub of ['hubspot', 'slack']) {
    try { for (const f of readdirSync(join(ctx.cfg.outDir, sub))) if (f.endsWith('.jsonl')) rmSync(join(ctx.cfg.outDir, sub, f)); } catch { /* none yet */ }
  }
}

/** POST one fixture through the inbound handler, signing it when it is a Calendly payload. */
export async function postFixture(ctx: Ctx, fx: Fixture): Promise<{ status: number; leadId: string | null; duplicate: boolean }> {
  const body = JSON.stringify(fx.payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = signingKey(fx.source, ctx.cfg);
  if (fx.source === 'calendly_demo' && key) headers['calendly-webhook-signature'] = signCalendly(key, body);
  const res = await inbound(new Request(`http://local/api/inbound?source=${fx.source}`, { method: 'POST', headers, body }), ctx);
  const j: any = await res.json().catch(() => ({}));
  return { status: res.status, leadId: j.leadId ?? null, duplicate: !!j.duplicate };
}

export interface ReplayOptions {
  paceMs?: number;
  keepOut?: boolean; // do not clear out/hubspot and out/slack first
  wait?: boolean; // wait for the pipeline to drain after each post (the CLI replay does; the live demo does not)
  onPost?: (fx: Fixture, r: { status: number; leadId: string | null; duplicate: boolean }) => void;
}

export async function runReplay(ctx: Ctx, opts: ReplayOptions = {}) {
  clearAppData(ctx.db);
  if (!opts.keepOut) clearGeneratedOut(ctx);
  const fixtures = loadFixtures(ctx.cfg);
  const results: { fixture: Fixture; status: number; leadId: string | null; duplicate: boolean }[] = [];
  ctx.bus.emit('replay', { state: 'started', count: fixtures.length });
  for (const fx of fixtures) {
    const r = await postFixture(ctx, fx);
    results.push({ fixture: fx, ...r });
    opts.onPost?.(fx, r);
    if (opts.wait) await whenIdle(ctx);
    if (opts.paceMs) await new Promise(res => setTimeout(res, opts.paceMs));
  }
  await whenIdle(ctx);
  // everything is posted and settled, so the day's lists need not wait out their quiet period for their digests
  flushListDigests(ctx, { force: true });
  ctx.bus.emit('replay', { state: 'done', count: fixtures.length });
  return results;
}
