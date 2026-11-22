import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomPhone } from './helpers';

/**
 * S-75 / E2E-90: the separately built /lite page. Run against the production bundle for the 2G numbers:
 *   npm run build && SERVE_BUILT=1 CIVIC_EXPOSE_DEV_OTP=1 PORT=4101 node dist/server.cjs   (RATE_LIMIT_* raised)
 *   PORT=4101 npx playwright test e2e/lite.spec.ts --project=chromium --workers=1
 */
test.describe.configure({ mode: 'serial' });

const PIN = '4821';
const THIRD_PARTY = (u: string, base: string) => { const x = new URL(u); return x.protocol.startsWith('http') && x.origin !== new URL(base).origin; };

async function apiSignUp(request: APIRequestContext) {
  const phone = '+91' + randomPhone();
  const r = await request.post('/api/v1/civic/identity/signup/request', { data: { phone } });
  const otp = (await r.json()).dev_otp as string;
  const v = await request.post('/api/v1/civic/identity/signup/verify', { data: { phone, otp, pin: PIN, consent_version: 'v1' } });
  return { phone, token: (await v.json()).token as string };
}
async function withToken(page: Page, token: string) {
  await page.addInitScript((t) => { try { sessionStorage.setItem('civic-token', t); } catch { /* ignore */ } }, token);
}
async function english(page: Page) {
  await page.addInitScript(() => { try { localStorage.setItem('lite-lang', 'en'); } catch { /* ignore */ } });
}
async function pickVillage(page: Page) {
  await page.getByTestId('lite-village-q').fill('Kolluru');
  await page.locator('#lite-hits button').first().click();
  await expect(page.getByTestId('lite-village-selected')).toBeVisible();
}

