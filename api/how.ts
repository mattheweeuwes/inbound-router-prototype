// GET /api/how: the figures the How it works tab renders from the running server rather than from its own text (decision 34):
// the registry's counts, which differ between the real registry and the mini one the tests use. Every other figure on the
// tab is a literal that test/how-it-works.test.ts checks against the constant it names.
import { getCtx, type Ctx } from '../src/context';
import { registryCounts } from '../src/resolve/registry';
import { jsonResponse, methodNotAllowed } from './_util';

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  return jsonResponse(200, { registry: { kind: ctx.registry.kind, ...registryCounts(ctx.db) } });
}
