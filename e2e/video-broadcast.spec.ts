import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API, bearer, openCivicAs, seedPerson } from './civic-seed';
import { openCivic } from './civic-helpers';

/**
 * Recorded journey (S-230, S-231): an admin proposes a video, a DIFFERENT admin approves it, and every signed-in member then sees it in the Media tab.
 * Admin context -> admin-sends-video.webm   (admin A proposes; cannot approve their own; admin B approves; A later recalls it)
 * Users context -> members-see-video.webm   (Resident, Volunteer, Government officer, Journalist: nothing before approval, then a badge and a card, a play, not blocked)
 * Run it with:  npm run e2e:video-videos
 */
const OUT = path.resolve('test-results', 'videos', 'video-broadcast');
const SIZE = { width: 1280, height: 720 };
const MEDIA = 'https://media.example.org/briefing.wav';
const MEMBERS = [
  { key: 'resident_verified', name: 'Resident' },
  { key: 'volunteer', name: 'Volunteer' },
  { key: 'officer', name: 'Government officer' },
  { key: 'journalist', name: 'Journalist' },
] as const;
test.describe.configure({ mode: 'serial' });

function wav(seconds = 3): Buffer {
  const rate = 8000, n = rate * seconds, data = Buffer.alloc(n);
  for (let i = 0; i < n; i++) data[i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 330 * i) / rate));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, data]);
}
const serveMedia = (ctx: BrowserContext) => ctx.route(MEDIA, (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: wav() }));
const beat = (page: Page, ms = 900) => page.waitForTimeout(ms);

