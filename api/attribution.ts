// GET /api/attribution: which features the accounts with deals used, as influence (not proof of cause), plus the expansion signals
// for customer success. Read-only.
import { getCtx, type Ctx } from '../src/context';
import { attributionPayload } from '../src/usage/view';
import { jsonResponse, methodNotAllowed } from './_util';

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  return jsonResponse(200, attributionPayload(ctx));
}
