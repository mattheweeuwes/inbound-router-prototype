// The hosted provider reads its settings from the config object and checks the HTTP status before it reads the body.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/config';
import { getProvider } from '../src/qualify/llm';
import { adapt } from '../src/sources';
import { normalizeEvent } from '../src/normalize';
import { buildPayload } from '../src/payloads';
import { spec, testCtx } from './helpers';

const ev = adapt('calendly_demo', buildPayload('calendly_demo', spec()));
const n = normalizeEvent(ev, { isFreeMail: () => false, isDisposable: () => false });
const toolUse = { content: [{ type: 'tool_use', input: { reasons: 'r', use_case: 'other', urgency: 'unknown', buying_role: 'unknown', disqualifier: 'none', confidence: 0.9 } }] };

describe('anthropic provider', () => {
  it('reads the key and model from the config: with no key it is disabled and never calls out', async () => {
    let calls = 0;
    const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: null }, (async () => { calls++; throw new Error('must not be called'); }) as typeof globalThis.fetch);
    const out = await getProvider(ctx).classify(ctx, ev, n, null);
    assert.deepEqual([out.ok, out.ok ? '' : out.reason, calls], [false, 'disabled', 0]);
  });

  it('is disabled when the key is set but LLM_PROVIDER is not anthropic', async () => {
    let calls = 0;
    const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: 'k' }, (async () => { calls++; throw new Error('must not be called'); }) as typeof globalThis.fetch);
    const provider = getProvider(ctx);
    ctx.cfg.llmProvider = 'ollama';
    const out = await provider.classify(ctx, ev, n, null);
    assert.deepEqual([out.ok, out.ok ? '' : out.reason, calls], [false, 'disabled', 0]);
  });

  it('sends the configured key and model, and keeps the default model id', async () => {
    assert.equal(makeConfig({}, {}).anthropicModel, 'claude-haiku-5-5');
    assert.equal(makeConfig({}, { ANTHROPIC_MODEL: 'some-model' }).anthropicModel, 'some-model');
    assert.equal(makeConfig({}, { ANTHROPIC_API_KEY: '' }).anthropicKey, null);
    const sent: { headers: Record<string, string>; body: any }[] = [];
    const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: 'test-key', anthropicModel: 'test-model' }, (async (_u: unknown, init: any) => {
      sent.push({ headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(toolUse), { status: 200 });
    }) as typeof globalThis.fetch);
    const out = await getProvider(ctx).classify(ctx, ev, n, null);
    assert.equal(out.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers['x-api-key'], 'test-key');
    assert.equal(sent[0].body.model, 'test-model');
  });

  it('an HTTP error status is unavailable, not an unparseable answer', async () => {
    for (const status of [401, 429, 500]) {
      const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: 'k' }, (async () => new Response(JSON.stringify({ error: { type: 'x' } }), { status })) as typeof globalThis.fetch);
      const out = await getProvider(ctx).classify(ctx, ev, n, null);
      assert.equal(out.ok, false, String(status));
      if (!out.ok) { assert.equal(out.reason, 'unavailable'); assert.match(out.detail, new RegExp(String(status))); }
    }
  });
});
