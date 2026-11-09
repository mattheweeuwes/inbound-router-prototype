// POST /api/demo/submit and POST /api/demo/replay. Served only when DEMO_ROUTES=1; otherwise they answer 404 as if they did not exist.
import { getCtx, type Ctx } from '../src/context';
import { buildPayload, UTM_PRESETS } from '../src/payloads';
import { runReplay } from '../src/replay';
import { SOURCES, type Source } from '../src/schema';
import { splitName } from '../src/normalize';
import { whenIdle } from '../src/pipeline';
import { signCalendly, signingKey, unkeyedSignedDoors } from '../src/sources';
import inbound from './inbound';
import { jsonResponse, methodNotAllowed, notFound } from './_util';

let replaying = false;

export default async function handler(req: Request, ctx: Ctx = getCtx()): Promise<Response> {
  if (!ctx.cfg.demoRoutes) return notFound('the demo routes are off: set DEMO_ROUTES=1 to turn them on (npm run dev does)');
  if (req.method !== 'POST') return methodNotAllowed('POST');
  const path = new URL(req.url).pathname.replace(/\/$/, '');
  const body: any = await req.json().catch(() => ({}));

  if (path.endsWith('/demo/submit')) {
    const source: Source = SOURCES.includes(body.source) && body.source !== 'web_intent' ? body.source : 'calendly_demo';
    const email = String(body.email ?? '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return jsonResponse(422, { error: 'a valid email is required' });
    const { first, last } = splitName(String(body.name ?? ''));
    const ts = new Date(ctx.cfg.now()).toISOString();
    const payload = buildPayload(source, {
      first: first ?? 'Demo', last: last ?? 'Visitor', email, title: body.title, company: body.company, state: body.state, message: body.message,
      ts, utm: UTM_PRESETS[body.utmPreset ?? 'none'] ?? {}, guide: 'Health System Executive Guide', seed: `${email}|${ts}|${Math.random()}`,
    });
    const text = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const key = signingKey(source, ctx.cfg);
    if (source === 'calendly_demo' && key) headers['calendly-webhook-signature'] = signCalendly(key, text);
    const res = await inbound(new Request(`http://local/api/inbound?source=${source}`, { method: 'POST', headers, body: text }), ctx);
    const j: any = await res.json();
    if (!res.ok) return jsonResponse(res.status, j);
    if (body.wait) await whenIdle(ctx);
    return jsonResponse(res.status === 200 ? 200 : 202, { leadId: j.leadId });
  }

  if (path.endsWith('/demo/replay')) {
    const unkeyed = unkeyedSignedDoors(ctx.cfg);
    if (unkeyed.length) return jsonResponse(503, { error: `${unkeyed.map(u => u.setting).join(', ')} is not set: the replay posts signed fixtures and would be refused`, missingSetting: unkeyed[0].setting });
    if (replaying) return jsonResponse(409, { error: 'a replay is already running' });
    const paceMs = Number.isFinite(Number(body.paceMs)) ? Math.max(0, Number(body.paceMs)) : 2000;
    replaying = true;
    // fire and forget: the cockpit follows along on /api/stream
    void runReplay(ctx, { paceMs }).catch(e => console.error('replay failed:', (e as Error).message)).finally(() => { replaying = false; });
    return jsonResponse(202, { started: true, paceMs });
  }
  return notFound();
}
