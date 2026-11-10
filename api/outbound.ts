// GET /api/outbound and GET /api/outbound/:ein: the rate file's patterns, one finding per group with its fit and draft
// status, and per group its source rows, registry link, draft or preview and dry-run HubSpot body. Read-only.
import { getCtx, type Ctx } from '../src/context';
import { outboundDetail, outboundNotLoaded, outboundSummary } from '../src/outbound/view';
import { jsonResponse, methodNotAllowed, notFound } from './_util';

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const m = new URL(req.url).pathname.match(/\/api\/outbound\/([^/]+)\/?$/);
  if (!m) return jsonResponse(200, outboundSummary(ctx));
  const ein = decodeURIComponent(m[1]);
  const d = outboundDetail(ctx, ein);
  return d ? jsonResponse(200, d) : notFound(outboundNotLoaded(ctx) ?? `no rate group with EIN ${ein}`);
}
