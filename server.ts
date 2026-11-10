// Local dev server: node:http in front of the Web-standard handlers in api/, plus static files from public/.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import accounts from './api/accounts';
import attribution from './api/attribution';
import dashboard from './api/dashboard';
import demo from './api/demo';
import evalHandler from './api/eval';
import inbound from './api/inbound';
import leads from './api/leads';
import metrics from './api/metrics';
import outbound from './api/outbound';
import quality from './api/quality';
import stream from './api/stream';
import usage from './api/usage';
import { getCtx } from './src/context';
import { warmOllama } from './src/qualify/llm';
import { resumePending } from './src/pipeline';
import { signedDoorWarning } from './src/sources';

/** The folder a module URL lives in, as a file-system path. URL.pathname keeps percent-encoding ("Business%20Drive"), so it is never used for paths. */
export const dirOf = (moduleUrl: string) => fileURLToPath(new URL('.', moduleUrl));
const ROOT = dirOf(import.meta.url);
export const PUBLIC = join(ROOT, 'public');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

type Handler = (req: Request) => Promise<Response>;
const routes: [RegExp, Handler][] = [
  [/^\/api\/inbound\/?$/, inbound], [/^\/api\/leads(\/[^/]+)?\/?$/, leads], [/^\/api\/metrics\/?$/, metrics], [/^\/api\/eval\/?$/, evalHandler], [/^\/api\/quality\/?$/, quality],
  [/^\/api\/demo\/(submit|replay)\/?$/, demo], [/^\/api\/stream\/?$/, stream], [/^\/api\/dashboard\/?$/, dashboard], [/^\/api\/outbound(\/[^/]+(\/link)?)?\/?$/, outbound],
  [/^\/api\/usage\/?$/, usage], [/^\/api\/attribution\/?$/, attribution], [/^\/api\/accounts(\/[^/]+)?\/?$/, accounts],
];

async function toWebRequest(req: IncomingMessage, port: number): Promise<Request> {
  const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const hasBody = !['GET', 'HEAD'].includes(req.method ?? 'GET');
  const ac = new AbortController();
  res_close(req, ac);
  return new Request(url, { method: req.method, headers, body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined, signal: ac.signal, duplex: 'half' } as RequestInit);
}
function res_close(req: IncomingMessage, ac: AbortController) { req.on('close', () => { if (!req.complete || req.destroyed) ac.abort(); }); }

async function sendWeb(res: ServerResponse, web: Response, req: IncomingMessage) {
  res.writeHead(web.status, Object.fromEntries(web.headers));
  if (!web.body) return res.end();
  const reader = web.body.getReader();
  res.on('close', () => { reader.cancel().catch(() => {}); });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch { /* client went away */ }
  res.end();
  void req;
}

function serveStatic(pathname: string, res: ServerResponse): boolean {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + sep) && file !== PUBLIC) return false;
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
  return true;
}

export function start(port = getCtx().cfg.port) {
  const ctx = getCtx();
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      const route = routes.find(([re]) => re.test(pathname));
      if (route) return await sendWeb(res, await route[1](await toWebRequest(req, port)), req);
      if (pathname.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(pathname, res)) return;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      console.error('request failed:', (e as Error).message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });
  server.listen(port, ctx.cfg.host, () => {
    console.log(`inbound router on http://${ctx.cfg.host}:${port}  demo-routes=${ctx.cfg.demoRoutes ? 'on' : 'off'}  registry=${ctx.registry.kind}  llm=${ctx.cfg.llmProvider}  hubspot=${ctx.cfg.hubspotLive ? 'LIVE' : 'dry-run'}`);
    const warning = signedDoorWarning(ctx.cfg);
    if (warning) console.warn(warning);
    console.log(`outbound: ${ctx.outbound.message} (${ctx.outbound.status}, ${ctx.outbound.ms} ms)`);
    console.log(`usage: ${ctx.usage.message} (${ctx.usage.status}, ${ctx.usage.ms} ms)`);
    const resumed = resumePending(ctx);
    if (resumed) console.log(`resumed ${resumed} unfinished lead(s)`);
    void warmOllama(ctx).then(ok => console.log(ok ? 'ollama warm' : 'ollama not available (rules only)'));
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (process.argv[1] && process.argv[1].endsWith('server.ts')) start();
