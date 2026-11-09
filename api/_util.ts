export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export const notFound = (what = 'not found') => jsonResponse(404, { error: what });
export const methodNotAllowed = (allow: string) => jsonResponse(405, { error: 'method not allowed' }, { allow });
