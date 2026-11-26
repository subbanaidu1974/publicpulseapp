import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openCivic } from './civic-helpers';
import { auth } from './civic-identity-helpers';

const uniqueEmail = () => `e2e.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.org`;

async function startEmailSignUp(page: Page, lang: 'en' | 'te' = 'en') {
  await openCivic(page, lang);
  await page.getByTestId('civic-signup-btn').click();
  await page.getByTestId('consent-notice-check').check();
  await page.getByTestId('consent-notice-accept').click();
  await page.getByTestId('su-no-phone').click();
}

async function finishEmailSignUp(page: Page, email: string, pin = '4821') {
  await page.getByTestId('su-email').fill(email);
  await page.getByTestId('su-send-email').click();
  const dev = page.getByTestId('dev-otp');
  await expect(dev).toBeVisible();
  const otp = ((await dev.textContent()) ?? '').match(/(\d{6})/)![1];
  await page.getByTestId('su-otp').fill(otp);
  await page.getByTestId('su-otp-next').click();
  await page.getByTestId('su-pin').fill(pin);
  await page.getByTestId('su-submit').click();
  await expect(page.getByTestId('civic-signed-in')).toBeVisible();
}

test.describe('email sign-up for people with no phone (S-165)', () => {
  test('@E2E-190 a person with no phone signs up with an email, is told surveys need a phone, and signs back in with the email and PIN', async ({ page }) => {
    const email = uniqueEmail();
    await startEmailSignUp(page);
    await expect(page.getByTestId('su-phone')).toHaveCount(0);
    await expect(page.getByTestId('su-email-note')).toContainText(/Surveys need a phone number/);
    const verify = page.waitForRequest((r) => r.url().includes('/identity/signup/email/verify'));
    await finishEmailSignUp(page, email);
    expect((await verify).postDataJSON().consent_version).toMatch(/^v\d+/);

    await page.getByTestId('sign-out').click();
    await page.getByTestId('civic-login-btn').click();
    await page.getByTestId('li-switch').click();
    await expect(page.getByTestId('li-phone')).toHaveCount(0);
    await page.getByTestId('li-email').fill(email);
    await page.getByTestId('li-pin').fill('9137');
    await page.getByTestId('li-submit').click();
    await expect(page.getByRole('alert')).toContainText('Wrong email or PIN');
    await page.getByTestId('li-pin').fill('4821');
    await expect(page.getByTestId('li-submit')).toBeEnabled();
    await page.getByTestId('li-submit').click();
    await expect(page.getByTestId('civic-signed-in')).toBeVisible();
  });

  test('@E2E-190 the email option is available in Telugu, a throwaway address is refused with a clear message, and the phone path is one click away', async ({ page }) => {
    await startEmailSignUp(page, 'te');
    await expect(page.getByTestId('su-email-note')).toContainText(/[ఀ-౿]/);
    await expect(page.getByTestId('su-use-phone')).toContainText(/[ఀ-౿]/);
    await page.getByTestId('su-email').fill('someone@mailinator.com');
    await page.getByTestId('su-send-email').click();
    await expect(page.getByTestId('su-otp')).toHaveCount(0); // stays on the address step
    await expect(page.getByRole('alert')).toContainText(/[ఀ-౿]/);
    await page.getByTestId('su-use-phone').click();
    await expect(page.getByTestId('su-phone')).toBeVisible();
  });

  test('@E2E-190 an email-only account is not survey-eligible and cannot be linked to a SIM; a second sign-up on the same address is refused', async ({ page, request }) => {
    const email = uniqueEmail();
    const rq = await request.post('/api/v1/civic/identity/signup/email/request', { data: { email } });
    expect(rq.status()).toBe(200);
    const otp = (await rq.json()).dev_otp as string;
    const up = await request.post('/api/v1/civic/identity/signup/email/verify', { data: { email, otp, pin: '4821', consent_version: 'v1' } });
    expect(up.status()).toBe(201);
    const { token, person } = await up.json();
    expect(person.survey_eligible).toBe(false);
    expect(person.flags).toContain('email_only');
    const link = await request.post('/api/v1/civic/identity/sim/link', { headers: auth(token), data: { pin: '7392', consent_version: 'v1' } });
    expect(link.status()).toBe(409);
    const again = await request.post('/api/v1/civic/identity/signup/email/request', { data: { email: email.toUpperCase() } });
    expect(again.status()).toBe(200);
    expect((await again.json()).dev_otp).toBeUndefined();
    await page.goto('/');
  });
});

test.describe('demo personas, no registration (S-166)', () => {
  test('@E2E-192 the sign-in screen offers ready-made accounts and one click signs in as a platform admin', async ({ page, request }) => {
    await openCivic(page);
    await expect(page.getByTestId('demo-personas')).toBeVisible();
    for (const key of ['resident_verified', 'volunteer', 'officer', 'journalist', 'admin']) await expect(page.getByTestId(`demo-${key}`)).toBeVisible();
    await page.getByTestId('demo-admin').click();
    await expect(page.getByTestId('civic-signed-in')).toBeVisible();
    const token = await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).find((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(v)) ?? '');
    expect(token).not.toBe('');
    const ops = await request.get('/api/v1/civic/ops/jobs', { headers: auth(token as string) });
    expect(ops.status()).toBe(200); // a real admin-only route accepts the demo admin
  });

  test('@E2E-192 each persona carries only its own roles: a demo resident is refused on the admin route, and a demo moderator is not an admin', async ({ request }) => {
    const login = async (persona: string) => (await (await request.post('/api/v1/civic/demo/login', { data: { persona } })).json()) as { token: string; roles: string[]; person: { survey_eligible: boolean; tier: string } };
    const resident = await login('resident_verified');
    expect(resident.roles).toEqual([]);
    expect(resident.person.survey_eligible).toBe(true);
    expect((await request.get('/api/v1/civic/ops/jobs', { headers: auth(resident.token) })).status()).toBe(403);
    const mod = await login('moderator');
    expect(mod.roles).toEqual(['moderator']);
    expect((await request.get('/api/v1/civic/ops/jobs', { headers: auth(mod.token) })).status()).toBe(403);
    const emailOnly = await login('resident_email_only');
    expect(emailOnly.person.survey_eligible).toBe(false);
  });

  test('@E2E-192 a demo person can report an issue like any signed-in resident, and the demo account can sign in again to the same identity', async ({ page, request }) => {
    const a = await (await request.post('/api/v1/civic/demo/login', { data: { persona: 'resident_verified' } })).json();
    const b = await (await request.post('/api/v1/civic/demo/login', { data: { persona: 'resident_verified' } })).json();
    expect(a.person.id).toBe(b.person.id);
    await openCivic(page);
    await page.getByTestId('demo-resident_verified').click();
    await expect(page.getByTestId('civic-signed-in')).toBeVisible();
    await page.getByTestId('cat-water').check();
    await page.getByTestId('ir-text').fill('Demo persona: hand pump not working near the school');
    await page.getByTestId('ir-village').fill('Kolluru');
    await page.getByTestId('village-option').first().click();
    await page.getByTestId('ir-submit').click();
    await expect(page.getByTestId('ir-sent')).toBeVisible();
  });
});
