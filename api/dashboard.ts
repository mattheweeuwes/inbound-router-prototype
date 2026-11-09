// GET /api/dashboard: the cockpit's Overview, computed from stored rows and existing artifacts on every request. Read-only.
import { getCtx, type Ctx } from '../src/context';
import { computeDashboard } from '../src/dashboard';
import { jsonResponse, methodNotAllowed } from './_util';

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  return jsonResponse(200, computeDashboard(ctx));
}
