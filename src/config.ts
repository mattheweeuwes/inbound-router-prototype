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
  port: number;
  demoRoutes: boolean; // /api/demo/* (send a lead, replay a day) is served only when this is on
  appDb: string;
  registryDb: string;
  registryMiniSql: string;
  cacheDir: string;
  outDir: string;
  fixturesDir: string;
  calendlyKey: string | null;
  llmProvider: 'ollama' | 'rules' | 'anthropic';
  ollamaUrl: string;
  ollamaModel: string;
  anthropicKey: string | null; // the hosted provider needs this and llmProvider = 'anthropic'
  anthropicModel: string;
  hubspotLive: boolean;
  hubspotToken: string | null;
  crmRetryDelayMs: number; // first backoff step for a HubSpot delivery that threw or got a 429/5xx; it doubles per attempt
  crmMaxDelayMs: number; // longest backoff step for a HubSpot delivery (a Retry-After header can ask for longer)
  crmMaxAttempts: number; // a HubSpot delivery is marked dead after this many attempts
  leadRetryDelayMs: number; // first backoff step for a lead whose pipeline threw; it doubles per attempt
  leadMaxAttempts: number; // a lead is given up (status failed, RevOps alerted) after this many failed runs
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

/** `env` is the environment to read; tests pass {} to see the defaults with nothing set. */
export function makeConfig(over: Partial<Config> = {}, env: Record<string, string | undefined> = loadEnv()): Config {
  const dataDir = join(ROOT, 'data');
  const provider = (env.LLM_PROVIDER ?? 'ollama') as Config['llmProvider'];
  return {
    root: ROOT,
    host: env.HOST?.trim() || '127.0.0.1', // local only unless HOST says otherwise
    port: Number(env.PORT ?? 3480),
    demoRoutes: env.DEMO_ROUTES === '1',
    appDb: envPath(env.APP_DB, join(dataDir, 'app.sqlite')),
    registryDb: join(dataDir, 'registry.sqlite'),
    registryMiniSql: join(ROOT, 'test', 'fixtures', 'registry-mini.sql'),
    cacheDir: join(dataDir, 'cache'),
    outDir: envPath(env.OUT_DIR, join(ROOT, 'out')),
    fixturesDir: join(ROOT, 'fixtures'),
    calendlyKey: env.CALENDLY_SIGNING_KEY || null,
    llmProvider: ['ollama', 'rules', 'anthropic'].includes(provider) ? provider : 'ollama',
    ollamaUrl: env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    ollamaModel: env.OLLAMA_MODEL ?? 'llama3.2:3b',
    anthropicKey: env.ANTHROPIC_API_KEY || null,
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-haiku-5-5',
    hubspotLive: env.HUBSPOT_LIVE === '1' && !!hubspotKey(env),
    hubspotToken: hubspotKey(env),
    crmRetryDelayMs: 2_000,
    crmMaxDelayMs: 5 * 60_000,
    crmMaxAttempts: 8, // waits of 2, 4, 8 ... 128 s between them: about four minutes of trying before a plan is dead
    leadRetryDelayMs: 5_000,
    leadMaxAttempts: 3, // runs at 0 s, 5 s and 15 s
    network: env.OFFLINE !== '1', // OFFLINE=1 turns the site-title and NPPES lookups off
    now: () => Date.now(),
    ...over,
  };
}
