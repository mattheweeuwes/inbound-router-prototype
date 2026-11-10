// POST /api/usage: a PostHog-style batch of product events (a bare array, { batch: [...] } or one event). Each event is stored
// once per uuid; a repeat is counted as a duplicate and changes nothing. The answer says what was stored, what was a duplicate,
// what the taxonomy did not know (unmapped), what named no account (unresolved) and what could not be used (rejected).
// Unsigned, like the other doors that are not Calendly.
import { getCtx, type Ctx } from '../src/context';
import { PayloadError } from '../src/sources/common';
import { ingestUsage } from '../src/usage/ingest';
import { jsonResponse, methodNotAllowed } from './_util';

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed('POST');
  let payload: unknown;
  try { payload = JSON.parse(await req.text()); } catch { return jsonResponse(400, { error: 'body is not valid JSON' }); }
  try {
    return jsonResponse(200, ingestUsage(ctx, payload));
  } catch (e) {
    if (e instanceof PayloadError) return jsonResponse(422, { error: e.message });
    throw e;
  }
}
