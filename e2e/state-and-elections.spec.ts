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

  test('@E2E-10 the year pickers are read from the data: a year the server does not list is not offered, and the real list is offered', async ({ page }) => {
    // 1. the real data: Telangana assembly 2023, 2018, 2014 (newest first) and Lok Sabha 2024, 2019
    await openElections(page, 'TG');
    const years = async () => page.getByTestId('elections-year-select').locator('option').allTextContents();
    await expect.poll(years).toEqual(['2023', '2018', '2014']);
    await page.getByTestId('elections-type-select').selectOption('ls');
    await expect.poll(years).toEqual(['2024', '2019']);
  });

  test('@E2E-10 when the server lists fewer elections, the picker shrinks with it (no hard-coded years)', async ({ page }) => {
    await page.route('**/api/v1/states', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      for (const s of body.states) s.elections = s.elections.filter((e: { year: number; type: string }) => !(e.type === 'assembly' && e.year === 2014));
      await route.fulfill({ response: res, json: body });
    });
    await openElections(page, 'TG');
    await expect.poll(async () => page.getByTestId('elections-year-select').locator('option').allTextContents()).toEqual(['2023', '2018']);
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
