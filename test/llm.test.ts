// The hosted provider: settings from the config, a request current models accept, and every way an answer can fail to be one.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/config';
import { HOSTED_SCHEMA, getProvider, hostedRequest } from '../src/qualify/llm';
import { CLASSIFY_SCHEMA } from '../src/qualify/prompt';
import { adapt } from '../src/sources';
import { normalizeEvent } from '../src/normalize';
import { buildPayload } from '../src/payloads';
import { spec, testCtx } from './helpers';

const ev = adapt('calendly_demo', buildPayload('calendly_demo', spec()));
const n = normalizeEvent(ev, { isFreeMail: () => false, isDisposable: () => false });
const answer = { reasons: 'r', use_case: 'other', urgency: 'unknown', buying_role: 'unknown', disqualifier: 'none', confidence: 0.9 };
/** A hosted reply: thinking first, then the JSON answer as text, with the token counts the API reports. */
const reply = (over: Record<string, unknown> = {}) => new Response(JSON.stringify({
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn', usage: { input_tokens: 1400, output_tokens: 600 }, ...over,
}), { status: 200 });
type Fetch = typeof globalThis.fetch;

describe('anthropic provider', () => {
  it('reads the key and model from the config: with no key it is disabled and never calls out', async () => {
    let calls = 0;
    const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: null }, (async () => { calls++; throw new Error('must not be called'); }) as Fetch);
    const out = await getProvider(ctx).classify(ctx, ev, n, null);
    assert.deepEqual([out.ok, out.ok ? '' : out.reason, calls], [false, 'disabled', 0]);
  });

  it('is disabled when the key is set but LLM_PROVIDER is not anthropic', async () => {
    let calls = 0;
    const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: 'k' }, (async () => { calls++; throw new Error('must not be called'); }) as Fetch);
    const provider = getProvider(ctx);
    ctx.cfg.llmProvider = 'ollama';
    const out = await provider.classify(ctx, ev, n, null);
    assert.deepEqual([out.ok, out.ok ? '' : out.reason, calls], [false, 'disabled', 0]);
  });

  it('the settings come from the environment, with Sonnet at extra-high effort, 8 s and four calls at once as the hosted defaults', () => {
    const hosted = makeConfig({}, { LLM_PROVIDER: 'anthropic' });
    assert.deepEqual([hosted.anthropicModel, hosted.anthropicEffort, hosted.modelTimeoutMs, hosted.modelConcurrency], ['claude-sonnet-5-5', 'xhigh', 8000, 4]);
    assert.equal(makeConfig({}, {}).modelConcurrency, 1, 'the local model still takes one call at a time');
    assert.equal(makeConfig({}, { ANTHROPIC_MODEL: 'some-model' }).anthropicModel, 'some-model');
    assert.equal(makeConfig({}, { ANTHROPIC_EFFORT: 'low' }).anthropicEffort, 'low');
    assert.equal(makeConfig({}, { ANTHROPIC_EFFORT: 'turbo' }).anthropicEffort, 'xhigh', 'an effort the API does not have falls back to the default');
    assert.equal(makeConfig({}, { MODEL_TIMEOUT_MS: '30000' }).modelTimeoutMs, 30000);
    assert.equal(makeConfig({}, { ANTHROPIC_API_KEY: '' }).anthropicKey, null);
  });

  it('sends what current models accept: no temperature and no forced tool call, a JSON output format, and effort', async () => {
    const sent: { headers: Record<string, string>; body: any }[] = [];
    const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: 'test-key', anthropicModel: 'test-model', anthropicEffort: 'xhigh' }, (async (_u: unknown, init: any) => {
      sent.push({ headers: init.headers, body: JSON.parse(init.body) });
      return reply();
    }) as Fetch);
    const out = await getProvider(ctx).classify(ctx, ev, n, null);
    assert.equal(out.ok, true);
    if (out.ok) assert.deepEqual([out.value.useCase, out.value.confidence, out.provider], ['other', 0.9, 'anthropic:test-model']);
    assert.equal(sent.length, 1);
    const { headers, body } = sent[0];
    assert.equal(headers['x-api-key'], 'test-key');
    assert.equal(body.model, 'test-model');
    for (const gone of ['temperature', 'top_p', 'top_k', 'tools', 'tool_choice']) assert.equal(gone in body, false, `${gone} is not sent`);
    assert.equal(body.output_config.effort, 'xhigh');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.deepEqual(body, hostedRequest(ctx, ev, n, null), 'the request is the one the builder returns');
    assert.equal(body.messages[body.messages.length - 1].role, 'user', 'the lead is the last message: nothing is prefilled');
    assert.ok(body.max_tokens >= 4000, 'room for thinking as well as the answer');
  });

  it('the hosted schema is the classifier schema without the keywords structured output refuses', () => {
    assert.equal(HOSTED_SCHEMA.additionalProperties, false);
    assert.deepEqual(HOSTED_SCHEMA.required, [...CLASSIFY_SCHEMA.required]);
    assert.deepEqual(Object.keys(HOSTED_SCHEMA.properties), Object.keys(CLASSIFY_SCHEMA.properties));
    const text = JSON.stringify(HOSTED_SCHEMA);
    for (const keyword of ['maxLength', 'minimum', 'maximum']) assert.equal(text.includes(keyword), false, keyword);
    assert.deepEqual((HOSTED_SCHEMA.properties.use_case as { enum: string[] }).enum, [...CLASSIFY_SCHEMA.properties.use_case.enum], 'the labels are the same list');
  });

  it('counts the tokens each answered call used', async () => {
    const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: 'k' }, (async () => reply()) as Fetch);
    await getProvider(ctx).classify(ctx, ev, n, null);
    await getProvider(ctx).classify(ctx, ev, n, null);
    assert.deepEqual(ctx.modelUsage, { calls: 2, inputTokens: 2800, outputTokens: 1200 });
  });

  it('a decline, a cut-off answer and an answer outside the schema are invalid output, so the rules decide', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }, /declined to answer \(cyber\)/],
      [{ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] }, /cut off at the token limit/],
      [{ content: [{ type: 'text', text: JSON.stringify({ ...answer, use_case: 'not_a_label' }) }] }, /not JSON in the schema/],
      [{ content: [{ type: 'text', text: 'no json here' }] }, /not JSON in the schema/],
    ];
    for (const [over, detail] of cases) {
      const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: 'k' }, (async () => reply(over)) as Fetch);
      const out = await getProvider(ctx).classify(ctx, ev, n, null);
      assert.equal(out.ok, false);
      if (!out.ok) { assert.equal(out.reason, 'invalid_output'); assert.match(out.detail, detail); }
    }
  });

  it('an HTTP error status is unavailable, not an unparseable answer', async () => {
    for (const status of [401, 429, 500]) {
      const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: 'k' }, (async () => new Response(JSON.stringify({ error: { type: 'x' } }), { status })) as Fetch);
      const out = await getProvider(ctx).classify(ctx, ev, n, null);
      assert.equal(out.ok, false, String(status));
      if (!out.ok) { assert.equal(out.reason, 'unavailable'); assert.match(out.detail, new RegExp(String(status))); }
    }
  });

  it('a rate-limited or overloaded call is tried once more; any other error status is not', async () => {
    for (const [status, calls] of [[429, 2], [529, 2], [500, 1], [401, 1]] as const) {
      let n1 = 0;
      const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: 'k' }, (async () => { n1++; return new Response('{}', { status }); }) as Fetch);
      await getProvider(ctx).classify(ctx, ev, n, null);
      assert.equal(n1, calls, String(status));
    }
    let n2 = 0;
    const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: 'k' }, (async () => (++n2 === 1 ? new Response('{}', { status: 429 }) : reply())) as Fetch);
    const out = await getProvider(ctx).classify(ctx, ev, n, null);
    assert.deepEqual([out.ok, n2], [true, 2], 'the retry answers');
  });

  it('a call that outlasts the time budget is a timeout', async () => {
    const ctx = testCtx({ llmProvider: 'anthropic', anthropicKey: 'k', modelTimeoutMs: 30 }, ((_u: unknown, init: any) => new Promise((_ok, fail) => {
      // a real request holds the event loop open through its socket; this stand-in does it with a timer the abort clears
      const hold = setTimeout(() => {}, 5_000);
      init.signal.addEventListener('abort', () => { clearTimeout(hold); fail(init.signal.reason); });
    })) as Fetch);
    const out = await getProvider(ctx).classify(ctx, ev, n, null);
    assert.equal(out.ok, false);
    if (!out.ok) { assert.equal(out.reason, 'timeout'); assert.match(out.detail, /exceeded 0\.03 s/); }
  });
});
