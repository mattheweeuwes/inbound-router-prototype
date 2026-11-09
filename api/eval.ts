// GET /api/eval: serves out/eval.json (written by `npm run eval`). Before any eval has run it answers 200 with
// { recorded: false } and a reason, so a fresh install has no failing request; the cockpit shows that as an empty state.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCtx, type Ctx } from '../src/context';
import { jsonResponse, methodNotAllowed } from './_util';

export const NO_EVAL = { recorded: false, reason: 'No eval recorded yet: `npm run eval` writes out/eval.json.' } as const;

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const f = join(ctx.cfg.outDir, 'eval.json');
  if (!existsSync(f)) return jsonResponse(200, NO_EVAL);
  return new Response(readFileSync(f, 'utf8'), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
