// GET /api/quality[?sinceDays=N]: the GTM data-quality scorecard, computed from stored rows on every request. Read-only.
import { getCtx, type Ctx } from '../src/context';
import { computeScorecard } from '../src/quality';
import { jsonResponse, methodNotAllowed } from './_util';

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const raw = new URL(req.url).searchParams.get('sinceDays');
  let sinceDays: number | undefined;
  if (raw != null && raw !== '') {
    sinceDays = Number(raw);
    if (!Number.isFinite(sinceDays) || sinceDays <= 0 || sinceDays > 3650) return jsonResponse(400, { error: 'sinceDays must be a number from 1 to 3650' });
  }
  return jsonResponse(200, computeScorecard(ctx.db, { sinceDays, now: ctx.cfg.now() }));
}
