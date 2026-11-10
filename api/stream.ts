// GET /api/stream: server-sent events. `lead` on every stage change, `replay` when a demo replay starts or finishes, `list`
// when an uploaded list's digest is recorded.
import { getCtx, type Ctx } from '../src/context';
import { methodNotAllowed } from './_util';

export const PING_MS = 15_000;

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { cleanup(); } };
      const onLead = (d: unknown) => send(`event: lead\ndata: ${JSON.stringify(d)}\n\n`);
      const onReplay = (d: unknown) => send(`event: replay\ndata: ${JSON.stringify(d)}\n\n`);
      const onList = (d: unknown) => send(`event: list\ndata: ${JSON.stringify(d)}\n\n`);
      ctx.bus.on('lead', onLead);
      ctx.bus.on('replay', onReplay);
      ctx.bus.on('list', onList);
      // a comment line keeps proxies and the browser from closing an idle connection
      const ping = setInterval(() => send(`: ping ${Date.now()}\n\n`), PING_MS);
      cleanup = () => { clearInterval(ping); ctx.bus.off('lead', onLead); ctx.bus.off('replay', onReplay); ctx.bus.off('list', onList); };
      req.signal.addEventListener('abort', () => { cleanup(); try { controller.close(); } catch { /* already closed */ } });
      send(': connected\n\n');
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' } });
}
