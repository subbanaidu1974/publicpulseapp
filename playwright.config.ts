import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT || 3000);
const baseURL = `http://localhost:${PORT}`;
// E2E_BUILT=1 runs against the production bundle (`npm run build` first); needed by specs that depend on hashed assets (service worker offline shell).
const BUILT = process.env.E2E_BUILT === "1";

// The moderation specs approve lexicon changes, which rewrite the lexicon file: point the web server at a throwaway copy, never data/civic/.
const LEXICON = process.env.CIVIC_LEXICON_FILE || path.join(os.tmpdir(), `civic-e2e-lexicon-${process.pid}-${Date.now()}.json`);
if (!process.env.CIVIC_LEXICON_FILE && !process.env.TEST_WORKER_INDEX) fs.copyFileSync(path.resolve("data/civic/moderation-lexicon.json"), LEXICON);

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: BUILT ? 'node dist/server.cjs' : 'npm run dev',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
    env: { PORT: String(PORT), ...(BUILT ? { SERVE_BUILT: "1" } : {}), CIVIC_EXPOSE_DEV_OTP: "1", CIVIC_E2E_SEED: "1", CIVIC_OTP_IP_LIMIT: "1000", CIVIC_OTP_NET_LIMIT: "1000", CIVIC_LEXICON_FILE: LEXICON, CIVIC_EXPORT_MAX_ROWS: "2", CIVIC_EXPORT_PER_HOUR: "100000", RATE_LIMIT_BURST: "100000", RATE_LIMIT_PER_SEC: "100000", CIVIC_DB: process.env.CIVIC_DB || path.join(os.tmpdir(), `civic-e2e-${process.pid}-${Date.now()}.db`) },
  },
});
