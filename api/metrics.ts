import { getCtx, type Ctx } from '../src/context';
import { computeMetrics } from '../src/hygiene';
import { jsonResponse, methodNotAllowed } from './_util';

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  return jsonResponse(200, computeMetrics(ctx));
}
