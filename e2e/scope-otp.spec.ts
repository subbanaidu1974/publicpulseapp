import { test, expect, type Page } from '@playwright/test';
import { startServer, type Instance } from './degraded-helpers';
import { randomPhone } from './helpers';

// S-156 (E2E-171): the OTP capacity refusal (429) carries bilingual notices and the sign-up screen shows the server's own text. A real second
// server with a one-SMS hourly budget; nothing is faked: the first request spends the budget, the sign-up screen then meets the real 429.
test.describe.configure({ mode: 'serial' });

let capped: Instance;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  capped = await startServer(4806, { CIVIC_SMS_HOURLY_BUDGET: '1' });
});
test.afterAll(async () => { await capped?.stop(); });

const setLang = (page: Page, lang: 'en' | 'te') => page.addInitScript((l) => { try { localStorage.setItem('pp-lang', l); } catch { /* ignore */ } }, lang);
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

let spent = false;
test('@E2E-171 the 429 sms-capacity answer carries notice_en and notice_te', async ({ request }) => {
  const first = await request.post(`${capped.url}/api/v1/civic/identity/signup/request`, { data: { phone: '+91' + randomPhone() } });
  expect(first.status()).toBe(200);
  spent = true;
  const r = await request.post(`${capped.url}/api/v1/civic/identity/signup/request`, { data: { phone: '+91' + randomPhone() } });
  expect(r.status()).toBe(429);
  const j = await r.json();
  expect(j.degraded).toBe(true);
  expect(j.notice_en).toMatch(/try again/i);
  expect(j.notice_te).toMatch(/[\u0C00-\u0C7F]/);
  expect(r.headers()['retry-after']).toBeTruthy();
});

for (const lang of ['en', 'te'] as const) {
  test(`@E2E-171 the sign-up screen shows the server notice in ${lang}, not a generic error`, async ({ page, request }) => {
    expect(spent).toBe(true);
    const j = await (await request.post(`${capped.url}/api/v1/civic/identity/signup/request`, { data: { phone: '+91' + randomPhone() } })).json();
    await setLang(page, lang);
    await toSignupPhone(page, capped.url);
    await page.getByTestId('su-phone').fill(randomPhone());
    await page.getByTestId('su-send-otp').click();
    const n = page.getByTestId('signup-shed');
    await expect(n).toBeVisible();
    await expect(page.getByTestId('signup-shed-text')).toHaveText(lang === 'te' ? j.notice_te : j.notice_en);
    await expect(page.getByTestId('civic-error')).toHaveCount(0);
  });
}
