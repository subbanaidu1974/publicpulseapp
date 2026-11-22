import { test, expect } from '@playwright/test';
import { openHome, gotoTab, revealNav, randomPhone, submitSurvey } from './helpers';

async function openSurvey(page: import('@playwright/test').Page) {
  await openHome(page, 'AP');
  await gotoTab(page, /survey/i);
  await page.getByRole('button', { name: /lock vote/i }).click();
  await expect(page.getByRole('button', { name: /dual-factor/i }).first()).toBeVisible();
}

test.describe('survey', () => {
  test('@E2E-15 valid survey is accepted and shows thank-you with results gated', async ({ page }) => {
    await openSurvey(page);
    await submitSurvey(page, randomPhone());
    await expect(page.getByTestId('survey-thanks')).toBeVisible();
    await expect(page.getByText(/hidden until at least 30/i)).toBeVisible();
  });

  test('@E2E-16 missing required fields show inline errors', async ({ page }) => {
    await openSurvey(page);
    await page.getByRole('button', { name: /dual-factor/i }).first().click();
    await page.getByRole('button', { name: /get otp/i }).click();
    // required demographics are flagged inline (form returns to the demographics step)
    await expect(page.getByTestId('survey-error-ageGroup')).toBeVisible();
    await expect(page.getByTestId('survey-error-gender')).toBeVisible();
    await expect(page.getByTestId('survey-thanks')).toBeHidden();
  });

  test('@E2E-16 duplicate submission is rejected', async ({ page }) => {
    const phone = randomPhone();
    await openSurvey(page);
    await submitSurvey(page, phone);
    await expect(page.getByTestId('survey-thanks')).toBeVisible();
    await openSurvey(page);
    await page.locator('select').filter({ has: page.locator('option[value="18-25"]') }).selectOption('18-25');
    await page.locator('select').filter({ has: page.locator('option[value="Female"]') }).selectOption('Female');
    await page.getByRole('button', { name: /dual-factor/i }).first().click();
    await page.locator('input[type=tel]').fill(phone);
    await page.getByRole('button', { name: /get otp/i }).click();
    await expect(page.getByTestId('survey-error-phone')).toContainText(/already submitted/i);
    await expect(page.getByTestId('survey-thanks')).toBeHidden();
  });

  test('@E2E-18 demo badge visible on synthetic survey stats and methodology link works', async ({ page }) => {
    await openHome(page, 'AP');
    await gotoTab(page, /analytics/i);
    await expect(page.getByTestId('demo-badge').first()).toBeVisible();
    await gotoTab(page, /methodology/i);
    await expect(page.getByRole('heading', { name: /methodology/i }).first()).toBeVisible();
  });
});

test.describe('language', () => {
  test('@E2E-17 toggle EN to Telugu translates nav and persists', async ({ page }) => {
    await openHome(page, 'AP');
    const navText = async () => ((await (await revealNav(page)).textContent()) ?? '').trim();
    const english = await navText();
    await page.getByTestId('lang-toggle').click();
    await expect.poll(navText).toMatch(/[ఀ-౿]/);
    await page.reload();
    await expect.poll(navText).toMatch(/[ఀ-౿]/);
    await page.getByTestId('lang-toggle').click();
    await expect.poll(navText).toBe(english);
  });
});

test.describe('admin', () => {
  test('@E2E-19 non-admin is blocked from data status page', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByTestId('admin-data-status')).toBeHidden();
  });

  test('@E2E-19 admin login shows per-source last-updated', async ({ page }) => {
    test.skip(!process.env.E2E_ADMIN_EMAIL, 'admin credentials not provided (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD / E2E_ADMIN_OTP)');
    await page.goto('/admin');
    await page.getByLabel(/email/i).fill(process.env.E2E_ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(process.env.E2E_ADMIN_PASSWORD || '');
    await page.getByRole('button', { name: /sign in|log in|login|continue/i }).click();
    if (process.env.E2E_ADMIN_OTP) {
      await page.getByLabel(/otp|code/i).fill(process.env.E2E_ADMIN_OTP);
      await page.getByRole('button', { name: /verify|submit|continue/i }).click();
    }
    const status = page.getByTestId('admin-data-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText(/last.?updated|updated/i);
  });
});
