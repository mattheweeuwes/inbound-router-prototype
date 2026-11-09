// POST /api/inbound?source=<source>: verify, adapt, record, answer 202, process asynchronously.
import { getCtx, type Ctx } from '../src/context';
import { ingest } from '../src/pipeline';
import { adapt, isSource, PayloadError, SIGNED_DOORS, signingKey, verifyCalendly } from '../src/sources';
import { jsonResponse, methodNotAllowed } from './_util';

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed('POST');
  const url = new URL(req.url);
  const source = url.searchParams.get('source');
  if (!isSource(source)) return jsonResponse(400, { error: 'unknown or missing ?source=' });
  const body = await req.text();

  // Signed doors fail closed: no usable key means no lead, not an unchecked lead. Nothing is recorded on this path.
  const door = SIGNED_DOORS[source];
  if (door) {
    const key = signingKey(source, ctx.cfg);
    if (!key) return jsonResponse(503, { error: `${door.setting} is not set: the ${source} door is signed and refuses requests until its signing key is configured`, missingSetting: door.setting });
    const v = verifyCalendly(key, body, req.headers.get(door.header));
    if (!v.ok) return jsonResponse(401, { error: `signature check failed: ${v.reason}` });
  }

  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return jsonResponse(400, { error: 'body is not valid JSON' }); }

  let ev;
  try { ev = adapt(source, payload, new Date(ctx.cfg.now()).toISOString()); }
  catch (e) {
    if (e instanceof PayloadError) return jsonResponse(422, { error: e.message });
    throw e;
  }

  const r = ingest(ctx, ev);
  // A repeat delivery is acknowledged with 200 and does nothing else. A new lead is accepted with 202.
  return r.duplicate ? jsonResponse(200, { leadId: r.leadId, duplicate: true }) : jsonResponse(202, { leadId: r.leadId, status: 'received' });
}
