import { test, expect } from '@playwright/test';
import { openCivicSignedIn } from './civic-helpers';
import { startOnCivicTab } from './civic-helpers';
test.beforeEach(async ({ page }) => { await startOnCivicTab(page, 'account'); });

test.describe('civic residence declaration (T1)', () => {
  test('@E2E-148 declare residence state > district > mandal > village, honest self-declared copy, badge updates to T1', async ({ page, request }) => {
    await openCivicSignedIn(page, request, 'en');
    await expect(page.getByTestId('tier-badge')).toBeVisible();
    if (await page.getByTestId('res-change').isVisible()) await page.getByTestId('res-change').click();
    await expect(page.getByTestId('res-honest')).toContainText(/only what you tell us/);
    await expect(page.getByTestId('res-honest')).toContainText(/not checked/);
    await page.getByTestId('res-state').selectOption('AP');
    await expect.poll(async () => page.locator('#res-district option').count()).toBeGreaterThan(1);
    await page.getByTestId('res-district').selectOption({ index: 1 });
    await expect.poll(async () => page.locator('#res-mandal option').count()).toBeGreaterThan(1);
    await page.getByTestId('res-mandal').selectOption({ index: 1 });
    await expect.poll(async () => page.locator('#res-village option').count()).toBeGreaterThan(1);
    await page.getByTestId('res-village').selectOption({ index: 1 });
    await page.getByTestId('res-hamlet').fill('Harijanawada');
    const req = page.waitForRequest((r) => r.url().includes('/identity/residence'));
    await page.getByTestId('res-submit').click();
    const body = (await req).postDataJSON();
    expect(body.residence).toContain('Harijanawada');
    expect(body.residence).toContain('AP');
    await expect(page.getByTestId('res-saved')).toBeVisible();
    await expect(page.getByTestId('tier-badge')).toHaveAttribute('data-tier', /T1|T2/);
    await expect(page.getByTestId('tier-label')).toContainText(/told by you|confirmed/);
  });

  test('@E2E-148 village search works in Telugu and English and shows the village before saving', async ({ page, request }) => {
    await openCivicSignedIn(page, request, 'te');
    if (await page.getByTestId('res-change').isVisible()) await page.getByTestId('res-change').click();
    await page.getByTestId('res-search').fill('Kol');
    await expect(page.getByTestId('res-hit').first()).toBeVisible();
    await page.getByTestId('res-hit').first().click();
    await expect(page.getByTestId('res-selected')).toBeVisible();
    await expect(page.getByTestId('residence-flow')).toContainText('రాష్ట్రం');
    await expect(page.getByTestId('res-honest')).toContainText('తనిఖీ చేయలేదు');
  });

  test('@E2E-148 submitting without a village is refused with a clear message', async ({ page, request }) => {
    await openCivicSignedIn(page, request, 'en');
    if (await page.getByTestId('res-change').isVisible()) await page.getByTestId('res-change').click();
    await page.getByTestId('res-submit').click();
    await expect(page.getByTestId('civic-error')).toContainText(/Choose a village first/);
  });
});
