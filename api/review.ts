// Needs a person (decision 33).
// GET /api/review: the open items, with what a person decides from and the decisions each takes, and the last 20 decisions.
// POST /api/leads/<id>/review: a person's decision on the lead's open item.
// POST /api/review/list: "not for sales" on every open unplaced-company row of one uploaded list.
// The two writes are served only with DEMO_ROUTES=1, like the other demo writes: sign-in is not built, so the request
// names who decided and that typed name is what is stored.
import { getCtx, type Ctx } from '../src/context';
import { decideListNurture, decideReview } from '../src/review/apply';
import { parseReviewRequest } from '../src/review/decision';
import { reviewView } from '../src/review/view';
import { jsonResponse, methodNotAllowed, notFound } from './_util';

const DEMO_OFF = 'decisions are off on this server: set DEMO_ROUTES=1 to turn them on (npm run dev does)';
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function leadDecision(req: Request, ctx: Ctx, leadId: string): Promise<Response> {
  if (!ctx.cfg.demoRoutes) return notFound(DEMO_OFF);
  if (req.method !== 'POST') return methodNotAllowed('POST');
  const parsed = parseReviewRequest(await req.json().catch(() => null));
  if (typeof parsed === 'string') return jsonResponse(422, { error: parsed });
  const r = await decideReview(ctx, leadId, parsed);
  if (!r.ok) return jsonResponse(r.status, { error: r.error });
  return jsonResponse(200, r);
}

async function listDecision(req: Request, ctx: Ctx): Promise<Response> {
  if (!ctx.cfg.demoRoutes) return notFound(DEMO_OFF);
  if (req.method !== 'POST') return methodNotAllowed('POST');
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const list = text(body?.list), by = text(body?.by), note = text(body?.note);
  if (!list) return jsonResponse(422, { error: 'list is required: the uploaded list whose unplaced-company rows go to nurture' });
  // the same name and note rules as one decision, checked once for the whole list
  const parsed = parseReviewRequest({ decision: 'not_for_sales', by, note });
  if (typeof parsed === 'string') return jsonResponse(422, { error: parsed });
  const r = await decideListNurture(ctx, list, parsed.by, parsed.note);
  if (!r.count && !r.skipped.length) return jsonResponse(404, { error: `the list "${list}" has no open unplaced-company rows`, ...r });
  return jsonResponse(200, r);
}

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/$/, '');
  const lead = path.match(/\/api\/leads\/([^/]+)\/review$/);
  if (lead) return leadDecision(req, ctx, decodeURIComponent(lead[1]));
  if (path.endsWith('/api/review/list')) return listDecision(req, ctx);
  if (!path.endsWith('/api/review')) return notFound();
  if (req.method !== 'GET') return methodNotAllowed('GET');
  return jsonResponse(200, reviewView(ctx));
}
