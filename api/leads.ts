// GET /api/leads?limit=200 and GET /api/leads/:id
import { getCtx, type Ctx } from '../src/context';
import { leadDetail, listLeads } from '../src/view';
import { jsonResponse, methodNotAllowed, notFound } from './_util';

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const url = new URL(req.url);
  const m = url.pathname.match(/\/api\/leads\/([^/]+)\/?$/);
  if (m) {
    const d = leadDetail(ctx, decodeURIComponent(m[1]));
    return d ? jsonResponse(200, d) : notFound(`no lead with id ${m[1]}`);
  }
  const limit = Number(url.searchParams.get('limit') ?? 200);
  return jsonResponse(200, { leads: listLeads(ctx, Number.isFinite(limit) ? limit : 200) });
}
