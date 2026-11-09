// One browser test of the cockpit, against a server started just for it. Nothing here can reach the demo server, a CRM or a messaging app:
// the server runs on its own port with its own throwaway database and output folder, rules only, offline, HubSpot dry-run.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 3497;
// The config is loaded again in every worker; the first load (the main process) picks the folder and the workers inherit it.
process.env.E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'router-e2e-'));
const dataDir = process.env.E2E_DATA_DIR;

export default defineConfig({
  testDir: 'e2e',
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'npx tsx server.ts',
    url: `http://127.0.0.1:${PORT}/api/metrics`,
    reuseExistingServer: false, // never attach to a server that is already there (the demo)
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      LLM_PROVIDER: 'rules',
      OFFLINE: '1',
      HUBSPOT_LIVE: '0',
      HUBSPOT_SERVICE_KEY: '',
      HUBSPOT_PRIVATE_APP_TOKEN: '',
      CALENDLY_SIGNING_KEY: 'local-demo-signing-key-not-a-secret', // the cockpit form signs its demo leads with this
      DEMO_ROUTES: '1', // the cockpit form and Replay a day live under /api/demo
      APP_DB: join(dataDir, 'app.sqlite'),
      OUT_DIR: join(dataDir, 'out'),
    },
  },
});
