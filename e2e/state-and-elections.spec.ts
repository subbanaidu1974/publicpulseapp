import { test, expect } from '@playwright/test';
import { openHome, openElections, selectElection } from './helpers';

test.describe('state switching and elections explorer', () => {
  test('@E2E-09 switch state AP to TG updates URL, content, and persists on reload', async ({ page }) => {
    await openHome(page, 'AP');
    const before = (await page.locator('main, body').first().innerText()).trim();
    await page.getByTestId('state-switcher').selectOption('TG');
    await expect(page).toHaveURL(/[?&]state=TG/);
    await expect(page.getByTestId('state-switcher')).toHaveValue('TG');
    await expect.poll(async () => (await page.locator('main, body').first().innerText()).trim()).not.toBe(before);
    // choice persists when reloading without the query param
    await page.goto('/');
    await expect(page.getByTestId('state-switcher')).toHaveValue('TG');
    await page.reload();
    await expect(page.getByTestId('state-switcher')).toHaveValue('TG');
  });

  test('@E2E-10 elections page shows TG 2023 assembly tally and ECI source', async ({ page }) => {
    await openElections(page, 'TG');
    await selectElection(page, '2023', 'assembly');
    const tally = page.getByTestId('elections-tally');
    await expect(tally).toBeVisible();
    await expect(tally.locator('[data-testid^="tally-row-"]').first()).toBeVisible();
    await expect(tally.getByTestId('tally-row-INC')).toBeVisible();
    await expect(page.getByTestId('elections-source')).toContainText(/ECI/);
  });

  test('@E2E-11 alliance toggle shows alliance seats and caveat for AP 2024', async ({ page }) => {
    await openElections(page, 'AP');
    await selectElection(page, '2024', 'assembly');
    await expect(page.getByTestId('alliance-caveat')).toBeHidden();
    await page.getByTestId('alliance-toggle').click();
    await expect(page.getByTestId('alliance-caveat')).toBeVisible();
    await expect(page.getByTestId('elections-tally')).toContainText(/TDP/);
  });
});