async function recorded(browser: Browser, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, `.tmp-${name}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: tmp, size: SIZE } });
  await serveMedia(ctx);
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
  const l = await (await page.request.get(`${API}/broadcast/admin`, { headers: bearer(t) })).json();
  for (const p of l.polls ?? []) if (p.status === 'open' || p.status === 'scheduled') await page.request.post(`${API}/broadcast/admin/${p.id}/close`, { headers: bearer(t) });
}

test.describe('an admin sends a video, a second admin approves, every member sees it, recorded (S-230, S-231)', () => {
  test.skip(({ isMobile }) => isMobile, 'recorded at desktop size only');

  test('@E2E-222 nothing reaches members before a different admin approves; then every member sees it, it never blocks the app, and a recall removes it', async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await recorded(browser, 'admin-sends-video');
    const users = await recorded(browser, 'members-see-video');
    const second = await browser.newContext({ viewport: SIZE });
    const videos: string[] = [];
    try {
      const A = admin.page, U = users.page;
      await closeAllPolls(A); // an open poll would block the member sessions
      const title = `Reading your result ${Date.now() % 100000}`;

      // ---- ADMIN A: signs in with one click, opens the video screen from the admin landing page and proposes a video ----------------------
      await openCivic(A); await beat(A);
      await A.getByTestId('demo-admin').click();
      await expect(A.getByTestId('admin-survey-home')).toBeVisible(); await beat(A);
      await A.getByTestId('videos-admin-link-home').click();
      await expect(A.getByTestId('videos-admin')).toBeVisible(); await beat(A);
      await expect(A.getByTestId('va-propose')).toBeDisabled(); // both safety ticks are required
      await A.getByTestId('va-title').fill(title);
      await A.getByTestId('va-note').fill('A two minute explainer on how to read an election result.');
      await A.getByTestId('va-url').fill(MEDIA);
      await A.getByTestId('va-credit').fill('People Pulse, own work, 2026');
      await beat(A, 1200);
      await A.getByTestId('va-neutral').check(); await A.getByTestId('va-rights').check(); await beat(A);
      await A.getByTestId('va-propose').click();
      await expect(A.getByTestId('va-msg')).toContainText('different admin must approve');
      const item = A.getByTestId('va-item').filter({ hasText: title });
      await expect(item).toHaveAttribute('data-status', 'pending');
      await expect(item.getByTestId('va-approve')).toBeDisabled(); // admin A cannot approve their own proposal
      await beat(A, 1500);

      // ---- MEMBERS (first one): signs in while the video is still waiting for approval: nothing to see -----------------------------------
      await openCivic(U); await beat(U);
      await U.getByTestId('demo-resident_verified').click();
      await expect(U.getByTestId('civic-signed-in')).toBeVisible();
      await expect(U.getByTestId('nav-media')).toHaveText('Media'); // no badge
      await U.getByTestId('nav-media').click();
      await U.getByTestId('media-tab-ours').click();
      await expect(U.getByTestId('media-ours-empty')).toBeVisible(); await beat(U, 1200);
      await U.getByTestId('sign-out').click();

      // ---- ADMIN B: a different admin reviews and approves ---------------------------------------------------------------------------------
      const b = await seedPerson(second.request, [{ role: 'admin' }]);
      const B = await second.newPage();
      await openCivicAs(B, b.token);
      await B.goto('/#/videos-admin');
      const itemB = B.getByTestId('va-item').filter({ hasText: title });
      await expect(itemB).toHaveAttribute('data-status', 'pending');
      await expect(itemB.getByTestId('va-approve')).toBeEnabled();
      await itemB.getByTestId('va-approve').click();
      await expect(B.getByTestId('va-msg')).toContainText('Approved');
      await expect(itemB).toHaveAttribute('data-status', 'live');
      await A.reload(); await beat(A, 1200); // admin A sees it live too
      await expect(A.getByTestId('va-item').filter({ hasText: title })).toHaveAttribute('data-status', 'live'); await beat(A, 1500);

      // ---- EVERY MEMBER: signs in through the real screen, sees a badge on Media, a New card, plays it, is never blocked --------------------
      for (const who of MEMBERS) {
        await U.goto('/'); await U.evaluate(() => { try { localStorage.removeItem('pp-video-seen'); sessionStorage.removeItem('pp-media-tab'); } catch { /* ignore */ } });
        await openCivic(U);
        await U.getByTestId(`demo-${who.key}`).click();
        await expect(U.getByTestId('civic-signed-in'), `${who.name} signed in`).toBeVisible();
        await expect(U.getByTestId('poll-dialog')).toHaveCount(0); // a video never blocks the app
        await expect(U.getByTestId('nav-media'), `${who.name} sees a badge`).toContainText('(1)', { timeout: 15_000 }); await beat(U, 1200);
        await U.getByTestId('nav-media').click();
        await expect(U.getByTestId('media-tab-ours')).toHaveAttribute('aria-selected', 'true'); // opens on "From us" because something is new
        const card = U.getByTestId('video-card').filter({ hasText: title });
        await expect(card, `${who.name} sees the card`).toBeVisible();
        await expect(card.getByTestId('video-new')).toBeVisible();
        await expect(card).toContainText('People Pulse, own work, 2026');
        await beat(U, 1200);
        const media = card.getByTestId('video-media');
        expect(await media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(true); // never starts by itself
        const counted = U.waitForResponse((r) => r.url().includes('/videocast/') && r.url().endsWith('/view') && r.status() === 200);
        await media.evaluate((m: HTMLMediaElement) => { m.muted = true; return m.play(); });
        await counted; await beat(U, 1500);
        await media.evaluate((m: HTMLMediaElement) => m.pause());
        await U.reload(); await beat(U, 700);
        await expect(U.getByTestId('nav-media'), `${who.name} no badge after looking`).toHaveText('Media');
        await U.getByTestId('sign-out').click();
        await expect(U.getByTestId('sign-in')).toBeVisible(); await beat(U, 600); // Log out became Sign in
      }

      // ---- ADMIN A recalls it: a member no longer sees it ----------------------------------------------------------------------------------
      await A.getByTestId('va-item').filter({ hasText: title }).getByTestId('va-recall').click();
      await expect(A.getByTestId('va-msg')).toContainText('Recalled');
      await expect(A.getByTestId('va-item').filter({ hasText: title })).toHaveAttribute('data-status', 'recalled'); await beat(A, 1500);
      await U.goto('/'); await openCivic(U);
      await U.getByTestId('demo-resident_verified').click();
      await expect(U.getByTestId('civic-signed-in')).toBeVisible();
      await U.getByTestId('nav-media').click(); await U.getByTestId('media-tab-ours').click();
      await expect(U.getByTestId('video-card').filter({ hasText: title })).toHaveCount(0);
      await expect(U.getByTestId('media-ours-empty')).toBeVisible(); await beat(U, 1200);
    } finally {
      await second.close().catch(() => undefined);
      videos.push(await admin.save(), await users.save());
    }
    for (const v of videos) expect(fs.statSync(v).size).toBeGreaterThan(10_000);
    console.log('videos:\n  ' + videos.join('\n  '));
  });
});

test.describe('video broadcast rules on screen and in the API (S-230, S-231)', () => {
  test('@E2E-222 a member and a signed-out visitor cannot reach the admin screen, and the API refuses them', async ({ page, request }) => {
    const m = await seedPerson(request);
    const r1 = await request.post(`${API}/videocast/admin`, { headers: bearer(m.token), data: {} });
    expect(r1.status()).toBe(403);
    expect((await request.get(`${API}/videocast`)).status()).toBe(401);
    await openCivicAs(page, m.token);
    await page.goto('/#/videos-admin');
    await expect(page.getByTestId('videos-admin')).toBeVisible();
    await expect(page.getByTestId('gate-403')).toBeVisible(); // the server decides, whatever the page shows
  });

  test('@E2E-222 the Media tab asks a signed-out visitor to sign in to see videos from us', async ({ page }) => {
    await page.goto('/?state=AP');
    await page.getByTestId('nav-media').click();
    await page.getByTestId('media-tab-ours').click();
    await expect(page.getByTestId('media-ours-signin')).toBeVisible();
  });

  test('@E2E-222 the proposal form refuses party wording and a page address that is not a media file, with the server message shown', async ({ browser, request }) => {
    const a = await seedPerson(request, [{ role: 'admin' }]);
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    try {
      await openCivicAs(page, a.token);
      await page.goto('/#/videos-admin');
      await page.getByTestId('va-title').fill('Vote for the Green party on Sunday');
      await page.getByTestId('va-url').fill(MEDIA);
      await page.getByTestId('va-credit').fill('Own work');
      await page.getByTestId('va-neutral').check(); await page.getByTestId('va-rights').check();
      await page.getByTestId('va-propose').click();
      await expect(page.getByRole('alert')).toContainText(/party or candidate/i);
      const refused = `Refused title ${Date.now() % 100000}`;
      await page.getByTestId('va-title').fill(refused);
      await page.getByTestId('va-url').fill('https://media.example.org/watch-page.html');
      await page.getByTestId('va-propose').click();
      await expect(page.getByRole('alert')).toContainText(/straight to a video or audio file/i);
      await page.getByTestId('va-url').fill('https://www.youtube.com/watch?v=abc123');
      await page.getByTestId('va-propose').click();
      await expect(page.getByRole('alert')).toContainText(/approved list/i); // a host that is not on MEDIA_VIDEO_HOSTS
      await expect(page.getByTestId('va-item').filter({ hasText: refused })).toHaveCount(0); // nothing was created
    } finally { await ctx.close(); }
  });
});
