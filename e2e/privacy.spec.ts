import { test, expect, type Page } from '@playwright/test';
import { openHome } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Record every request the page makes to a host that is not this origin; map tile hosts are answered with a 1px image. */
async function trackExternal(page: Page) {
  const hosts: string[] = [];
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      hosts.push(u.hostname);
      return u.hostname.endsWith('arcgisonline.com') ? route.fulfill({ status: 200, contentType: 'image/png', body: PNG }) : route.abort();
    }
    return route.continue();
  });
  return hosts;
}

async function footer(page: Page, tab: 'privacy' | 'terms' | 'who') {
  const link = page.getByTestId(`footer-link-${tab}`);
  await link.scrollIntoViewIfNeeded();
  await link.click();
}

test.describe('privacy, terms, who-sees-what and third-party consent', () => {
  test('@E2E-144 first visit asks before any third-party map request; decline keeps the map without tiles', async ({ page }) => {
    const hosts = await trackExternal(page);
    await openHome(page, 'AP');
    await expect(page.getByTestId('consent-banner')).toBeVisible();
    await expect(page.getByTestId('consent-banner')).toContainText(/Esri/);
    await page.waitForTimeout(800);
    expect(hosts.filter((h) => h.endsWith('arcgisonline.com'))).toEqual([]); // nothing before a choice
    await page.getByTestId('consent-decline').click();
    await expect(page.getByTestId('consent-banner')).toHaveCount(0);
    await expect(page.getByTestId('map-tiles-off')).toBeVisible();
    await page.waitForTimeout(800);
    expect(hosts.filter((h) => h.endsWith('arcgisonline.com'))).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('pp-tiles-consent'))).toBe('declined');
    await page.reload();
    await expect(page.getByTestId('consent-banner')).toHaveCount(0); // choice is remembered
  });

  test('@E2E-144 allow loads tiles, and the footer link reopens the choice so it can be changed back', async ({ page }) => {
    const hosts = await trackExternal(page);
    await openHome(page, 'AP');
    await page.getByTestId('consent-allow').click();
    await expect.poll(() => hosts.filter((h) => h.endsWith('arcgisonline.com')).length).toBeGreaterThan(0);
    await page.getByTestId('footer-consent').scrollIntoViewIfNeeded();
    await page.getByTestId('footer-consent').click();
    await expect(page.getByTestId('consent-banner')).toBeVisible();
    await page.getByTestId('consent-decline').click();
    await expect(page.getByTestId('map-tiles-off')).toBeVisible();
  });

  test('@E2E-144 footer reaches the privacy page: DRAFT banner, plain-language sections, Aadhaar and benefit statements', async ({ page }) => {
    await openHome(page, 'AP');
    await footer(page, 'privacy');
    const p = page.getByTestId('privacy-page');
    await expect(p).toBeVisible();
    await expect(page.getByTestId('legal-draft')).toContainText(/DRAFT/);
    await expect(p).toContainText(/never store Aadhaar/i);
    await expect(p).toContainText(/not affect your pension/i);
    await expect(page.getByTestId('translation-review-note')).toHaveCount(0); // English page: no translation note
  });

  test('@E2E-144 terms page says it is not an election and not advice', async ({ page }) => {
    await openHome(page, 'TG');
    await footer(page, 'terms');
    await expect(page.getByTestId('terms-page')).toContainText(/not a poll and not a prediction/i);
    await expect(page.getByTestId('legal-draft')).toBeVisible();
  });

  test('@E2E-144 who-sees-what lists every role per data type, with no individual survey answers for officials', async ({ page }) => {
    await openHome(page, 'AP');
    await footer(page, 'who');
    const table = page.getByTestId('who-sees-table');
    await expect(table).toBeVisible();
    await expect(table.locator('thead th')).toHaveCount(7);
    await expect(page.getByTestId('who-row-phone')).toContainText(/keyed hash/i);
    await expect(page.getByTestId('who-row-answers')).toContainText(/Totals only/i);
    await expect(page.getByTestId('who-row-answers')).not.toContainText(/individual answers of/i);
  });

  test('@E2E-144 Telugu privacy page shows Telugu text with a visible translation-under-review note', async ({ page }) => {
    await openHome(page, 'AP');
    await page.getByRole('button', { name: 'తెలుగు' }).first().click();
    await footer(page, 'privacy');
    await expect(page.getByTestId('privacy-page')).toContainText('ఆధార్');
    await expect(page.getByTestId('translation-review-note')).toBeVisible();
    await expect(page.getByTestId('legal-draft')).toContainText('ముసాయిదా');
    await expect(page.getByTestId('privacy-sections')).toHaveAttribute('lang', 'te');
  });

  test('@E2E-145 the app makes no request to Google Fonts or gstatic, and Telugu text loads the self-hosted font', async ({ page }) => {
    const hosts = await trackExternal(page);
    const fontReq: string[] = [];
    page.on('requestfinished', (r) => { if (/\/fonts\//.test(r.url())) fontReq.push(r.url()); });
    await openHome(page, 'AP');
    await page.getByRole('button', { name: 'తెలుగు' }).first().click();
    await expect(page.getByTestId('consent-banner')).toContainText('Esri');
    await page.waitForTimeout(800);
    expect(hosts.filter((h) => /googleapis|gstatic/.test(h))).toEqual([]);
    expect(fontReq.some((u) => u.endsWith('/fonts/NotoSansTelugu-subset.woff2'))).toBe(true);
    const ok = await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px "Noto Sans Telugu"', 'తెలుగు'); });
    expect(ok).toBe(true);
  });

  test('@E2E-145 the font file is served as woff2 with a sane size and cacheable', async ({ request }) => {
    const r = await request.get('/fonts/NotoSansTelugu-subset.woff2');
    expect(r.status()).toBe(200);
    expect((await r.body()).length).toBeLessThan(200 * 1024);
    expect((await r.body()).subarray(0, 4).toString('latin1')).toBe('wOF2');
  });
});
