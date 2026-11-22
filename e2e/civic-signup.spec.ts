import { test, expect } from '@playwright/test';
import { completeSignUpFromConsent, openCivic, openCivicSignedIn } from './civic-helpers';

test.describe('civic sign-up', () => {
  test('@E2E-54 notice and consent shown (Telugu and English) before any data is entered, version sent, grievance contact visible', async ({ page }) => {
    await openCivic(page, 'te');
    await page.getByTestId('civic-signup-btn').click();
    await expect(page.getByTestId('consent-notice')).toBeVisible();
    await expect(page.getByTestId('consent-notice-text')).toContainText(/[ఀ-౿]/);
    await expect(page.getByTestId('grievance-contact')).toBeVisible();
    // No phone field before consent is accepted.
    await expect(page.getByTestId('su-phone')).toHaveCount(0);
    await expect(page.getByTestId('consent-notice-accept')).toBeDisabled();

    await page.getByTestId('lang-toggle').click();
    await expect(page.getByTestId('consent-notice-text')).toContainText(/WHAT:/);

    const verify = page.waitForRequest((r) => r.url().includes('/identity/signup/verify'));
    await completeSignUpFromConsent(page);
    const body = (await verify).postDataJSON();
    expect(body.consent_version).toMatch(/^v\d+/);
  });

  test('@E2E-54 signed-in citizen can report an issue and see it in the feed', async ({ page, request }) => {
    await openCivicSignedIn(page, request);
    await page.getByTestId('cat-water').check();
    await page.getByTestId('ir-text').fill('Hand pump not working near the school');
    await page.getByTestId('ir-village').fill('Kolluru');
    await page.getByTestId('village-option').first().click();
    await page.getByTestId('ir-submit').click();
    await expect(page.getByTestId('ir-sent')).toBeVisible();
    await expect(page.getByTestId('issue-item').first()).toBeVisible();
  });
});
