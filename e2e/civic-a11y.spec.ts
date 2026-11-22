import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { completeSignUpFromConsent, openCivic, openCivicSignedIn, randomPhone } from './civic-helpers';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).include('[data-testid=civic-home]').withTags(TAGS).analyze();
  return r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

async function assertTouchTargets(page: Page) {
  const small = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('[data-testid=civic-home] button, [data-testid=civic-home] input:not([type=hidden]), [data-testid=civic-home] select, [data-testid=civic-home] textarea').forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const isCheck = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
      const min = isCheck ? 24 : 44; // WCAG 2.2 AA minimum is 24px; 44px for primary controls
      if (r.width < min - 0.5 || r.height < min - 0.5) out.push(`${el.tagName}[${el.getAttribute('data-testid') ?? ''}] ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    return out;
  });
  expect(small, `controls below the minimum touch target: ${small.join(', ')}`).toEqual([]);
}

for (const lang of ['en', 'te'] as const) {
  test.describe(`civic accessibility (${lang})`, () => {
    test(`@E2E-57 axe: no critical or serious violations on civic screens (${lang})`, async ({ page, request }) => {
      await openCivic(page, lang);
      expect(await axe(page), 'landing').toEqual([]);
      await page.getByTestId('civic-login-btn').click();
      await expect(page.getByTestId('login-flow')).toBeVisible();
      expect(await axe(page), 'login').toEqual([]);
      await openCivic(page, lang);
      await page.getByTestId('civic-signup-btn').click();
      await expect(page.getByTestId('consent-notice')).toBeVisible();
      expect(await axe(page), 'consent').toEqual([]);
      await page.getByTestId('consent-notice-check').check();
      await page.getByTestId('consent-notice-accept').click();
      expect(await axe(page), 'phone step').toEqual([]);
      await openCivicSignedIn(page, request, lang);
      await expect(page.getByTestId('issue-report')).toBeVisible();
      expect(await axe(page), 'signed-in home with household, report and feed').toEqual([]);
    });

    test(`@E2E-57 touch targets, Telugu labels, no horizontal scroll (${lang})`, async ({ page, request }) => {
      await openCivic(page, lang);
      await assertTouchTargets(page);
      await page.getByTestId('civic-signup-btn').click();
      await expect(page.getByTestId('consent-notice')).toBeVisible();
      await assertTouchTargets(page);
      await openCivicSignedIn(page, request, lang);
      await assertTouchTargets(page);
      if (lang === 'te') {
        for (const id of ['ir-text', 'ir-village']) {
          const name = await page.getByTestId(id).evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? '');
          expect(name).toMatch(/[ఀ-౿]/);
        }
        expect(await page.locator('html').getAttribute('lang')).toBe('te');
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  });
}

test('@E2E-57 keyboard: sign-up and the report form work without a mouse', async ({ page }) => {
  await openCivic(page);
  await page.getByTestId('civic-signup-btn').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('consent-notice')).toBeVisible();
  await page.getByTestId('consent-notice-check').focus();
  await page.keyboard.press('Space');
  await page.getByTestId('consent-notice-accept').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('su-phone')).toBeVisible();
  await page.getByTestId('su-phone').focus();
  await page.keyboard.type(randomPhone());
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('su-send-otp')).toBeFocused();
  await page.keyboard.press('Enter');
  const otp = ((await page.getByTestId('dev-otp').textContent()) ?? '').match(/(\d{6})/)![1];
  await page.getByTestId('su-otp').focus();
  await page.keyboard.type(otp);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.getByTestId('su-pin').focus();
  await page.keyboard.type('4821');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('civic-signed-in')).toBeVisible();
  // Report form by keyboard only: category, text, village (arrow-free: type, Tab to the option, Enter), then submit.
  await page.getByTestId('cat-roads').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('ir-text')).toBeFocused();
  await page.keyboard.type('Road is broken near the temple');
  await page.getByTestId('ir-village').focus();
  await page.keyboard.type('Kolluru');
  await expect(page.getByTestId('village-option').first()).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('village-option').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByTestId('ir-village').focus();
  let reached = false;
  for (let i = 0; i < 20 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.getByTestId('ir-submit').evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
});

/** Touch-target check scoped to one screen (the signed-in page also holds other teams' forms). */
async function assertTouchTargetsIn(page: Page, testId: string) {
  const small = await page.evaluate((id) => {
    const out: string[] = [];
    document.querySelectorAll(`[data-testid="${id}"] button, [data-testid="${id}"] input:not([type=hidden]), [data-testid="${id}"] select`).forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const isCheck = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
      if (r.width && r.height && (r.width < (isCheck ? 24 : 44) - 0.5 || r.height < (isCheck ? 24 : 44) - 0.5)) out.push(`${el.tagName}[${el.getAttribute('data-testid') ?? ''}] ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    return out;
  }, testId);
  expect(small, `small targets in ${testId}: ${small.join(', ')}`).toEqual([]);
}

for (const lang of ['en', 'te'] as const) {
  test(`@E2E-57 @E2E-163 axe and touch targets on identity screens: picker, recovery, residence, invite, volunteer (${lang})`, async ({ page, request }) => {
    const members = [{ person_id: 'a', label: 'Asha', locked: false }, { person_id: 'b', label: 'RK', locked: true }];
    await page.route('**/identity/login', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'person_required', members }) }));
    await openCivic(page, lang);
    await page.getByTestId('civic-login-btn').click();
    await page.getByTestId('li-phone').fill('9876543210');
    await page.getByTestId('li-pin').fill('4821');
    await page.getByTestId('li-submit').click();
    await expect(page.getByTestId('li-picker')).toBeVisible();
    expect(await axe(page), 'login picker').toEqual([]);
    await assertTouchTargets(page);
    await page.getByTestId('li-forgot').click();
    await expect(page.getByTestId('recover-flow')).toBeVisible();
    expect(await axe(page), 'recovery').toEqual([]);
    await assertTouchTargets(page);
    await openCivicSignedIn(page, request, lang);
    await expect(page.getByTestId('tier-badge')).toBeVisible();
    if (await page.getByTestId('res-change').isVisible()) await page.getByTestId('res-change').click();
    await expect(page.getByTestId('residence-flow')).toBeVisible();
    expect(await axe(page), 'tier badge and residence').toEqual([]);
    await assertTouchTargetsIn(page, 'residence-flow');
    await page.goto('/?invite=bogus-code');
    await expect(page.getByTestId('inv-gone')).toBeVisible();
    expect(await axe(page), 'invite not found').toEqual([]);
    const vol = await request.post('/api/v1/civic/e2e/person', { data: { roles: [{ role: 'volunteer' }] } });
    const volToken = (await vol.json()).token as string;
    await page.addInitScript((t) => { try { sessionStorage.setItem('civic-token', t); } catch { /* ignore */ } }, volToken);
    await openCivic(page, lang);
    await expect(page.getByTestId('civic-signed-in')).toBeVisible();
    await expect(page.getByTestId('attestation')).toBeVisible();
    expect(await axe(page), 'volunteer screen').toEqual([]);
    await assertTouchTargetsIn(page, 'attestation');
  });
}
