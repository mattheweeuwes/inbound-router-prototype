// Signed doors fail closed: a door that is meant to be signed refuses every request when its key is missing or blank.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import demo from '../api/demo';
import inbound from '../api/inbound';
import { createCtx } from '../src/context';
import { makeConfig, ROOT } from '../src/config';
import { whenIdle } from '../src/pipeline';
import { buildPayload } from '../src/payloads';
import { loadFixtures } from '../src/fixtures';
import { runReplay } from '../src/replay';
import { SIGNED_DOORS, signCalendly, signedDoorWarning, signingKey, unkeyedSignedDoors } from '../src/sources';
import { listLeads } from '../src/view';
import { post, spec, testCtx } from './helpers';

const count = (ctx: ReturnType<typeof testCtx>, table: string) => (ctx.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as any).c as number;
const payload = () => buildPayload('calendly_demo', spec());

describe('signed doors fail closed', () => {
  for (const [label, key] of [['no key', null], ['a blank key', ''], ['a whitespace-only key', '   ']] as const) {
    it(`calendly_demo with ${label} answers 503 naming CALENDLY_SIGNING_KEY and creates nothing`, async () => {
      const ctx = testCtx({ calendlyKey: key as any });
      // unsigned, and also with a header that is a perfectly good signature under some other key: both are refused the same way
      for (const sign of [false, 'bad'] as const) {
        const r = await post(ctx, 'calendly_demo', payload(), { sign });
        assert.equal(r.status, 503);
        assert.match(r.json.error, /CALENDLY_SIGNING_KEY/);
        assert.equal(r.json.missingSetting, 'CALENDLY_SIGNING_KEY');
      }
      // even a header signed with the empty string, which is what a fail-open "verify with '' " bug would accept
      const body = JSON.stringify(payload());
      const res = await inbound(new Request('http://local/api/inbound?source=calendly_demo', { method: 'POST', headers: { 'calendly-webhook-signature': signCalendly('', body) }, body }), ctx);
      assert.equal(res.status, 503);
      assert.equal(count(ctx, 'lead_events'), 0, 'no lead_events row');
      assert.equal(count(ctx, 'leads'), 0, 'no lead');
      assert.equal(listLeads(ctx).length, 0);
    });
  }

  it('a valid signature with the key still gives 202, and a bad signature still gives 401', async () => {
    const ctx = testCtx();
    assert.equal((await post(ctx, 'calendly_demo', payload(), { sign: 'bad' })).status, 401);
    assert.equal((await post(ctx, 'calendly_demo', payload(), { sign: false })).status, 401);
    assert.equal(count(ctx, 'lead_events'), 0);
    const ok = await post(ctx, 'calendly_demo', payload());
    assert.equal(ok.status, 202);
    assert.equal(count(ctx, 'lead_events'), 1);
  });

  it('unsigned-by-design doors are unaffected by a missing Calendly key', async () => {
    const ctx = testCtx({ calendlyKey: null });
    for (const s of ['guide_download', 'signal_ask_waitlist', 'sample_signup', 'marketplace', 'api_key', 'event_scan', 'web_intent'] as const) {
      assert.equal(SIGNED_DOORS[s], undefined, `${s} is not in the signed-door table`);
    }
    assert.equal((await post(ctx, 'guide_download', buildPayload('guide_download', spec()))).status, 202);
  });

  it('every door in the signed-door table fails closed, and the table is exactly the doors that verify a signature', async () => {
    assert.deepEqual(Object.keys(SIGNED_DOORS), ['calendly_demo']);
    for (const source of Object.keys(SIGNED_DOORS) as (keyof typeof SIGNED_DOORS)[]) {
      const ctx = testCtx({ calendlyKey: null });
      const res = await inbound(new Request(`http://local/api/inbound?source=${source}`, { method: 'POST', body: '{}' }), ctx);
      assert.equal(res.status, 503, source);
    }
  });

  it('signingKey and unkeyedSignedDoors read the same table', () => {
    assert.equal(signingKey('calendly_demo', { calendlyKey: 'k' }), 'k');
    assert.equal(signingKey('calendly_demo', { calendlyKey: ' ' }), null);
    assert.equal(signingKey('guide_download', { calendlyKey: 'k' }), null, 'unsigned door has no signing key');
    assert.deepEqual(unkeyedSignedDoors({ calendlyKey: null }), [{ source: 'calendly_demo', setting: 'CALENDLY_SIGNING_KEY' }]);
    assert.deepEqual(unkeyedSignedDoors({ calendlyKey: 'k' }), []);
  });

  it('startup warning: one line naming each unkeyed signed door, nothing when keyed', () => {
    const w = signedDoorWarning({ calendlyKey: null });
    assert.ok(w);
    assert.equal(w!.split('\n').length, 1);
    assert.match(w!, /calendly_demo/);
    assert.match(w!, /CALENDLY_SIGNING_KEY/);
    assert.equal(signedDoorWarning({ calendlyKey: '' })?.includes('calendly_demo'), true);
    assert.equal(signedDoorWarning({ calendlyKey: 'k' }), null);
  });
});

