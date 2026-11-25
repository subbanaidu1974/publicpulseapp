import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API, bearer } from './civic-seed';
import { openCivic } from './civic-helpers';

/**
 * Recorded end-to-end journey for broadcast polls (S-185, S-186): one browser context for the ADMIN and one for the USER, each recorded to its own
 * video (1280x720 .webm) in test-results/videos/broadcast-poll/. Run it with:  npm run e2e:poll-videos
 * The two videos tell one story: admin writes and pushes a poll -> user is blocked, answers -> user reaches the app -> admin sees the response and
 * closes the poll. Short pauses ("beats") are added so a person watching can follow; they are not needed for the assertions.
 */
const OUT = path.resolve('test-results', 'videos', 'broadcast-poll');
const B = `${API}/broadcast`;
const SIZE = { width: 1280, height: 720 };
test.describe.configure({ mode: 'serial' });

const beat = (page: Page, ms = 900) => page.waitForTimeout(ms);
async function recorded(browser: Browser, name: string): Promise<{ ctx: BrowserContext; page: Page; save: () => Promise<string> }> {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, `.tmp-${name}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: tmp, size: SIZE } });
  const page = await ctx.newPage();
  return {
    ctx, page,
    save: async () => {
      const v = page.video();
      await ctx.close(); // the file is finalised when the context closes
      const dest = path.join(OUT, `${name}.webm`);
      if (v) await v.saveAs(dest);
      fs.rmSync(tmp, { recursive: true, force: true });
      return dest;
    },
  };
}
async function adminToken(page: Page): Promise<string> {
  return (await (await page.request.post(`${API}/demo/login`, { data: { persona: 'admin' } })).json()).token as string;
}
async function closeAllPolls(page: Page) {
  const t = await adminToken(page);
  const l = await (await page.request.get(`${B}/admin`, { headers: bearer(t) })).json();
  for (const p of l.polls ?? []) if (p.status === 'open' || p.status === 'scheduled') await page.request.post(`${B}/admin/${p.id}/close`, { headers: bearer(t) });
}

test.describe('broadcast poll: admin and user journey, recorded (S-185, S-186)', () => {
  test.skip(({ isMobile }) => isMobile, 'recorded at desktop size only');

  test('@E2E-202 admin pushes a poll, the user is blocked until answering and then uses the app, the admin sees the response and closes it', async ({ browser }) => {
    test.setTimeout(120_000);
    const admin = await recorded(browser, 'admin-pushes-poll');
    const user = await recorded(browser, 'user-answers-poll');
    const videos: string[] = [];
    try {
      await closeAllPolls(admin.page);

      // ---- ADMIN: sign in as the demo admin and write the poll ---------------------------------------------------------------------------
      const A = admin.page;
      await openCivic(A); await beat(A);
      await A.getByTestId('demo-admin').click();
      await expect(A.getByTestId('civic-signed-in')).toBeVisible(); await beat(A);
      await A.getByTestId('console-tab-admin').click(); await beat(A);
      await A.getByTestId('polls-admin-link').click();
      await expect(A.getByTestId('polls-admin')).toBeVisible(); await beat(A);
      await A.getByTestId('pa-title').fill('Drinking water in your village');
      await A.getByTestId('pa-title-te').fill('మీ గ్రామంలో తాగునీరు');
      await A.getByTestId('pa-intro').fill('Two quick questions to help us understand local needs.');
      await A.getByTestId('pa-text-0').fill('How reliable is your drinking water supply?');
      await A.getByTestId('pa-options-0').fill('Reliable | నమ్మదగినది\nSometimes interrupted | అప్పుడప్పుడు ఆగుతుంది\nNot reliable | నమ్మదగినది కాదు');
      await beat(A);
      await A.getByTestId('pa-add-q').click();
      await A.getByTestId('pa-kind-1').selectOption('multi');
      await A.getByTestId('pa-text-1').fill('Which services most need work in your area?');
      await A.getByTestId('pa-options-1').fill('Roads\nWater\nPower\nHealth centre');
      await expect(A.getByTestId('pa-max-0')).toHaveCount(0); // the limit only applies to choose-several questions
      await A.getByTestId('pa-max-1').fill('2');
      await beat(A, 1500);
      await expect(A.getByTestId('pa-publish')).toBeDisabled(); // pushing needs the admin's explicit confirmation
      await A.getByTestId('pa-confirm').check(); await beat(A);
      await A.getByTestId('pa-publish').click();
      await expect(A.getByTestId('pa-msg')).toContainText('Poll opened');
      const item = A.getByTestId('pa-item').first();
      await expect(item).toHaveAttribute('data-status', 'open');
      await expect(A.getByTestId('poll-dialog')).toHaveCount(0); // the admin is never blocked
      await beat(A, 1500);

      // ---- USER: a registered person (email account) opens the app and is blocked ---------------------------------------------------------
      const U = user.page;
      const email = `journey.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.org`;
      const otp = (await (await U.request.post(`${API}/identity/signup/email/request`, { data: { email } })).json()).dev_otp as string;
      const token = (await (await U.request.post(`${API}/identity/signup/email/verify`, { data: { email, otp, pin: '4821', consent_version: 'v1' } })).json()).token as string;
      await U.addInitScript((t) => { try { sessionStorage.setItem('civic-token', t); localStorage.setItem('pp-lang', 'en'); } catch { /* ignore */ } }, token);
      await U.goto('/');
      const dlg = U.getByTestId('poll-dialog');
      await expect(dlg).toBeVisible();
      await expect(U.getByTestId('poll-title')).toHaveText('Drinking water in your village');
      await beat(U, 1800);
      await U.keyboard.press('Escape'); await beat(U);
      await expect(dlg).toBeVisible(); // it cannot be dismissed
      expect(await U.evaluate(() => !!document.querySelector('[inert] main'))).toBe(true); // the app behind it is inert
      await expect(U.getByTestId('poll-submit')).toBeDisabled();

      // answer question 1 only: still blocked
      await U.getByTestId('poll-opt-0-1').check(); await beat(U);
      await expect(U.getByTestId('poll-progress')).toContainText('1 of 2');
      await expect(U.getByTestId('poll-submit')).toBeDisabled();
      // question 2 allows up to two choices; "Prefer not to say" replaces them, and picking a real option again clears it
      await U.getByTestId('poll-opt-1-1').check(); await U.getByTestId('poll-opt-1-2').check(); await beat(U);
      await expect(U.getByTestId('poll-q-1')).toContainText('up to 2');
      await U.getByTestId('poll-opt-1-3').click({ force: true }); await beat(U); // a third pick is refused
      await expect(U.getByTestId('poll-opt-1-3')).not.toBeChecked();
      await U.getByTestId('poll-opt-1-4').check(); await beat(U);
      await expect(U.getByTestId('poll-opt-1-1')).not.toBeChecked();
      await U.getByTestId('poll-opt-1-1').check(); await U.getByTestId('poll-opt-1-2').check(); await beat(U);
      await expect(U.getByTestId('poll-opt-1-4')).not.toBeChecked();
      await expect(U.getByTestId('poll-progress')).toContainText('2 of 2');
      await expect(U.getByTestId('poll-submit')).toBeEnabled(); await beat(U, 1200);
      await U.getByTestId('poll-submit').click();

      // ---- USER: released, uses the app, and is not asked again ---------------------------------------------------------------------------
      await expect(dlg).toHaveCount(0);
      expect(await U.evaluate(() => !!document.querySelector('[inert]'))).toBe(false);
      await beat(U);
      let nav = U.getByTestId('nav-civic');
      if (!(await nav.isVisible())) { await U.getByTestId('nav-menu').click().catch(() => undefined); nav = U.getByTestId('nav-civic'); }
      await nav.click();
      await expect(U.getByTestId('civic-signed-in')).toBeVisible(); await beat(U, 1500);
      await U.reload();
      await expect(U.getByTestId('civic-signed-in').or(U.locator('main'))).toBeVisible();
      await expect(U.getByTestId('poll-dialog')).toHaveCount(0); await beat(U, 1200);

      // ---- ADMIN: sees the response and closes the poll -----------------------------------------------------------------------------------
      await A.getByTestId('pa-back').click().catch(() => undefined);
      await A.goto('/#/polls-admin');
      await expect(A.getByTestId('polls-admin')).toBeVisible();
      await expect(A.getByTestId('pa-item').first()).toContainText('1 answered');
      await A.getByTestId('pa-results').first().click();
      await expect(A.getByTestId('pa-suppressed')).toBeVisible(); // too few answers to show counts
      await beat(A, 1800);
      await A.getByTestId('pa-close').first().click();
      await expect(A.getByTestId('pa-item').first()).toHaveAttribute('data-status', 'closed'); await beat(A, 1500);
    } finally {
      await closeAllPolls(admin.page).catch(() => undefined);
      videos.push(await admin.save(), await user.save());
    }
    for (const v of videos) expect(fs.statSync(v).size).toBeGreaterThan(10_000);
    console.log('videos:\n  ' + videos.join('\n  '));
  });
});
