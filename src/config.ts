import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(path: string, target: Record<string, string>) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) target[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/**
 * A local .env, then the real process environment on top of it. .env.example is documentation only and is never loaded:
 * every default lives in makeConfig(), so a missing setting (the Calendly signing key above all) stays missing.
 */
export function loadEnv(): Record<string, string | undefined> {
  const fileVals: Record<string, string> = {};
  loadEnvFile(join(ROOT, '.env'), fileVals);
  return { ...fileVals, ...process.env };
}

export interface Config {
  root: string;
  host: string; // the interface the local server binds to
  accessPassword: string | null; // set (ACCESS_PASSWORD) on a copy reachable from outside: every request then needs it (src/access.ts)
  port: number;
  demoRoutes: boolean; // /api/demo/* (send a lead, replay a day) is served only when this is on
  appDb: string;
  registryDb: string; // the built registry (REGISTRY_DB); with no complete file there, the mini registry is built in cacheDir
  registryMiniSql: string;
  cacheDir: string; // the mini registry and the homepage-title cache (CACHE_DIR)
  outDir: string;
  fixturesDir: string;
  ratesCsv: string; // Serif's public rate search export; the outbound module loads it at startup when its hash changes (RATES_CSV)
  outboundPlatforms: string; // the hand-made EIN to platform mapping the outbound module targets with (OUTBOUND_PLATFORMS)
  usageFixtures: string | null; // the folder of synthetic usage fixtures (features, deals, PostHog events), loaded at startup; null switches them off (USAGE_FIXTURES)
  calendlyKey: string | null;
  llmProvider: 'ollama' | 'rules' | 'anthropic';
  ollamaUrl: string;
  ollamaModel: string;
  anthropicKey: string | null; // the hosted provider needs this; with LLM_PROVIDER unset, having it is what picks the hosted model
  anthropicModel: string;
  anthropicEffort: HostedEffort; // how much the hosted model thinks before it answers (ANTHROPIC_EFFORT)
  modelTimeoutMs: number; // a model call that takes longer hands its fields to the rules (MODEL_TIMEOUT_MS)
  modelRetryWaitMs: number; // the wait before the one retry of a rate-limited or overloaded hosted call, when the API names none
  hubspotLive: boolean;
  hubspotToken: string | null;
  crmRetryDelayMs: number; // first backoff step for a HubSpot delivery that threw or got a 429/5xx; it doubles per attempt
  crmMaxDelayMs: number; // longest backoff step for a HubSpot delivery (a Retry-After header can ask for longer)
  crmMaxAttempts: number; // a HubSpot delivery is marked dead after this many attempts
  leadRetryDelayMs: number; // first backoff step for a lead whose pipeline threw; it doubles per attempt
  leadMaxAttempts: number; // a lead is given up (status failed, RevOps alerted) after this many failed runs
  // 'gated': the model runs before routing only when it can change the route (free text and no clear keyword use case); every
  // other free-text lead is alerted on the rules and gets the same model call afterwards as a second opinion. 'all': the model
  // runs before routing for every free-text lead, as it did before the gate (MODEL_BEFORE_ROUTE=all).
  modelBeforeRoute: 'gated' | 'all';
  briefWindowHours: number; // how far back the Today tab's lead sections look when the request names no window (BRIEF_WINDOW_HOURS)
  prepareConcurrency: number; // leads whose lookups (adapt, normalize, resolve) run at once; a model call waits in its own slots, not here
  modelConcurrency: number; // model calls in flight at once, before-route calls first; second opinions take a slot only when none waits
  // How long the lead at the head of the commit order may hold leads in other lanes while its own prepared result is not ready
  // (decision 23). null never lets a lead pass: commits follow acceptance order exactly (COMMIT_GRACE_MS=never), which replay:ci,
  // the eval and the tests pin so rules-only runs stay reproducible.
  commitGraceMs: number | null;
  // Doors that carry a list someone uploads (decision 24). Their leads route on the rules with the model after the alert, and an
  // alert other than a rep's is folded into one digest per list and team (LIST_DOORS, comma-separated; 'none' for no list doors).
  listDoors: string[];
  // 'after_alert': a list door never waits for the model. 'gated': list doors follow the same model gate as every other door, as
  // before (LIST_DOOR_MODEL=gated).
  listDoorModel: 'after_alert' | 'gated';
  listQuietMs: number; // a list has settled when none of its leads is waiting or in flight and none was accepted for this long (LIST_QUIET_MS)
  network: boolean; // site-title + NPPES lookups allowed
  now: () => number; // injectable clock for wall-clock measurements
}

/**
 * The HubSpot credential, sent as a Bearer token. A service key is HubSpot's replacement for private apps,
 * which can no longer be created as of October 26, 2026; a legacy private-app token still works.
 * Empty values count as missing, so live mode cannot switch on with a blank key.
 */
export function hubspotKey(env: Record<string, string | undefined>): string | null {
  return env.HUBSPOT_SERVICE_KEY || env.HUBSPOT_PRIVATE_APP_TOKEN || null;
}

/** A path from the environment: absolute stays as is, relative is taken from the project root (npm runs scripts there). Blank counts as unset; ":memory:" passes through (SQLite). */
function envPath(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  if (!v) return fallback;
  if (v === ':memory:') return v; // SQLite in-memory database
  return isAbsolute(v) ? v : resolve(ROOT, v);
}

/** A whole number of at least 1 from the environment, or the fallback when it is unset, blank or not one. */
function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value?.trim());
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/** A whole number of at least 0 from the environment, or the fallback when it is unset, blank or not one. */
function nonNegativeInt(value: string | undefined, fallback: number): number {
  const n = Number(value?.trim());
  return value?.trim() && Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** COMMIT_GRACE_MS: 'never' (or 'off') keeps strict acceptance order; a whole number of milliseconds is the grace; anything else is the default. */
export function commitGrace(value: string | undefined): number | null {
  const v = value?.trim().toLowerCase();
  if (v === 'never' || v === 'off') return null;
  return nonNegativeInt(value, DEFAULT_COMMIT_GRACE_MS);
}
export const DEFAULT_COMMIT_GRACE_MS = 250;

/** LIST_DOORS: comma-separated door names; 'none' or blank means no list doors. Unset is event_scan. */
export function listDoorsFrom(value: string | undefined): string[] {
  if (value === undefined) return ['event_scan'];
  const v = value.trim().toLowerCase();
  if (!v || v === 'none') return [];
  return [...new Set(v.split(',').map(s => s.trim()).filter(Boolean))];
}

export const HOSTED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type HostedEffort = (typeof HOSTED_EFFORTS)[number];
/** Low is the default: on the labelled sets it was as accurate as extra high, faster and cheaper (docs/hosted-model-record-2026-11-10.md). */
const hostedEffort = (v: string | undefined): HostedEffort => (HOSTED_EFFORTS.find(e => e === v?.trim().toLowerCase()) ?? 'low');

/**
 * What fills the model slot. LLM_PROVIDER pins one. With it unset, the best model this process can reach: the hosted one when a key is
 * set (it beats the local model on every field of the eval), else the local one. The key is the opt-in, so nothing reaches a hosted
 * model without one, and a value that is not a provider's name never picks it.
 */
function providerFrom(env: Record<string, string | undefined>): Config['llmProvider'] {
  const asked = env.LLM_PROVIDER?.trim().toLowerCase();
  if (asked === 'ollama' || asked === 'rules' || asked === 'anthropic') return asked;
  if (asked) return 'ollama';
  return env.ANTHROPIC_API_KEY ? 'anthropic' : 'ollama';
}

/** `env` is the environment to read; tests pass {} to see the defaults with nothing set. */
export function makeConfig(over: Partial<Config> = {}, env: Record<string, string | undefined> = loadEnv()): Config {
  const dataDir = join(ROOT, 'data');
  const provider = providerFrom(env);
  return {
    root: ROOT,
    host: env.HOST?.trim() || '127.0.0.1', // local only unless HOST says otherwise
    accessPassword: env.ACCESS_PASSWORD?.trim() || null,
    port: Number(env.PORT ?? 3480),
    demoRoutes: env.DEMO_ROUTES === '1',
    appDb: envPath(env.APP_DB, join(dataDir, 'app.sqlite')),
    registryDb: envPath(env.REGISTRY_DB, join(dataDir, 'registry.sqlite')),
    registryMiniSql: join(ROOT, 'test', 'fixtures', 'registry-mini.sql'),
    cacheDir: envPath(env.CACHE_DIR, join(dataDir, 'cache')),
    outDir: envPath(env.OUT_DIR, join(ROOT, 'out')),
    fixturesDir: join(ROOT, 'fixtures'),
    ratesCsv: envPath(env.RATES_CSV, join(dataDir, 'rates', 'mrf_rate_search_export.csv')),
    outboundPlatforms: envPath(env.OUTBOUND_PLATFORMS, join(ROOT, 'fixtures', 'outbound-platforms.json')),
    usageFixtures: envPath(env.USAGE_FIXTURES, join(ROOT, 'fixtures', 'usage')),
    calendlyKey: env.CALENDLY_SIGNING_KEY || null,
    llmProvider: provider,
    ollamaUrl: env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    ollamaModel: env.OLLAMA_MODEL ?? 'llama3.2:3b',
    anthropicKey: env.ANTHROPIC_API_KEY || null,
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
    anthropicEffort: hostedEffort(env.ANTHROPIC_EFFORT),
    modelTimeoutMs: positiveInt(env.MODEL_TIMEOUT_MS, 8_000),
    modelRetryWaitMs: 1_000,
    hubspotLive: env.HUBSPOT_LIVE === '1' && !!hubspotKey(env),
    hubspotToken: hubspotKey(env),
    crmRetryDelayMs: 2_000,
    crmMaxDelayMs: 5 * 60_000,
    crmMaxAttempts: 8, // waits of 2, 4, 8 ... 128 s between them: about four minutes of trying before a plan is dead
    leadRetryDelayMs: 5_000,
    leadMaxAttempts: 3, // runs at 0 s, 5 s and 15 s
    modelBeforeRoute: env.MODEL_BEFORE_ROUTE === 'all' ? 'all' : 'gated',
    briefWindowHours: positiveInt(env.BRIEF_WINDOW_HOURS, 24),
    prepareConcurrency: positiveInt(env.PREPARE_CONCURRENCY, 4),
    // one local model on one machine: parallel calls only queue inside Ollama, and its queue counts against the timeout; a hosted model takes several at once
    modelConcurrency: positiveInt(env.MODEL_CONCURRENCY, provider === 'anthropic' ? 4 : 1),
    commitGraceMs: commitGrace(env.COMMIT_GRACE_MS),
    listDoors: listDoorsFrom(env.LIST_DOORS),
    listDoorModel: env.LIST_DOOR_MODEL === 'gated' ? 'gated' : 'after_alert',
    listQuietMs: nonNegativeInt(env.LIST_QUIET_MS, 5_000),
    network: env.OFFLINE !== '1', // OFFLINE=1 turns the site-title and NPPES lookups off
    now: () => Date.now(),
    ...over,
  };
}
