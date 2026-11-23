import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startServer, type Instance } from './degraded-helpers';
import { randomPhone } from './helpers';

// Count-day degraded mode (S-46, E2E-56) against REAL server instances: one started with CIVIC_DEGRADED=1, one with a tiny OTP slot so the
// send queue is genuinely used. The default server (healthy) is the baseURL of this project. No response is faked.
test.describe.configure({ mode: 'serial' });

let degraded: Instance, queueing: Instance;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  [degraded, queueing] = await Promise.all([
    startServer(4802, { CIVIC_DEGRADED: '1', CIVIC_DEGRADED_RETRY_SECONDS: '6' }),
    startServer(4803, { CIVIC_SMS_HOURLY_BUDGET: '10', CIVIC_OTP_MIN_BURST: '1' }),
  ]);
});
test.afterAll(async () => { await Promise.all([degraded?.stop(), queueing?.stop()]); });

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const setLang = (page: Page, lang: 'en' | 'te') => page.addInitScript((l) => { try { localStorage.setItem('pp-lang', l); } catch { /* ignore */ } }, lang);
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function toSignupPhone(page: Page, base: string) {
  await page.goto(`${base}/`);
  const nav = page.getByTestId('nav-civic');
  if (!(await nav.isVisible())) await page.locator('#mobile-menu-toggle').click();
  await page.getByTestId('nav-civic').click();
  await page.getByTestId('civic-signup-btn').click();
  await page.getByTestId('consent-notice-check').check();
  await page.getByTestId('consent-notice-accept').click();
  await expect(page.getByTestId('su-phone')).toBeVisible();
}

test('@E2E-56 a healthy server shows no banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('state-switcher')).toBeVisible();
  await expect(page.getByTestId('degraded-banner')).toHaveCount(0);
});

test('@E2E-56 degraded server: the server banner, read-only flag, paused and still-working lists', async ({ page, request }) => {
  const s = await (await request.get(`${degraded.url}/api/v1/degraded`)).json();
  expect(s.degraded).toBe(true);
  await page.goto(`${degraded.url}/`);
  const b = page.getByTestId('degraded-banner');
  await expect(b).toBeVisible();
  await expect(b).toHaveAttribute('data-read-only', '1');
  await expect(page.getByTestId('degraded-title')).toContainText(s.banner.title_en);
  await expect(page.getByTestId('degraded-body')).toHaveText(s.banner.body_en);
  await page.getByTestId('degraded-works').locator('summary').click();
  await expect(page.getByTestId('degraded-paused')).toContainText(/sign-up/i);
  await expect(page.getByTestId('degraded-works-list')).toContainText(/public information/i);
  expect(await overflow(page)).toBeLessThanOrEqual(1);
});

test('@E2E-56 the banner follows the language (Telugu text from the server)', async ({ page, request }) => {
  const s = await (await request.get(`${degraded.url}/api/v1/degraded`)).json();
  await setLang(page, 'te');
  await page.goto(`${degraded.url}/`);
  await expect(page.getByTestId('degraded-title')).toContainText(s.banner.title_te);
  await expect(page.getByTestId('degraded-body')).toHaveText(s.banner.body_te);
});

test('@E2E-56 server facts: shed routes answer 503 with Retry-After and a bilingual notice, public reads still work', async ({ request }) => {
  const shed = await request.get(`${degraded.url}/api/v1/civic/issues/export?format=ndjson`);
  expect(shed.status()).toBe(503);
  expect(shed.headers()['retry-after']).toBe('6');
  const j = await shed.json();
  expect(j.error).toBe('degraded');
  expect(j.notice_en).toBeTruthy();
  expect(j.notice_te).toBeTruthy();
  const feed = await request.get(`${degraded.url}/api/v1/civic/issues/feed?limit=1`);
  expect(feed.status()).toBe(200);
  expect(feed.headers()['x-degraded']).toBe('1');
});

test('@E2E-56 a shed sign-up request shows the server notice with a retry countdown, not a generic error', async ({ page }) => {
  await toSignupPhone(page, degraded.url);
  await page.getByTestId('su-phone').fill(randomPhone());
  await page.getByTestId('su-send-otp').click();
  const n = page.getByTestId('signup-shed');
  await expect(n).toBeVisible();
  await expect(n).toHaveAttribute('data-shed', 'signup_otp');
  await expect(page.getByTestId('signup-shed-text')).toContainText(/try again/i);
  await expect(page.getByTestId('civic-error')).toHaveCount(0);
  const first = Number(await page.getByTestId('signup-shed-countdown').getAttribute('data-left'));
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThanOrEqual(6);
  await expect(page.getByTestId('signup-shed-retry')).toBeDisabled();
  await expect(page.getByTestId('signup-shed-countdown')).toHaveAttribute('data-left', '0', { timeout: 10_000 });
  await expect(page.getByTestId('signup-shed-retry')).toBeEnabled();
  // the site banner also learned about the shed
  await expect(page.getByTestId('banner-shed')).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
});

test('@E2E-56 the shed notice is in Telugu when the language is Telugu', async ({ page }) => {
  await setLang(page, 'te');
  await toSignupPhone(page, degraded.url);
  await page.getByTestId('su-phone').fill(randomPhone());
  await page.getByTestId('su-send-otp').click();
  await expect(page.getByTestId('signup-shed-text')).toContainText(/[ఀ-౿]/);
});

test('@E2E-56 a queued sign-up code shows a friendly wait state with the expected delay', async ({ page, request }) => {
  // Burn the slot through the API until the server reports a queued code (one slot admits one send), then use the UI at once.
  let queued = false;
  for (let i = 0; i < 4 && !queued; i++) {
    const r = await request.post(`${queueing.url}/api/v1/civic/identity/signup/request`, { data: { phone: '+91' + randomPhone() } });
    queued = !!(await r.json()).queued;
  }
  expect(queued, 'server never queued a send').toBe(true);
  await toSignupPhone(page, queueing.url);
  await page.getByTestId('su-phone').fill(randomPhone());
  await page.getByTestId('su-send-otp').click();
  const q = page.getByTestId('otp-queued');
  await expect(q).toBeVisible();
  const secs = Number(await q.getAttribute('data-seconds'));
  expect(secs).toBeGreaterThan(0);
  expect(secs).toBeLessThanOrEqual(120);
  await expect(q).toContainText(/queued/i);
  await expect(q).toContainText(/seconds/i);
  await expect(page.getByTestId('civic-error')).toHaveCount(0);
  await expect(page.getByTestId('su-otp')).toBeVisible(); // the person can already type the code once it arrives
});

for (const lang of ['en', 'te'] as const) {
  test(`@E2E-57 axe, ${lang}: degraded banner and shed notice`, async ({ page }) => {
    await setLang(page, lang);
    await toSignupPhone(page, degraded.url);
    await page.getByTestId('su-phone').fill(randomPhone());
    await page.getByTestId('su-send-otp').click();
    await expect(page.getByTestId('signup-shed')).toBeVisible();
    await page.getByTestId('degraded-works').locator('summary').click();
    const v = (await new AxeBuilder({ page }).include('[data-testid=degraded-banner]').include('[data-testid=signup-shed]').withTags(TAGS).analyze()).violations
      .filter((x) => x.impact === 'critical' || x.impact === 'serious').map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
    expect(v).toEqual([]);
  });
}