test.describe('lite page', () => {
  test('@E2E-90 loads with no third-party request, no map, no Telugu font until Telugu is chosen', async ({ page, baseURL }) => {
    const reqs: string[] = [];
    page.on('request', (r) => reqs.push(r.url()));
    await english(page);
    await page.goto('/lite');
    await expect(page.getByTestId('lite-form')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-lite-ready', '1');
    expect(reqs.filter((u) => THIRD_PARTY(u, baseURL!))).toEqual([]);
    expect(reqs.some((u) => /leaflet|tile|\.pbf/i.test(u))).toBe(false);
    expect(reqs.some((u) => /\/fonts\//.test(u))).toBe(false);
    for (const c of ['water', 'roads', 'electricity', 'health', 'education', 'agriculture', 'welfare', 'law_order', 'other']) await expect(page.getByTestId(`lite-cat-${c}`)).toBeAttached();
    await page.getByTestId('lite-lang').click();
    await expect(page.getByRole('heading', { name: 'స్థానిక సమస్యను నమోదు చేయండి' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'te');
    await expect.poll(() => reqs.some((u) => /\/fonts\/NotoSansTelugu-subset\.woff2/.test(u))).toBe(true);
    expect(reqs.filter((u) => THIRD_PARTY(u, baseURL!))).toEqual([]);
  });

  test('@E2E-90 sign up with an OTP, find the village, attach a photo and send a report', async ({ page }) => {
    await english(page);
    await page.goto('/lite');
    await page.getByTestId('lite-to-signup').click();
    await expect(page.getByTestId('lite-notice')).not.toHaveText(/Loading/);
    await page.getByTestId('lite-consent').check();
    await page.getByTestId('lite-phone').fill(randomPhone());
    await page.getByTestId('lite-send-code').click();
    const dev = page.getByTestId('lite-dev-otp');
    await expect(dev).toBeVisible();
    const otp = ((await dev.textContent()) ?? '').match(/(\d{6})/)![1];
    await page.getByTestId('lite-otp').fill(otp);
    await page.getByTestId('lite-pin').fill(PIN);
    await page.getByTestId('lite-signup-submit').click();
    await expect(page.getByTestId('lite-signed-in')).toBeVisible();

    await page.getByTestId('lite-cat-water').check({ force: true });
    await pickVillage(page);
    await page.getByTestId('lite-desc').fill('Hand pump near the school has been broken for a week.');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await page.getByTestId('lite-photo').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: png });
    await page.getByTestId('lite-submit').click();
    await expect(page.getByTestId('lite-status')).toContainText(/Report sent/i);
  });

  test('@E2E-90 sign in with phone and PIN, wrong PIN is refused', async ({ page, request }) => {
    const { phone } = await apiSignUp(request);
    await english(page);
    await page.goto('/lite');
    await page.getByTestId('lite-phone').fill(phone.slice(3));
    await page.getByTestId('lite-pin').fill('9999');
    await page.getByTestId('lite-signin-submit').click();
    await expect(page.getByTestId('lite-status')).toContainText(/Wrong phone or PIN/);
    await page.getByTestId('lite-pin').fill(PIN);
    await page.getByTestId('lite-signin-submit').click();
    await expect(page.getByTestId('lite-signed-in')).toBeVisible();
  });

  test('@E2E-90 offline: the shell loads from the service worker and a report is queued, then sent when back online', async ({ page, context, request }) => {
    test.skip(process.env.E2E_BUILT !== '1', 'needs the production bundle (hashed /assets/*): run `npm run build` then `E2E_BUILT=1 npx playwright test e2e/lite.spec.ts`');
    const { token } = await apiSignUp(request);
    await withToken(page, token);
    await english(page);
    await page.goto('/lite');
    await expect(page.getByTestId('lite-form')).toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(async () => !!(await caches.match('/lite')))).toBe(true);
    await expect.poll(() => page.evaluate(async () => { const ks = await (await caches.open('civic-lite-v2')).keys(); return ks.some((k) => /\/assets\/lite-.*\.js/.test(k.url)); })).toBe(true);

    await pickVillage(page);
    await page.getByTestId('lite-cat-roads').check({ force: true });
    await page.getByTestId('lite-desc').fill('Road to the market is full of potholes.');
    await context.setOffline(true);
    await page.getByTestId('lite-submit').click();
    await expect(page.getByTestId('lite-status')).toContainText(/Saved on this phone/);
    await expect(page.getByTestId('lite-queue')).toContainText('1');

    // a fresh navigation while offline still renders the page (offline shell)
    await page.reload();
    await expect(page.getByTestId('lite-form')).toBeVisible();
    await expect(page.getByTestId('lite-offline')).toBeVisible();
    await expect(page.getByTestId('lite-queue')).toContainText('1');

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByTestId('lite-queue')).toHaveCount(0);
  });
});

/** Simulated 2G: 50 kbit/s down, 20 kbit/s up, 300 ms RTT, cache disabled. Numbers are written to test-results/lite-2g.json and docs/PERFORMANCE.md. */
const MAX_FIRST_USABLE_MS = 8000;
test.describe('lite on 2G', () => {
  test('@E2E-90 @measure first usable form on a simulated 2G connection', async ({ browser, baseURL }, info) => {
    test.skip(process.env.E2E_BUILT !== '1', 'timing is only meaningful on the production bundle: run `npm run build` then `E2E_BUILT=1 npx playwright test e2e/lite.spec.ts --project=chromium -g measure`');
    test.skip(info.project.name !== 'chromium', 'CDP throttling is measured on desktop Chromium only');
    test.setTimeout(240_000);
    const runs: Record<string, number>[] = [];
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
      const page = await context.newPage();
      await english(page);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: (50 * 1000) / 8, uploadThroughput: (20 * 1000) / 8 });
      let bytes = 0; const urls: string[] = [];
      cdp.on('Network.loadingFinished', (e: { encodedDataLength: number }) => { bytes += e.encodedDataLength; });
      cdp.on('Network.requestWillBeSent', (e: { request: { url: string } }) => { urls.push(new URL(e.request.url).pathname); });
      const t0 = Date.now();
      await page.goto('/lite', { waitUntil: 'commit' });
      await page.getByTestId('lite-form').waitFor({ state: 'visible', timeout: 120_000 });
      const formVisible = Date.now() - t0;
      await page.getByTestId('lite-desc').fill('ok'); // the first keystroke lands: the page is interactive
      const interactive = Date.now() - t0;
      const nav = await page.evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        return { responseEnd: Math.round(n.responseEnd), domInteractive: Math.round(n.domInteractive), fcp: Math.round(fcp?.startTime ?? 0) };
      });
      const before = bytes; const reqBefore = urls.length;
      // Telugu: the font is fetched lazily, after the form is already usable
      await page.getByTestId('lite-lang').click();
      const tf = Date.now();
      await page.waitForFunction(() => [...document.fonts].some((f) => f.family.includes('Noto Telugu Lite') && f.status === 'loaded'), null, { timeout: 120_000 });
      runs.push({ formVisible, interactive, ...nav, firstLoadBytes: before, firstLoadRequests: reqBefore, teluguFontMs: Date.now() - tf, teluguFontBytes: bytes - before });
      expect(urls.slice(0, reqBefore).some((u) => u.startsWith('/fonts/'))).toBe(false);
      expect(urls.some((u) => u.startsWith('/fonts/'))).toBe(true);
      await context.close();
    }
    const med = (k: string) => [...runs.map((r) => r[k])].sort((a, b) => a - b)[1];
    const summary = { profile: '50 kbit/s down, 20 kbit/s up, 300 ms RTT, cache disabled, desktop Chromium', runs, median: Object.fromEntries(Object.keys(runs[0]).map((k) => [k, med(k)])) as Record<string, number> };
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync(path.join('test-results', 'lite-2g.json'), JSON.stringify(summary, null, 2));
    console.log('LITE-2G ' + JSON.stringify(summary.median));
    expect(summary.median.interactive).toBeLessThan(MAX_FIRST_USABLE_MS);
  });
});
