// The local server is local: it binds to 127.0.0.1, and the cockpit's write routes exist only when asked for.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import demo from '../api/demo';
import { makeConfig, ROOT } from '../src/config';
import { whenIdle } from '../src/pipeline';
import { listLeads } from '../src/view';
import { testCtx } from './helpers';

const body = JSON.stringify({ source: 'calendly_demo', name: 'Dana Whitfield', email: 'dana@intermountainhealthcare.org', title: 'VP Managed Care', company: 'Intermountain Health', state: 'UT', message: 'Renegotiations start in January.', wait: true });

describe('where the server listens', () => {
  it('binds to 127.0.0.1 unless HOST says otherwise', () => {
    assert.equal(makeConfig({}, {}).host, '127.0.0.1');
    assert.equal(makeConfig({}, { HOST: '' }).host, '127.0.0.1');
    assert.equal(makeConfig({}, { HOST: '  ' }).host, '127.0.0.1');
    assert.equal(makeConfig({}, { HOST: '0.0.0.0' }).host, '0.0.0.0');
    assert.equal(makeConfig({}, { HOST: '::1' }).host, '::1');
  });
  it('server.ts listens on that host, not on every interface', () => {
    const src = readFileSync(join(ROOT, 'server.ts'), 'utf8');
    assert.match(src, /server\.listen\(port, ctx\.cfg\.host,/);
    assert.doesNotMatch(src, /server\.listen\(port,\s*\(\)/);
  });
});

describe('the demo routes', () => {
  it('are off unless DEMO_ROUTES is exactly 1', () => {
    assert.equal(makeConfig({}, {}).demoRoutes, false);
    for (const v of ['', '0', 'true', 'yes', ' 1']) assert.equal(makeConfig({}, { DEMO_ROUTES: v }).demoRoutes, false, JSON.stringify(v));
    assert.equal(makeConfig({}, { DEMO_ROUTES: '1' }).demoRoutes, true);
  });

  it('answer 404 for submit and replay when off, and record and start nothing', async () => {
    const ctx = testCtx({ demoRoutes: false });
    for (const path of ['submit', 'replay']) {
      for (const method of ['POST', 'GET']) {
        const res = await demo(new Request(`http://local/api/demo/${path}`, { method, body: method === 'POST' ? body : undefined }), ctx);
        assert.equal(res.status, 404, `${method} ${path}`);
        assert.match(((await res.json()) as any).error, /DEMO_ROUTES=1/);
      }
    }
    await whenIdle(ctx);
    assert.equal(listLeads(ctx).length, 0);
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) c FROM lead_events`).get() as any).c, 0);
  });

  it('are served when on', async () => {
    const ctx = testCtx({ demoRoutes: true });
    const res = await demo(new Request('http://local/api/demo/submit', { method: 'POST', body }), ctx);
    assert.equal(res.status, 202);
    assert.equal(listLeads(ctx).length, 1);
  });

  it('the e2e server and the dev script turn them on', () => {
    assert.match(readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8'), /DEMO_ROUTES: '1'/);
    assert.match(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.dev, /DEMO_ROUTES=1/);
  });
});
