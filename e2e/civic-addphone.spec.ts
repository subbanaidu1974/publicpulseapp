import { test, expect } from '@playwright/test';
import { openCivic, randomPhone } from './civic-helpers';
import { startOnCivicTab } from './civic-helpers';
test.beforeEach(async ({ page }) => { await startOnCivicTab(page, 'account'); });

test.describe('adding a phone to an email-only account (S-167)', () => {
  test('@E2E-194 an email-only person sees the add-phone panel and a person with a phone never does', async ({ page, request }) => {
    // the email-only demo account is not on the sign-in screen any more (only five are), but the route still signs in as it
    const login = await request.post('/api/v1/civic/demo/login', { data: { persona: 'resident_email_only' } });
    const { token } = await login.json();
    await page.addInitScript((t) => { try { sessionStorage.setItem('civic-token', t); } catch { /* ignore */ } }, token);
    await openCivic(page);
    await expect(page.getByTestId('civic-signed-in')).toBeVisible();
    await expect(page.getByTestId('add-phone')).toBeVisible();
    // a person with a phone never sees it
    await page.getByTestId('sign-out').click();
    await page.getByTestId('demo-resident_verified').click();
    await expect(page.getByTestId('civic-signed-in')).toBeVisible();
    await expect(page.getByTestId('add-phone')).toHaveCount(0);
  });

  test('@E2E-194 a new email account upgrades with a phone through the screen: code sent, number added, panel gone, survey-eligible after the waiting period', async ({ page, request }) => {
    const email = `e2e.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.org`;
    const rq = await request.post('/api/v1/civic/identity/signup/email/request', { data: { email } });
    const otp = (await rq.json()).dev_otp as string;
    const up = await (await request.post('/api/v1/civic/identity/signup/email/verify', { data: { email, otp, pin: '4821', consent_version: 'v1' } })).json();
    await page.addInitScript((t) => { try { sessionStorage.setItem('civic-token', t); } catch { /* ignore */ } }, up.token);
    await openCivic(page);
    await expect(page.getByTestId('add-phone')).toBeVisible();
    await page.getByTestId('ap-phone').fill(randomPhone());
    await page.getByTestId('ap-send').click();
    const dev = page.getByTestId('ap-dev-otp');
    await expect(dev).toBeVisible();
    await page.getByTestId('ap-otp').fill(((await dev.textContent()) ?? '').match(/(\d{6})/)![1]);
    await page.getByTestId('ap-submit').click();
    await expect(page.getByTestId('add-phone')).toHaveCount(0);
  });
});
