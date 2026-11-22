import { test, expect } from '@playwright/test';
import { openHome, openElections } from './helpers';

test.describe('i18n completeness, metadata and error localisation', () => {
  test('@E2E-141 an API error code renders in Telugu, never the raw English server string', async ({ page }) => {
    await page.route('**/api/v1/elections/*/summary*', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: "No assembly election data for AP in 2099 RAW-SERVER-TEXT", code: 'no_data' }) }));
    await openElections(page, 'AP');
    const banner = page.getByTestId('error-banner').first();
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('No data is available for this selection');
    await expect(banner).not.toContainText('RAW-SERVER-TEXT');
    await page.getByRole('button', { name: 'తెలుగు' }).first().click();
    await expect(banner).toContainText('ఈ ఎంపికకు డేటా అందుబాటులో లేదు');
    await expect(banner).not.toContainText('RAW-SERVER-TEXT');
  });

  test('@E2E-141 a network failure shows a localised message', async ({ page }) => {
    await page.route('**/api/v1/elections/*/summary*', (route) => route.abort());
    await openElections(page, 'TG');
    await page.getByRole('button', { name: 'తెలుగు' }).first().click();
    await expect(page.getByTestId('error-banner').first()).toContainText('డేటా సేవను చేరుకోలేకపోయాము');
  });

  test('@E2E-141 constituency labels and the data-status table are translated', async ({ page }) => {
    await openHome(page, 'AP');
    await page.getByRole('button', { name: 'తెలుగు' }).first().click();
    await page.getByTestId('footer-link-methodology').scrollIntoViewIfNeeded();
    await page.getByTestId('footer-link-methodology').click();
    const status = page.getByTestId('data-status-public');
    await expect(status).toContainText('డేటా స్థితి');
    await expect(status.locator('thead')).toContainText('వరుసలు');
    await expect(status.locator('thead')).not.toContainText(/Rows|Source|Provenance/);
  });

  test('@E2E-141 Telugu FAQ and methodology body text with the review note', async ({ page }) => {
    await openHome(page, 'AP');
    await page.getByRole('button', { name: 'తెలుగు' }).first().click();
    await page.getByTestId('footer-link-methodology').scrollIntoViewIfNeeded();
    await page.getByTestId('footer-link-methodology').click();
    await expect(page.getByText('జనగణన సందర్భం').first()).toBeVisible();
    await expect(page.getByTestId('translation-review-note')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('pp-nav', { detail: 'faq' })));
    await expect(page.getByText('ఎన్నికల సంఖ్యలు ఎక్కడి నుంచి వస్తాయి?')).toBeVisible();
    await expect(page.getByTestId('translation-review-note')).toBeVisible();
  });

  test('@E2E-142 document title, description, Open Graph and hreflang follow the language', async ({ page }) => {
    await openHome(page, 'AP');
    await expect(page).toHaveTitle(/People Pulse/);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /People Pulse/);
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'en_IN');
    await expect(page.locator('link[rel="alternate"][hreflang="te"]')).toHaveCount(1);
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveCount(1);
    await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(1);
    expect(await page.locator('link[rel="alternate"][hreflang="te"]').getAttribute('href')).toMatch(/^http.*\?lang=te$/);
    await page.getByRole('button', { name: 'తెలుగు' }).first().click();
    await expect(page).toHaveTitle(/పీపుల్ పల్స్/);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /ఆంధ్ర ప్రదేశ్/);
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'te_IN');
    await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute('content', /పీపుల్ పల్స్/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'te');
  });

  test('@E2E-142 an hreflang link (?lang=te) opens the Telugu page directly', async ({ page }) => {
    await page.goto('/?state=AP&lang=te');
    await expect(page.locator('html')).toHaveAttribute('lang', 'te');
    await expect(page).toHaveTitle(/పీపుల్ పల్స్/);
  });
});
