// The outbound module's API.
// GET /api/outbound: the rate file's patterns and every group with its finding, play, link review and status.
// GET /api/outbound/<ein>: one group's source rows, link review, draft or preview and dry-run HubSpot body.
// GET /api/outbound/export.csv: one row per ready draft. GET /api/outbound/export: the counts beside it.
// POST /api/outbound/<ein>/link: a person's link decision, served only with DEMO_ROUTES=1 (sign-in is not built).
// Nothing here sends anything.
import { getCtx, type Ctx } from '../src/context';
import { exportCounts, exportRows, toCsv } from '../src/outbound/export';
import { parseLinkDecision, recordLinkDecision } from '../src/outbound/linkDecision';
import { outboundDetail, outboundNotLoaded, outboundSummary } from '../src/outbound/view';
import { jsonResponse, methodNotAllowed, notFound } from './_util';

const csvResponse = (text: string) =>
  new Response(text, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="outbound-ready-drafts.csv"', 'cache-control': 'no-store' } });

async function linkDecision(req: Request, ctx: Ctx, ein: string): Promise<Response> {
  if (!ctx.cfg.demoRoutes) return notFound('the demo actions are off, so link decisions are not taken: set DEMO_ROUTES=1 to turn them on (npm run dev does). Sign-in is not built.');
  if (req.method !== 'POST') return methodNotAllowed('POST');
  const parsed = parseLinkDecision(await req.json().catch(() => null));
  if (typeof parsed === 'string') return jsonResponse(422, { error: parsed });
  const r = recordLinkDecision(ctx, ein, parsed);
  if (!r.ok) return jsonResponse(r.status, { error: outboundNotLoaded(ctx) ?? r.error });
  const detail = outboundDetail(ctx, ein);
  return jsonResponse(200, { decision: r.decision, linkReview: detail?.linkReview ?? null, work: detail?.work ?? null });
}

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/$/, '');
  const link = path.match(/\/api\/outbound\/([^/]+)\/link$/);
  if (link) return linkDecision(req, ctx, decodeURIComponent(link[1]));
  if (req.method !== 'GET') return methodNotAllowed('GET');
  if (path.endsWith('/api/outbound/export.csv')) return csvResponse(toCsv(exportRows(ctx)));
  if (path.endsWith('/api/outbound/export')) return jsonResponse(200, exportCounts(ctx));
  const m = path.match(/\/api\/outbound\/([^/]+)$/);
  if (!m) return jsonResponse(200, outboundSummary(ctx));
  const ein = decodeURIComponent(m[1]);
  const d = outboundDetail(ctx, ein);
  return d ? jsonResponse(200, d) : notFound(outboundNotLoaded(ctx) ?? `no rate group with EIN ${ein}`);
}
