import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ROOT, hubspotKey, makeConfig } from '../src/config';

// HubSpot stopped allowing new private apps on October 26, 2026. A service key is the replacement,
// and an existing private-app token keeps working, so both names are read, service key first.
describe('hubspotKey', () => {
  it('prefers a service key over a legacy private-app token', () => {
    assert.equal(hubspotKey({ HUBSPOT_SERVICE_KEY: 'sk', HUBSPOT_PRIVATE_APP_TOKEN: 'pat' }), 'sk');
  });

  it('still accepts a legacy private-app token on its own', () => {
    assert.equal(hubspotKey({ HUBSPOT_PRIVATE_APP_TOKEN: 'pat' }), 'pat');
  });

  it('treats blank values as missing, so live mode cannot switch on with an empty key', () => {
    assert.equal(hubspotKey({ HUBSPOT_SERVICE_KEY: '', HUBSPOT_PRIVATE_APP_TOKEN: '' }), null);
    assert.equal(hubspotKey({ HUBSPOT_SERVICE_KEY: '' , HUBSPOT_PRIVATE_APP_TOKEN: 'pat' }), 'pat');
    assert.equal(hubspotKey({}), null);
  });
});

// The CI run points the app at throwaway paths and turns lookups off through the environment. Unset, nothing changes.
describe('environment overrides', () => {
  const KEYS = ['APP_DB', 'OUT_DIR', 'OFFLINE'] as const;
  /** Run fn with exactly these variables set (the others removed), then restore the process environment. */
  function withEnv<T>(vars: Partial<Record<(typeof KEYS)[number], string>>, fn: () => T): T {
    const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, vars);
    try { return fn(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  }

  it('leaves the defaults unchanged when nothing is set', () => {
    const c = withEnv({}, () => makeConfig());
    assert.equal(c.appDb, join(ROOT, 'data', 'app.sqlite'));
    assert.equal(c.outDir, join(ROOT, 'out'));
    assert.equal(c.network, true);
  });

  it('APP_DB sets the app database path', () => {
    assert.equal(withEnv({ APP_DB: '/tmp/x/app.sqlite' }, () => makeConfig()).appDb, '/tmp/x/app.sqlite');
    assert.equal(withEnv({ APP_DB: ':memory:' }, () => makeConfig()).appDb, ':memory:');
  });

  it('OUT_DIR sets the output directory', () => {
    assert.equal(withEnv({ OUT_DIR: '/tmp/x/out' }, () => makeConfig()).outDir, '/tmp/x/out');
  });

  it('a relative APP_DB or OUT_DIR is taken from the project root, so the result does not depend on the working directory', () => {
    const c = withEnv({ APP_DB: 'out/ci/app.sqlite', OUT_DIR: 'out/ci' }, () => makeConfig());
    assert.equal(c.appDb, join(ROOT, 'out', 'ci', 'app.sqlite'));
    assert.equal(c.outDir, join(ROOT, 'out', 'ci'));
    assert.ok(isAbsolute(c.appDb) && isAbsolute(c.outDir));
  });

  it('blank values count as unset', () => {
    const c = withEnv({ APP_DB: '  ', OUT_DIR: '' }, () => makeConfig());
    assert.equal(c.appDb, join(ROOT, 'data', 'app.sqlite'));
    assert.equal(c.outDir, join(ROOT, 'out'));
  });

  it('OFFLINE=1 turns the network lookups off, and only the value 1 does', () => {
    assert.equal(withEnv({ OFFLINE: '1' }, () => makeConfig()).network, false);
    assert.equal(withEnv({ OFFLINE: '0' }, () => makeConfig()).network, true);
    assert.equal(withEnv({ OFFLINE: '' }, () => makeConfig()).network, true);
  });

  it('an explicit override still wins over the environment', () => {
    const c = withEnv({ APP_DB: '/tmp/x/app.sqlite', OFFLINE: '1' }, () => makeConfig({ appDb: ':memory:', network: true }));
    assert.equal(c.appDb, ':memory:');
    assert.equal(c.network, true);
  });
});

// .env.example is documentation only. Every default lives in makeConfig(), so nothing depends on the file being loaded.
describe('defaults live in code', () => {
  it('an empty environment gives the local defaults and no keys', () => {
    const c = makeConfig({}, {});
    assert.deepEqual(
      [c.host, c.port, c.demoRoutes, c.llmProvider, c.ollamaUrl, c.ollamaModel, c.calendlyKey, c.anthropicKey, c.hubspotLive, c.hubspotToken, c.network],
      ['127.0.0.1', 3480, false, 'ollama', 'http://127.0.0.1:11434', 'llama3.2:3b', null, null, false, null, true],
    );
  });

  it('every setting .env.example shows uncommented is the default in makeConfig()', () => {
    const shown: Record<string, string> = {};
    for (const line of readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) shown[m[1]] = m[2];
    }
    const c = makeConfig({}, {});
    assert.deepEqual(shown, { PORT: String(c.port), LLM_PROVIDER: c.llmProvider, OLLAMA_URL: c.ollamaUrl, OLLAMA_MODEL: c.ollamaModel });
  });

  it('the model path settings: gated, four leads preparing and one model call at a time unless the environment says otherwise', () => {
    const d = makeConfig({}, {});
    assert.deepEqual([d.modelBeforeRoute, d.prepareConcurrency, d.modelConcurrency], ['gated', 4, 1]);
    const e = makeConfig({}, { MODEL_BEFORE_ROUTE: 'all', PREPARE_CONCURRENCY: '8', MODEL_CONCURRENCY: '2' });
    assert.deepEqual([e.modelBeforeRoute, e.prepareConcurrency, e.modelConcurrency], ['all', 8, 2]);
    const bad = makeConfig({}, { MODEL_BEFORE_ROUTE: 'sometimes', PREPARE_CONCURRENCY: '0', MODEL_CONCURRENCY: 'two' });
    assert.deepEqual([bad.modelBeforeRoute, bad.prepareConcurrency, bad.modelConcurrency], ['gated', 4, 1], 'an unreadable value keeps the default');
  });

  it('settings in the environment still win', () => {
    const c = makeConfig({}, { PORT: '4000', LLM_PROVIDER: 'rules', OLLAMA_URL: 'http://127.0.0.1:9', OLLAMA_MODEL: 'm', CALENDLY_SIGNING_KEY: 'k' });
    assert.deepEqual([c.port, c.llmProvider, c.ollamaUrl, c.ollamaModel, c.calendlyKey], [4000, 'rules', 'http://127.0.0.1:9', 'm', 'k']);
  });
});
