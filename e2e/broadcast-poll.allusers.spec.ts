import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API, bearer } from './civic-seed';
import { openCivic } from './civic-helpers';

/**
 * Recorded journey (S-223): the demo ADMIN publishes a survey (a broadcast poll) and it reaches every other demo user.
 * Admin context  -> admin-publishes-survey.webm
 * Users context  -> every-user-must-answer.webm   (Resident, Volunteer, Government officer, Journalist, one after another, through the real sign-in screen)
 * For each user: the survey pops up over the whole app, it cannot be dismissed, Submit stays off until the question is answered, and after submitting
 * the person reaches the app and is not asked again. The admin is never blocked. The admin then sees 4 answers and closes the survey.
 * Run it with:  npm run e2e:poll-all-videos   (one worker: an open poll blocks signed-in sessions in other specs).
 */
const OUT = path.resolve('test-results', 'videos', 'broadcast-poll-all-users');
const B = `${API}/broadcast`;
const SIZE = { width: 1280, height: 720 };
const USERS = [
  { key: 'resident_verified', name: 'Resident' },
  { key: 'volunteer', name: 'Volunteer' },
  { key: 'officer', name: 'Government officer' },
  { key: 'journalist', name: 'Journalist' },
] as const;
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
      await ctx.close();
      const dest = path.join(OUT, `${name}.webm`);
      if (v) await v.saveAs(dest);
      fs.rmSync(tmp, { recursive: true, force: true });
      return dest;
    },
  };
}
async function closeAllPolls(page: Page) {
  const t = (await (await page.request.post(`${API}/demo/login`, { data: { persona: 'admin' } })).json()).token as string;
  const l = await (await page.request.get(`${B}/admin`, { headers: bearer(t) })).json();
  for (const p of l.polls ?? []) if (p.status === 'open' || p.status === 'scheduled') await page.request.post(`${B}/admin/${p.id}/close`, { headers: bearer(t) });
}

test.describe('admin publishes a survey and every other user must answer it, recorded (S-223)', () => {
  test.skip(({ isMobile }) => isMobile, 'recorded at desktop size only');

  test('@E2E-216 the survey pops up for the resident, volunteer, officer and journalist, cannot be dismissed, must be answered, and the admin is never blocked', async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await recorded(browser, 'admin-publishes-survey');
    const users = await recorded(browser, 'every-user-must-answer');
    const videos: string[] = [];
    try {
      await closeAllPolls(admin.page);

      // ---- ADMIN: signs in with one click and publishes a survey -------------------------------------------------------------------------
      const A = admin.page;
      await openCivic(A); await beat(A);
      await A.getByTestId('demo-admin').click();
      await expect(A.getByTestId('civic-signed-in')).toBeVisible(); await beat(A);
      await expect(A.getByTestId('admin-survey-home')).toBeVisible(); // the admin lands straight on the survey page, with no tabs
      await expect(A.getByTestId('civic-tabs')).toHaveCount(0);
      await expect(A.getByTestId('polls-admin')).toBeVisible(); await beat(A);
      await A.getByTestId('pa-title').fill('Your village: one quick survey');
      await A.getByTestId('pa-intro').fill('Everyone signed in answers this once. Your answer is counted but not linked to your name.');
      await A.getByTestId('pa-text-0').fill('How reliable is your drinking water supply?');
      await A.getByTestId('pa-options-0').fill('Reliable\nSometimes interrupted\nNot reliable');
      await beat(A, 1500);
      await A.getByTestId('pa-confirm').check(); await beat(A);
      await A.getByTestId('pa-publish').click();
      await expect(A.getByTestId('pa-msg')).toContainText('Poll opened');
      await expect(A.getByTestId('pa-item').first()).toHaveAttribute('data-status', 'open');
      await expect(A.getByTestId('poll-dialog')).toHaveCount(0); // the admin is never blocked
      await beat(A, 1500);

      // ---- USERS: one after another through the real demo sign-in screen ------------------------------------------------------------------
      const U = users.page;
      await openCivic(U); await beat(U);
      await expect(U.getByTestId('poll-dialog')).toHaveCount(0); // nobody is signed in yet, so nothing blocks the sign-in screen
      for (const [i, who] of USERS.entries()) {
        await U.getByTestId(`demo-${who.key}`).click();
        const dlg = U.getByTestId('poll-dialog');
        await expect(dlg, `${who.name} sees the survey`).toBeVisible({ timeout: 15_000 });
        await expect(U.getByTestId('poll-title')).toHaveText('Your village: one quick survey');
        await beat(U, 1400);
        await U.keyboard.press('Escape'); await beat(U, 500);
        await expect(dlg, `${who.name} cannot dismiss it`).toBeVisible();
        expect(await U.evaluate(() => !!document.querySelector('[inert] main'))).toBe(true); // the app behind it is inert
        await expect(U.getByTestId('poll-submit')).toBeDisabled(); // not answered yet
        await U.getByTestId(`poll-opt-0-${(i % 3) + 1}`).check(); await beat(U, 800);
        await expect(U.getByTestId('poll-submit')).toBeEnabled();
        await U.getByTestId('poll-submit').click();
        await expect(dlg).toHaveCount(0); // released
        expect(await U.evaluate(() => !!document.querySelector('[inert]'))).toBe(false);
        await beat(U, 900);
        await U.getByTestId('civic-tab-mine').click(); await beat(U, 700); // the person can now use the app
        await U.getByTestId('civic-tab-report').click(); await beat(U, 700);
        await U.reload();
        await U.getByTestId('nav-civic').click();
        await expect(U.getByTestId('civic-signed-in')).toBeVisible();
        await expect(U.getByTestId('poll-dialog')).toHaveCount(0); // not asked again after answering
        await U.getByTestId('sign-out').click(); // Log out in the top bar
        await expect(U.getByTestId('demo-personas')).toBeVisible(); await beat(U, 700);
      }

      // ---- ADMIN: sees all four answers and closes the survey -----------------------------------------------------------------------------
      await A.goto('/#/polls-admin');
      await expect(A.getByTestId('polls-admin')).toBeVisible();
      await expect(A.getByTestId('pa-item').first()).toContainText('4 answered');
      await A.getByTestId('pa-results').first().click();
      await expect(A.getByTestId('pa-suppressed')).toBeVisible(); // under 10 answers: no counts shown
      await beat(A, 1800);
      await A.getByTestId('pa-close').first().click();
      await expect(A.getByTestId('pa-item').first()).toHaveAttribute('data-status', 'closed'); await beat(A, 1500);
    } finally {
      await closeAllPolls(admin.page).catch(() => undefined);
      videos.push(await admin.save(), await users.save());
    }
    for (const v of videos) expect(fs.statSync(v).size).toBeGreaterThan(10_000);
    console.log('videos:\n  ' + videos.join('\n  '));
  });
});
