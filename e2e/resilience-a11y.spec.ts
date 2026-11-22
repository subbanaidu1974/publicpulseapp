import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openHome, openElections, openConstituency, revealNav, gotoTab, apiSeats } from './helpers';

test.describe('mobile layout', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('@E2E-20 mobile 375px: no horizontal scroll, nav usable', async ({ page }) => {
    await openHome(page, 'AP');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const nav = await revealNav(page);
    await nav.click();
    await expect(page.getByTestId('elections-year-select')).toBeVisible();
    const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow2).toBeLessThanOrEqual(1);
    await openHome(page, 'AP');
    await gotoTab(page, /analytics/i);
    await expect(page.getByTestId('analytics-page')).toBeVisible();
    const overflow3 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow3).toBeLessThanOrEqual(1);
  });
});

test.describe('error handling', () => {
  test('@E2E-22 API 500 on elections shows friendly error with retry, not blank page', async ({ page }) => {
    let fail = true;
    await page.route('**/api/v1/**', (route) =>
      fail
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }) })
        : route.continue(),
    );
    await page.goto('/?state=AP');
    const nav = await revealNav(page);
    await nav.click();
    await expect(page.getByTestId('error-banner')).toBeVisible();
    await expect(page.getByTestId('retry-button')).toBeVisible();
    expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(0);
    await expect(page.locator('body')).not.toContainText(/at .*\.(ts|js):\d+/); // no stack traces
    fail = false;
    await page.getByTestId('retry-button').click();
    await expect(page.getByTestId('error-banner')).toBeHidden();
    await expect(page.getByTestId('elections-tally')).toBeVisible();
  });
});

test.describe('accessibility', () => {
  async function critical(page: import('@playwright/test').Page) {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    return results.violations.filter((v) => v.impact === 'critical').map((v) => `${v.id}: ${v.help} (${v.nodes.length})`);
  }

  test('@E2E-21 axe: no critical violations on home', async ({ page }) => {
    await openHome(page, 'AP');
    expect(await critical(page)).toEqual([]);
  });

  test('@E2E-21 axe: no critical violations on analytics and survey page', async ({ page }) => {
    await openHome(page, 'TG');
    await gotoTab(page, /analytics/i);
    await expect(page.getByTestId('analytics-page')).toBeVisible();
    expect(await critical(page)).toEqual([]);
    await gotoTab(page, /survey/i);
    expect(await critical(page)).toEqual([]);
  });

  test('@E2E-21 axe: no critical violations on elections', async ({ page }) => {
    await openElections(page, 'AP');
    await expect(page.getByTestId('elections-tally')).toBeVisible();
    expect(await critical(page)).toEqual([]);
  });

  test('@E2E-21 axe: no critical violations on constituency profile', async ({ page, request }) => {
    const [seat] = await apiSeats(request, 'AP');
    await openHome(page, 'AP');
    await gotoTab(page, /constituenc/i);
    await openConstituency(page, seat.acName);
    expect(await critical(page)).toEqual([]);
  });
});
