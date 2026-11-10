// GET /api/brief?hours=24: what the team needs this morning (with no hours named, the window is BRIEF_WINDOW_HOURS, 24 by default), in one answer built from the read models that exist
// (src/todayBrief.ts). Read-only; it makes no decision of its own.
import { getCtx, type Ctx } from '../src/context';
import { buildBrief, windowHours } from '../src/todayBrief';
import { jsonResponse, methodNotAllowed } from './_util';

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  return jsonResponse(200, buildBrief(ctx, windowHours(new URL(req.url).searchParams.get('hours') ?? String(ctx.cfg.briefWindowHours))));
}
