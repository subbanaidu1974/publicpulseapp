import { test, expect } from '@playwright/test';
import { openHome, openConstituency, gotoTab, apiSeats } from './helpers';

test.describe('constituency search, map, compare', () => {
  test('@E2E-12 search by English name opens profile with history, census, survey', async ({ page, request }) => {
    const [seat] = await apiSeats(request, 'AP');
    await openHome(page, 'AP');
    await gotoTab(page, /constituenc/i);
    await openConstituency(page, seat.acName);
    const profile = page.getByTestId('constituency-profile');
    await expect(profile).toContainText(seat.acName);
    await expect(profile).toContainText(/census/i);
    await expect(profile).toContainText(/survey/i);
    await expect(profile).toContainText(/20\d\d/); // election history years
  });

  test('@E2E-12 search by Telugu name returns results', async ({ page, request }) => {
    const seat = (await apiSeats(request, 'AP')).find((s) => s.acNameTe);
    test.skip(!seat, 'AP seat data has no Telugu names (acNameTe) yet; cannot exercise Telugu search');
    await openHome(page, 'AP');
    await gotoTab(page, /constituenc/i);
    await page.getByTestId('constituency-search').fill(seat!.acNameTe!);
    await expect(page.getByTestId('constituency-result').first()).toBeVisible();
  });

  test('@E2E-13 map layers update, are keyboard reachable, and have a table fallback', async ({ page }) => {
    await openHome(page, 'AP');
    await gotoTab(page, /analytics/i);
    const select = page.getByTestId('map-layer-select');
    await expect(select).toBeVisible();
    const values = await select.locator('option').evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => o.value));
    expect(values.length).toBeGreaterThanOrEqual(3);
    const snapshots: string[] = [];
    for (const v of values.slice(0, 3)) {
      await select.selectOption(v);
      await expect(select).toHaveValue(v);
      await expect(page.getByTestId('map-legend')).toBeVisible();
      snapshots.push(((await page.getByTestId('map-legend').textContent()) ?? '').trim());
    }
    // legend text differs between layers; table fallback is available
    await expect(page.getByTestId('map-table-fallback')).toBeAttached();
    expect(new Set(snapshots).size).toBeGreaterThan(1);
    // keyboard focus reachable
    await select.focus();
    await expect(select).toBeFocused();
  });

  test('@E2E-14 compare constituencies across states side by side with sources', async ({ page, request }) => {
    const ap = (await apiSeats(request, 'AP'))[0];
    const tg = (await apiSeats(request, 'TG'))[0];
    await openHome(page, 'AP');
    await gotoTab(page, /constituenc/i);
    await openConstituency(page, ap.acName);
    await page.getByRole('button', { name: /compare/i }).first().click();
    await page.getByTestId('state-switcher').selectOption('TG');
    await openConstituency(page, tg.acName);
    await page.getByRole('button', { name: /compare/i }).first().click();
    const compare = page.getByTestId('constituency-compare');
    await expect(compare).toContainText(ap.acName);
    await expect(compare).toContainText(tg.acName);
    await expect(compare).toContainText(/(AP)/);
    await expect(compare).toContainText(/(TG)/);
    await expect(compare).toContainText(/source/i);
  });
});
