// GET /api/accounts?limit=50 and GET /api/accounts/<key> (the key URL-encoded: ahrq%3ASYS-1)
import { accountDetail, accountsLimit, listAccounts } from '../src/accounts';
import { getCtx, type Ctx } from '../src/context';
import { jsonResponse, methodNotAllowed, notFound } from './_util';

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const url = new URL(req.url);
  const m = url.pathname.match(/\/api\/accounts\/([^/]+)\/?$/);
  if (m) {
    const key = decodeURIComponent(m[1]);
    const d = accountDetail(ctx, key);
    return d ? jsonResponse(200, d) : notFound(`no account with key ${key}`);
  }
  return jsonResponse(200, listAccounts(ctx, accountsLimit(url.searchParams.get('limit'))));
}
