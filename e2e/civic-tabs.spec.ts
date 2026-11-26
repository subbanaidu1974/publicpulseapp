import { test, expect } from '@playwright/test';
import { openCivic } from './civic-helpers';

/** The Civic page tabs (S-222): Report an issue and My reports are separate tabs for every signed-in user, and the top bar carries Sign in and Log out. */
const TABS = ['report', 'mine', 'household', 'account', 'explore', 'roles'];

test.describe('civic tabs and top-bar sign in (S-222)', () => {
  test('@E2E-217 every demo user gets the same six tabs, with Report an issue and My reports on their own tabs', async ({ page }) => {
    await openCivic(page);
    // the tab bar is not shown to a person who is not signed in
    await expect(page.getByTestId('civic-tabs')).toHaveCount(0);
    for (const who of ['resident_verified', 'volunteer', 'officer', 'journalist']) {
      await page.getByTestId(`demo-${who}`).click();
      await expect(page.getByTestId('civic-signed-in')).toBeVisible();
      const ids = await page.locator('[role=tab]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').replace('civic-tab-', '')));
      expect(ids, who).toEqual(TABS);
      await page.getByTestId('civic-tab-report').click();
      await expect(page.getByTestId('civic-tab-report')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('civic-panel-report')).toBeVisible();
      await expect(page.getByTestId('ir-submit')).toBeVisible(); // the report form is here
      await expect(page.getByTestId('my-reports')).toBeHidden(); // and My reports is not
      await page.getByTestId('civic-tab-mine').click();
      await expect(page.getByTestId('my-reports')).toBeVisible();
      await expect(page.getByTestId('ir-submit')).toBeHidden();
      await page.getByTestId('sign-out').click();
      await expect(page.getByTestId('demo-personas')).toBeVisible();
    }
  });

  test('@E2E-217 the admin lands on the survey page only, and can open the other tools', async ({ page }) => {
    await openCivic(page);
    await page.getByTestId('demo-admin').click();
    await expect(page.getByTestId('admin-survey-home')).toBeVisible();
    await expect(page.getByTestId('polls-admin')).toBeVisible();
    await expect(page.getByTestId('civic-tabs')).toHaveCount(0);
    await page.getByTestId('admin-more').click();
    await expect(page.getByTestId('civic-tabs')).toBeVisible();
    await expect(page.getByTestId('admin-survey-home')).toHaveCount(0);
  });

  test('@E2E-217 tabs work from the keyboard and read in Telugu', async ({ page }) => {
    await openCivic(page, 'te');
    await page.getByTestId('demo-resident_verified').click();
    await expect(page.getByTestId('civic-signed-in')).toBeVisible();
    await page.getByTestId('civic-tab-report').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('civic-tab-mine')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('civic-tab-mine')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId('civic-tab-roles')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight'); // wraps to the first tab
    await expect(page.getByTestId('civic-tab-report')).toHaveAttribute('aria-selected', 'true');
    for (const t of TABS) await expect(page.getByTestId(`civic-tab-${t}`)).toContainText(/[ఀ-౿]/);
  });

  test('@E2E-217 the Sign in button in the top bar opens the Civic page, and shows Log out once signed in (desktop and phone width)', async ({ page }) => {
    for (const size of [{ width: 1280, height: 800 }, { width: 375, height: 800 }]) {
      await page.setViewportSize(size);
      await page.goto('/?state=AP');
      const signIn = page.getByTestId(size.width > 1000 ? 'sign-in' : 'sign-in-mobile');
      await expect(signIn).toBeVisible();
      const box = (await signIn.boundingBox())!;
      expect(box.x + box.width, 'in the right half of the bar').toBeGreaterThan(size.width / 2);
      expect(box.y).toBeLessThan(80); // in the top bar
      await signIn.click();
      await expect(page.getByTestId('civic-home')).toBeVisible();
      await page.getByTestId('demo-resident_verified').click();
      await expect(page.getByTestId('civic-signed-in')).toBeVisible();
      const out = page.getByTestId(size.width > 1000 ? 'sign-out' : 'sign-out-mobile');
      await expect(out).toBeVisible();
      await out.click();
      await expect(page.getByTestId('demo-personas')).toBeVisible();
      await expect(signIn).toBeVisible();
    }
  });
});
