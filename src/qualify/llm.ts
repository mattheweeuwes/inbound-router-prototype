// LLM provider interface: ollama | rules (no model) | anthropic (code only, disabled unless explicitly keyed).
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
        const r = await ctx.fetch(`${ctx.cfg.ollamaUrl}/api/chat`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) });
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
        return { ok: false, reason: timedOut ? 'timeout' : 'unavailable', detail: timedOut ? 'Ollama call exceeded 8s' : `Ollama unreachable: ${err.message}`, latencyMs: ctx.cfg.now() - started, provider };
      }
    }
    return { ok: false, reason: 'invalid_output', detail: lastDetail, latencyMs: ctx.cfg.now() - started, provider };
  },
};

/** Code only. Disabled unless ANTHROPIC_API_KEY is set AND LLM_PROVIDER=anthropic. Nobody sets them in this prototype. */
const anthropicProvider: LlmProvider = {
  name: 'anthropic',
  async classify(ctx, ev, n, res) {
    const started = ctx.cfg.now();
    if (!ctx.cfg.anthropicKey || ctx.cfg.llmProvider !== 'anthropic') {
      return { ok: false, reason: 'disabled', detail: 'anthropic provider is disabled (needs ANTHROPIC_API_KEY and LLM_PROVIDER=anthropic)', latencyMs: 0, provider: 'anthropic' };
    }
    const msgs = buildMessages(ev, n, res);
    const system = msgs[0].content;
    try {
      const r = await ctx.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { 'x-api-key': ctx.cfg.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ctx.cfg.anthropicModel, max_tokens: 400, temperature: 0, system,
          messages: msgs.slice(1), tools: [{ name: 'classify', description: 'Record the classification', input_schema: CLASSIFY_SCHEMA }],
          tool_choice: { type: 'tool', name: 'classify' },
        }),
      });
      if (!r.ok) return { ok: false, reason: 'unavailable', detail: `Anthropic HTTP ${r.status}`, latencyMs: ctx.cfg.now() - started, provider: 'anthropic' };
      const data: any = await r.json();
      const value = parseClassification(data?.content?.find((c: any) => c.type === 'tool_use')?.input);
      if (value) return { ok: true, value, latencyMs: ctx.cfg.now() - started, provider: 'anthropic' };
      return { ok: false, reason: 'invalid_output', detail: 'unparseable tool output', latencyMs: ctx.cfg.now() - started, provider: 'anthropic' };
    } catch (e) {
      return { ok: false, reason: 'unavailable', detail: (e as Error).message, latencyMs: ctx.cfg.now() - started, provider: 'anthropic' };
    }
  },
};

export function getProvider(ctx: Ctx): LlmProvider {
  return ctx.cfg.llmProvider === 'rules' ? rulesProvider : ctx.cfg.llmProvider === 'anthropic' ? anthropicProvider : ollamaProvider;
}

/** First call after Ollama has been idle loads the model, which can exceed the 8s budget. Warm it once at boot. */
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
