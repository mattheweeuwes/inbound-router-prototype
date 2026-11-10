// LLM provider interface: ollama (the default) | rules (no model) | anthropic (a hosted model, off unless keyed and chosen).
import type { Ctx } from '../context';
import { BUYING_ROLES, DISQUALIFIERS, URGENCIES, USE_CASES, type Classification, type LeadEvent, type Normalized, type Resolution } from '../schema';
import { buildMessages, CLASSIFY_SCHEMA } from './prompt';

export type LlmOutcome =
  | { ok: true; value: Classification; latencyMs: number; provider: string }
  | { ok: false; reason: 'disabled' | 'unavailable' | 'timeout' | 'invalid_output'; detail: string; latencyMs: number; provider: string };

export interface LlmProvider {
  name: string;
  classify(ctx: Ctx, ev: LeadEvent, n: Normalized, res: Resolution | null): Promise<LlmOutcome>;
}

/** Validate and normalize raw model JSON. Returns null when any enum is outside the schema. */
export function parseClassification(raw: unknown): Classification | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const inSet = <T extends string>(v: unknown, set: readonly T[]): v is T => typeof v === 'string' && (set as readonly string[]).includes(v);
  if (!inSet(o.use_case, USE_CASES) || !inSet(o.urgency, URGENCIES) || !inSet(o.buying_role, BUYING_ROLES) || !inSet(o.disqualifier, DISQUALIFIERS)) return null;
  const conf = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence);
  if (Number.isNaN(conf)) return null;
  return {
    reasons: String(o.reasons ?? '').slice(0, 240),
    useCase: o.use_case, urgency: o.urgency, buyingRole: o.buying_role, disqualifier: o.disqualifier,
    confidence: Math.max(0, Math.min(1, conf)),
  };
}

const rulesProvider: LlmProvider = {
  name: 'rules',
  async classify() { return { ok: false, reason: 'disabled', detail: 'LLM_PROVIDER=rules: model not used', latencyMs: 0, provider: 'rules' }; },
};

const ollamaProvider: LlmProvider = {
  name: 'ollama',
  async classify(ctx, ev, n, res) {
    const started = ctx.cfg.now();
    const body = JSON.stringify({
      model: ctx.cfg.ollamaModel, stream: false, format: CLASSIFY_SCHEMA, keep_alive: '30m',
      options: { temperature: 0, num_predict: 400 }, messages: buildMessages(ev, n, res),
    });
    const provider = `ollama:${ctx.cfg.ollamaModel}`;
    let lastDetail = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await ctx.fetch(`${ctx.cfg.ollamaUrl}/api/chat`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(ctx.cfg.modelTimeoutMs) });
        if (!r.ok) return { ok: false, reason: 'unavailable', detail: `Ollama HTTP ${r.status}`, latencyMs: ctx.cfg.now() - started, provider };
        const data: any = await r.json();
        let parsed: unknown = null;
        try { parsed = JSON.parse(data?.message?.content ?? ''); } catch { /* retry below */ }
        const value = parseClassification(parsed);
        if (value) return { ok: true, value, latencyMs: ctx.cfg.now() - started, provider };
        lastDetail = 'model returned invalid JSON or an out-of-schema value';
      } catch (e) {
        const err = e as Error;
        const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
        return { ok: false, reason: timedOut ? 'timeout' : 'unavailable', detail: timedOut ? `Ollama call exceeded ${ctx.cfg.modelTimeoutMs / 1000}s` : `Ollama unreachable: ${err.message}`, latencyMs: ctx.cfg.now() - started, provider };
      }
    }
    return { ok: false, reason: 'invalid_output', detail: lastDetail, latencyMs: ctx.cfg.now() - started, provider };
  },
};

/**
 * The schema the hosted API takes. Its structured outputs accept no string-length or numeric-range keywords and need
 * additionalProperties false on every object; parseClassification still cuts the reasons and clamps the confidence.
 */
export const HOSTED_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(Object.entries(CLASSIFY_SCHEMA.properties).map(([name, def]) => {
    const { maxLength: _maxLength, minimum: _minimum, maximum: _maximum, ...kept } = def as Record<string, unknown>;
    return [name, kept];
  })),
  required: CLASSIFY_SCHEMA.required,
  additionalProperties: false,
};

/** Room for the model's thinking as well as its short JSON answer: thinking counts toward the limit. */
const HOSTED_MAX_TOKENS = 8000;
/** Rate limited or overloaded: worth one more try inside the time budget. Any other error status is not retried. */
const RETRY_STATUSES = new Set([429, 529]);