describe('the cockpit paths sign when the key is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-signed-'));
  // the key `npm run dev` sets inline; the cockpit routes only exist with DEMO_ROUTES=1
  const DEMO_KEY = 'local-demo-signing-key-not-a-secret';
  const mk = (over: Parameters<typeof createCtx>[0] = {}) => createCtx({
    appDb: ':memory:', registryDb: join(dir, 'none.sqlite'), cacheDir: join(dir, 'cache'), outDir: join(dir, 'out'), network: false, llmProvider: 'rules',
    calendlyKey: DEMO_KEY, demoRoutes: true, hubspotLive: false, hubspotToken: null, ...over,
  }, async () => { throw new Error('network is off in tests'); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('POST /demo/submit (the cockpit send-a-lead form) signs and is accepted', async () => {
    const ctx = mk();
    const res = await demo(new Request('http://local/api/demo/submit', { method: 'POST', body: JSON.stringify({ source: 'calendly_demo', name: 'Dana Whitfield', email: 'dana@intermountainhealthcare.org', title: 'VP Managed Care', company: 'Intermountain Health', state: 'UT', message: 'Renegotiations start in January.', wait: true }) }), ctx);
    assert.equal(res.status, 202);
    assert.ok(((await res.json()) as any).leadId);
    assert.equal(count(ctx as any, 'lead_events'), 1);
  });

  it('Replay a day (runReplay) signs every Calendly fixture: none is refused', async () => {
    const ctx = mk();
    const results = await runReplay(ctx, { wait: true, keepOut: true });
    const fx = loadFixtures(ctx.cfg);
    assert.equal(results.length, fx.length);
    assert.ok(results.some(r => r.fixture.source === 'calendly_demo'), 'the fixture day contains Calendly posts');
    for (const r of results) assert.ok(r.status === 202 || r.status === 200, `${r.fixture.id} (${r.fixture.source}) got ${r.status}`);
  });

  it('with no key the cockpit paths report the missing setting instead of posting unsigned', async () => {
    const ctx = mk({ calendlyKey: null });
    const sub = await demo(new Request('http://local/api/demo/submit', { method: 'POST', body: JSON.stringify({ source: 'calendly_demo', email: 'a@b.org' }) }), ctx);
    assert.equal(sub.status, 503);
    assert.match(((await sub.json()) as any).error, /CALENDLY_SIGNING_KEY/);
    const rep = await demo(new Request('http://local/api/demo/replay', { method: 'POST', body: '{}' }), ctx);
    assert.equal(rep.status, 503);
    assert.match(((await rep.json()) as any).error, /CALENDLY_SIGNING_KEY/);
    await whenIdle(ctx);
    assert.equal(count(ctx as any, 'lead_events'), 0);
  });
});

// .env.example used to be loaded as live config and carried a key, so the "no key, so 503" path could never fire.
describe('the signed door really fails closed with nothing configured', () => {
  it('makeConfig() with an empty environment has no Calendly key, and the signed door answers 503', async () => {
    const cfg = makeConfig({}, {});
    assert.equal(cfg.calendlyKey, null);
    const ctx = testCtx({ calendlyKey: cfg.calendlyKey });
    const r = await post(ctx, 'calendly_demo', payload(), { sign: false });
    assert.equal(r.status, 503);
    assert.equal(r.json.missingSetting, 'CALENDLY_SIGNING_KEY');
    assert.equal(count(ctx, 'lead_events'), 0);
    assert.ok(signedDoorWarning(cfg), 'and the startup warning fires');
  });

  it('.env.example is documentation only: it sets no signing key and the config never loads it', () => {
    assert.doesNotMatch(readFileSync(join(ROOT, '.env.example'), 'utf8'), /^\s*CALENDLY_SIGNING_KEY\s*=/m);
    assert.doesNotMatch(readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8'), /join\(ROOT, '\.env\.example'\)/);
  });

  it('the dev script sets the demo key and the demo routes inline, and so do the replay scripts that sign', () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
    assert.match(scripts.dev, /CALENDLY_SIGNING_KEY=local-demo-signing-key-not-a-secret/);
    assert.match(scripts.dev, /DEMO_ROUTES=1/);
    for (const name of ['replay', 'replay:ci']) assert.match(scripts[name], /CALENDLY_SIGNING_KEY=local-demo-signing-key-not-a-secret/, name);
  });
});
