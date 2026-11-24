import { test, expect } from '@playwright/test';
import { openCivic, randomPhone } from './civic-helpers';

// The answers are staged with page.route (a vendor outage cannot be provoked on the dev SMS provider); the real server side is covered by tests/civic/hardening/sms.delivery.test.ts.
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

test.describe('honest SMS state on sign-up (S-164)', () => {
  test('@E2E-188 a send that failed says so (not "code sent"), the person can ask again at once, and a queued code says it may be late', async ({ page }) => {
    await openCivic(page, 'en');
    await page.getByTestId('civic-signup-btn').click();
    await page.getByTestId('consent-notice-check').check();
    await page.getByTestId('consent-notice-accept').click();
    await page.getByTestId('su-phone').fill(randomPhone());

    await page.route('**/identity/signup/request', (route) => route.fulfill(json(502, { error: 'we could not send the code; try again in a moment', delivery: 'failed', can_retry: true })));
    await page.getByTestId('su-send-otp').click();
    await expect(page.getByTestId('civic-error')).toContainText(/could not send the code to your phone/);
    await expect(page.getByTestId('su-otp')).toHaveCount(0); // still on the phone step: nothing was sent, so no code box
    await expect(page.getByTestId('su-send-otp')).toBeEnabled(); // an immediate retry is possible

    await page.unroute('**/identity/signup/request');
    await page.route('**/identity/signup/request', (route) => route.fulfill(json(200, { ok: true, delivery: 'queued', dev_otp: '123456', expires_in_s: 300 })));
    await page.getByTestId('su-send-otp').click();
    await expect(page.getByTestId('su-delivery-queued')).toContainText(/may take a little longer/);
    await expect(page.getByTestId('su-otp')).toBeVisible();
    await expect(page.getByTestId('su-resend')).toBeVisible();

    // the resend button asks again; a failure here is also shown honestly
    await page.unroute('**/identity/signup/request');
    await page.route('**/identity/signup/request', (route) => route.fulfill(json(502, { error: 'x', delivery: 'failed', can_retry: true })));
    await page.getByTestId('su-resend').click();
    await expect(page.getByTestId('civic-error')).toContainText(/could not send the code/);
  });

  test('@E2E-188 the messages are available in Telugu', async ({ page }) => {
    await openCivic(page, 'te');
    await page.getByTestId('civic-signup-btn').click();
    await page.getByTestId('consent-notice-check').check();
    await page.getByTestId('consent-notice-accept').click();
    await page.getByTestId('su-phone').fill(randomPhone());
    await page.route('**/identity/signup/request', (route) => route.fulfill(json(502, { error: 'x', delivery: 'failed' })));
    await page.getByTestId('su-send-otp').click();
    await expect(page.getByTestId('civic-error')).toContainText('కోడ్ పంపలేకపోయాం');
  });
});