interface HostedBlock { type: string; text?: string }
interface HostedMessage {
  content?: HostedBlock[];
  stop_reason?: string;
  stop_details?: { category?: string | null } | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * The request body for a hosted Claude model. Current models take no temperature and, on Sonnet, no forced tool call, so the
 * answer is constrained with a JSON output format instead and the amount of thinking is set by effort. The few-shot turns go
 * as earlier messages; the last message is always the lead.
 */
export function hostedRequest(ctx: Ctx, ev: LeadEvent, n: Normalized, res: Resolution | null) {
  const msgs = buildMessages(ev, n, res);
  return {
    model: ctx.cfg.anthropicModel, max_tokens: HOSTED_MAX_TOKENS, system: msgs[0].content, messages: msgs.slice(1),
    output_config: { effort: ctx.cfg.anthropicEffort, format: { type: 'json_schema', schema: HOSTED_SCHEMA } },
  };
}

const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/** Disabled unless ANTHROPIC_API_KEY is set and LLM_PROVIDER=anthropic. The local model stays the default. */
const anthropicProvider: LlmProvider = {
  name: 'anthropic',
  async classify(ctx, ev, n, res) {
    const started = ctx.cfg.now();
    const provider = `anthropic:${ctx.cfg.anthropicModel}`;
    if (!ctx.cfg.anthropicKey || ctx.cfg.llmProvider !== 'anthropic') {
      return { ok: false, reason: 'disabled', detail: 'anthropic provider is disabled (needs ANTHROPIC_API_KEY and LLM_PROVIDER=anthropic)', latencyMs: 0, provider: 'anthropic' };
    }
    const fail = (reason: 'unavailable' | 'timeout' | 'invalid_output', detail: string): LlmOutcome => ({ ok: false, reason, detail, latencyMs: ctx.cfg.now() - started, provider });
    const body = JSON.stringify(hostedRequest(ctx, ev, n, res));
    const deadline = Date.now() + ctx.cfg.modelTimeoutMs;
    try {
      for (let attempt = 0; ; attempt++) {
        const r = await ctx.fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())), body,
          headers: { 'x-api-key': ctx.cfg.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        });
        if (!r.ok) {
          const asked = Number(r.headers.get('retry-after'));
          const pause = Number.isFinite(asked) && asked > 0 ? asked * 1000 : ctx.cfg.modelRetryWaitMs;
          if (attempt === 0 && RETRY_STATUSES.has(r.status) && Date.now() + pause < deadline) { await wait(pause); continue; }
          return fail('unavailable', `Anthropic HTTP ${r.status}`);
        }
        const data = (await r.json()) as HostedMessage;
        ctx.modelUsage.calls++;
        ctx.modelUsage.inputTokens += data.usage?.input_tokens ?? 0;
        ctx.modelUsage.outputTokens += data.usage?.output_tokens ?? 0;
        if (data.stop_reason === 'refusal') return fail('invalid_output', `the model declined to answer (${data.stop_details?.category ?? 'no category given'})`);
        if (data.stop_reason === 'max_tokens') return fail('invalid_output', 'the answer was cut off at the token limit');
        let parsed: unknown = null;
        try { parsed = JSON.parse((data.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('')); } catch { /* reported below */ }
        const value = parseClassification(parsed);
        return value ? { ok: true, value, latencyMs: ctx.cfg.now() - started, provider } : fail('invalid_output', 'the answer was not JSON in the schema');
      }
    } catch (e) {
      const err = e as Error;
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      return fail(timedOut ? 'timeout' : 'unavailable', timedOut ? `the hosted call exceeded ${ctx.cfg.modelTimeoutMs / 1000} s` : `Anthropic unreachable: ${err.message}`);
    }
  },
};

export function getProvider(ctx: Ctx): LlmProvider {
  return ctx.cfg.llmProvider === 'rules' ? rulesProvider : ctx.cfg.llmProvider === 'anthropic' ? anthropicProvider : ollamaProvider;
}

/** First call after Ollama has been idle loads the model, which can exceed the time budget. Warm it once at boot. */
export async function warmOllama(ctx: Ctx): Promise<boolean> {
  if (ctx.cfg.llmProvider !== 'ollama') return false;
  try {
    const r = await ctx.fetch(`${ctx.cfg.ollamaUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ model: ctx.cfg.ollamaModel, stream: false, keep_alive: '30m', options: { temperature: 0, num_predict: 1 }, messages: [{ role: 'user', content: 'ok' }] }),
    });
    return r.ok;
  } catch { return false; }
}
