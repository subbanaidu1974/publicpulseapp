import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, bearer, openCivicAs, seedPerson } from './civic-seed';
import { openCivic } from './civic-helpers';

/**
 * Recorded media journey (S-225, S-226, S-228, S-229, S-231, S-232, S-234, S-235, S-236):
 * Admin context -> media-admin-sources.webm   (adds a news outlet and a live channel with their permission record; cannot switch them on itself; handles a report; sets a silence window)
 * Member context -> media-member-journey.webm (nothing before the sources are on; then news, a click to the publisher, a report, a live channel, the library, a held video, a withdrawal notice)
 * Run it with:  npm run e2e:media-videos
 * A tiny local web server inside the test plays the part of the news outlet's official feed; nothing real is contacted.
 */
const OUT = path.resolve('test-results', 'videos', 'media-hub');
const SIZE = { width: 1280, height: 720 };
const LIVE_STREAM = 'https://media.example.org/live-channel.wav';
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
const beat = (page: Page, ms = 900) => page.waitForTimeout(ms);
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** A stand-in for a news outlet: an RSS feed and one story page, on a local port. */
async function startOutlet(titles: string[]) {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toUTCString();
  const old = new Date(Date.now() - 10 * 86_400_000).toUTCString();
  let base = '';
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/feed.xml')) {
      res.setHeader('content-type', 'application/rss+xml');
      res.end(`<?xml version="1.0"?><rss><channel><title>Test Outlet</title>${titles.map((t, i) => `<item><title>${t}</title><link>${base}/story/${i}</link><pubDate>${ago(10 + i * 30)}</pubDate><description>The full story is long and stays on the outlet's site.</description></item>`).join('')}<item><title>An old story from last month</title><link>${base}/story/old</link><pubDate>${old}</pubDate></item></channel></rss>`);
    } else if (req.url?.startsWith('/story/')) {
      res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Outlet story</title><h1>The outlet publishes the story here</h1>');
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function recorded(browser: Browser, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, `.tmp-${name}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: tmp, size: SIZE } });
  await ctx.route(LIVE_STREAM, (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: wav() }));
  await ctx.route('https://media.example.org/library-explainer.wav', (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: wav() }));
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
async function adminToken(page: Page) { return (await (await page.request.post(`${API}/demo/login`, { data: { persona: 'admin' } })).json()).token as string; }
async function closeAllPolls(page: Page) {
  const t = await adminToken(page);
  const l = await (await page.request.get(`${API}/broadcast/admin`, { headers: bearer(t) })).json();
  for (const p of l.polls ?? []) if (p.status === 'open' || p.status === 'scheduled') await page.request.post(`${API}/broadcast/admin/${p.id}/close`, { headers: bearer(t) });
}
/** Switch every source off so the shared test database goes back to "no outside content" for the other specs. */
async function switchAllSourcesOff(page: Page) {
  const t = await adminToken(page);
  const l = await (await page.request.get(`${API}/media/admin/sources`, { headers: bearer(t) })).json();
  for (const s of l.sources ?? []) if (s.enabled) await page.request.post(`${API}/media/admin/sources/${s.id}/disable`, { headers: bearer(t) });
}
async function openMedia(page: Page, tab?: 'news' | 'watch' | 'live' | 'ours') {
  const nav = page.getByTestId('nav-media');
  await expect(nav).toBeVisible();
  await nav.click();
  await expect(page.getByTestId('media-home')).toBeVisible();
  if (tab) await page.getByTestId(`media-tab-${tab}`).click();
}

test.describe('Media tab journey, recorded (S-225 to S-236)', () => {
  test.skip(({ isMobile }) => isMobile, 'recorded at desktop size only');

  test('@E2E-225 sources need a permission record and a second admin; then news, a click, a report and its takedown, a live channel, the library, a silence hold and a withdrawal all reach members', async ({ browser, request }) => {
    test.setTimeout(300_000);
    const outlet = await startOutlet(['Water scheme opens in Guntur', 'Road repair begins near Vijayawada']);
    const admin = await recorded(browser, 'media-admin-sources');
    const member = await recorded(browser, 'media-member-journey');
    const second = await browser.newContext({ viewport: SIZE });
    const videos: string[] = [];
    const tag = `${Date.now() % 100000}`;
    const OUTLET = `Daily Telugu ${tag}`, CHANNEL = `Channel One ${tag}`;
    try {
      const A = admin.page, M = member.page;
      await closeAllPolls(A);
      await switchAllSourcesOff(A);

      // ---- ADMIN A adds a news outlet and a live channel with their permission record; cannot switch them on -----------------------------
      await openCivic(A); await beat(A);
      await A.getByTestId('demo-admin').click();
      await expect(A.getByTestId('admin-survey-home')).toBeVisible();
      await A.getByTestId('media-admin-link-home').click();
      await expect(A.getByTestId('media-admin')).toBeVisible(); await beat(A);
      await A.getByTestId('ma-kind').selectOption('news');
      await A.getByTestId('ma-name').fill(OUTLET);
      await A.getByTestId('ma-site').fill(outlet.base + '/');
      await A.getByTestId('ma-feed').fill(outlet.base + '/feed.xml');
      await A.getByTestId('ma-allow').selectOption('snippet');
      await A.getByTestId('ma-perm').fill('Written reuse permission from the editor, mail of 20 Nov 2026, kept in the permissions folder');
      await A.getByTestId('ma-pdate').fill('2026-11-20');
      await A.getByTestId('ma-contact').fill('desk@outlet.example');
      await beat(A, 1200);
      await A.getByTestId('ma-add').click();
      await expect(A.getByTestId('ma-msg')).toContainText('switched off');
      await A.getByTestId('ma-kind').selectOption('live');
      await A.getByTestId('ma-name').fill(CHANNEL);
      await A.getByTestId('ma-site').fill('https://channel-one.example.net/');
      await A.getByTestId('ma-stream').fill(LIVE_STREAM);
      await A.getByTestId('ma-perm').fill('The channel confirmed in writing that its official stream may be shown, 21 Nov 2026');
      await A.getByTestId('ma-pdate').fill('2026-11-21');
      await A.getByTestId('ma-contact').fill('tech@channel-one.example');
      await A.getByTestId('ma-add').click();
      await expect(A.getByTestId('ma-msg')).toContainText('switched off');
      const outletRow = A.getByTestId('ma-source').filter({ hasText: OUTLET });
      const channelRow = A.getByTestId('ma-source').filter({ hasText: CHANNEL });
      await expect(outletRow).toHaveAttribute('data-enabled', '0');
      await expect(outletRow.getByTestId('ma-enable')).toBeDisabled(); // the admin who added it cannot switch it on
      await expect(channelRow.getByTestId('ma-enable')).toBeDisabled(); await beat(A, 1500);

      // ---- MEMBER: nothing is shown while no source is on ----------------------------------------------------------------------------------
      await openCivic(M); await beat(M);
      await M.getByTestId('demo-resident_verified').click();
      await expect(M.getByTestId('civic-signed-in')).toBeVisible();
      await openMedia(M, 'news');
      await expect(M.getByTestId('media-news-empty')).toBeVisible();
      await M.getByTestId('media-tab-live').click();
      await expect(M.getByTestId('media-live-empty')).toBeVisible(); await beat(M, 1500);

      // ---- ADMIN B (a different admin) switches them on and reads the feed ------------------------------------------------------------------
      const b = await seedPerson(second.request, [{ role: 'admin' }]);
      const B = await second.newPage();
      await openCivicAs(B, b.token);
      await B.goto('/#/media-admin');
      const outletB = B.getByTestId('ma-source').filter({ hasText: OUTLET });
      await expect(outletB.getByTestId('ma-enable')).toBeEnabled();
      await outletB.getByTestId('ma-enable').click();
      await expect(B.getByTestId('ma-msg')).toContainText('Switched on');
      await expect(outletB).toHaveAttribute('data-enabled', '1');
      await outletB.getByTestId('ma-refresh').click();
      await expect(B.getByTestId('ma-msg')).toContainText('Read the feed');
      await B.getByTestId('ma-source').filter({ hasText: CHANNEL }).getByTestId('ma-enable').click();
      await expect(B.getByTestId('ma-source').filter({ hasText: CHANNEL })).toHaveAttribute('data-enabled', '1');
      await A.reload(); await beat(A, 1500);

      // ---- MEMBER: sees news from the publisher, opens a story at the publisher, reports one ---------------------------------------------------
      await M.reload(); await openMedia(M, 'news');
      const item = M.getByTestId('news-item').filter({ hasText: 'Water scheme opens in Guntur' });
      await expect(item).toBeVisible();
      await expect(item.getByTestId('news-outlet')).toHaveText(OUTLET);
      await expect(M.getByTestId('news-pubnote')).toBeVisible();
      await expect(M.getByTestId('news-digest')).toBeVisible();
      await expect(M.getByText('An old story from last month')).toHaveCount(0); // older than a week is not shown
      await expect(item).toContainText('stays on the outlet'); // the snippet this source allows
      await beat(M, 1500);
      const [popup] = await Promise.all([M.context().waitForEvent('page'), item.getByTestId('news-link').click()]);
      await expect(popup.getByRole('heading')).toContainText('The outlet publishes the story here'); await beat(M, 1200);
      await popup.close();
      const second_item = M.getByTestId('news-item').filter({ hasText: 'Road repair begins near Vijayawada' });
      await second_item.getByTestId('report-open').click();
      await second_item.getByTestId('report-reason').selectOption('wrong');
      await second_item.getByTestId('report-note').fill('The date in this story looks wrong');
      await beat(M, 900);
      await second_item.getByTestId('report-send').click();
      await expect(second_item.getByTestId('report-done')).toBeVisible(); await beat(M, 1500);

      // ---- MEMBER: the live channel, its own site, and its official stream ------------------------------------------------------------------
      await M.getByTestId('media-tab-live').click();
      const ch = M.getByTestId('live-channel').filter({ hasText: CHANNEL });
      await expect(ch).toBeVisible();
      await expect(ch.getByTestId('live-link')).toHaveAttribute('href', 'https://channel-one.example.net/');
      await ch.getByTestId('live-play').click();
      const vid = ch.getByTestId('live-video');
      await expect(vid).toBeVisible();
      expect(await vid.evaluate((m: HTMLMediaElement) => m.paused)).toBe(true); // never starts by itself
      await vid.evaluate((m: HTMLMediaElement) => { m.muted = true; return m.play(); });
      await expect.poll(() => vid.evaluate((m: HTMLMediaElement) => m.currentTime)).toBeGreaterThan(0); await beat(M, 1500);

      // ---- ADMIN A: sees the report, takes the story down ------------------------------------------------------------------------------------
      await A.reload();
      const rep = A.getByTestId('ma-report').filter({ hasText: 'The date in this story looks wrong' });
      await expect(rep).toHaveAttribute('data-status', 'open'); await beat(A, 1200);
      await rep.getByTestId('ma-takedown').click();
      await expect(A.getByTestId('ma-msg')).toContainText('Taken down');
      await expect(A.getByTestId('ma-report').filter({ hasText: 'The date in this story looks wrong' })).toHaveAttribute('data-status', 'resolved'); await beat(A, 1200);
      await M.getByTestId('media-tab-news').click(); await M.reload(); await openMedia(M, 'news');
      await expect(M.getByText('Road repair begins near Vijayawada')).toHaveCount(0); // gone for members
      await expect(M.getByText('Water scheme opens in Guntur')).toBeVisible(); await beat(M, 1200);

      // ---- ADMIN A: opens a silence window; a video approved during it waits; B ends the window; members then see it, in the library with its transcript ----
      const now = new Date();
      await A.getByTestId('ma-wlabel').fill('Polling silence period (test)');
      await A.getByTestId('ma-wstart').fill(localInput(new Date(now.getTime() - 3_600_000)));
      await A.getByTestId('ma-wend').fill(localInput(new Date(now.getTime() + 3 * 3_600_000)));
      await beat(A, 900);
      await A.getByTestId('ma-wadd').click();
      await expect(A.getByTestId('ma-msg')).toContainText('Window added');
      await expect(A.getByTestId('ma-window').filter({ hasText: 'Polling silence period (test)' })).toBeVisible(); await beat(A, 1200);
      const aTok = await adminToken(A);
      const vt = `Reading a result sheet ${tag}`;
      const created = await (await A.request.post(`${API}/videocast/admin`, { headers: bearer(aTok), data: { title_en: vt, note_en: 'A short explainer.', media_url: 'https://media.example.org/library-explainer.wav', credit: 'People Pulse, own work, 2026', library: true, transcript: 'This explainer shows how to read a result sheet, row by row, and where to find the totals.', confirm_neutral: true, confirm_rights: true } })).json();
      expect((await second.request.post(`${API}/videocast/admin/${created.id}/approve`, { headers: bearer(b.token) })).status()).toBe(200);
      await M.reload(); await openMedia(M, 'ours');
      await expect(M.getByTestId('nav-media')).toHaveText('Media'); // held: no badge
      await expect(M.getByTestId('video-card').filter({ hasText: vt })).toHaveCount(0); await beat(M, 1500);
      await B.reload(); // B ends the window early (a different admin than the one who added it)
      await B.getByTestId('ma-window').filter({ hasText: 'Polling silence period (test)' }).getByTestId('ma-wend-btn').click();
      await expect(B.getByTestId('ma-msg')).toContainText('Window ended');
      await M.reload(); await expect(M.getByTestId('nav-media')).toContainText('(1)', { timeout: 15_000 }); await beat(M, 900);
      await openMedia(M, 'ours');
      await expect(M.getByTestId('video-list').getByTestId('video-card').filter({ hasText: vt })).toBeVisible(); await beat(M, 1200);
      await M.getByTestId('media-tab-watch').click();
      const lib = M.getByTestId('video-library').getByTestId('video-card').filter({ hasText: vt });
      await expect(lib).toBeVisible();
      await lib.getByTestId('video-transcript').locator('summary').click();
      await expect(lib.getByTestId('video-transcript')).toContainText('row by row'); await beat(M, 1500);

      // ---- ADMIN A withdraws it with a note: members see the correction ---------------------------------------------------------------------
      expect((await A.request.post(`${API}/videocast/admin/${created.id}/recall`, { headers: bearer(aTok), data: { note: 'A corrected version follows' } })).status()).toBe(200);
      await M.reload(); await openMedia(M, 'ours');
      await expect(M.getByTestId('video-correction').filter({ hasText: vt })).toContainText('A corrected version follows'); await beat(M, 2000);

      // ---- the numbers screen: counts only, hidden under 10 --------------------------------------------------------------------------------
      await A.reload(); await beat(A, 800);
      await expect(A.getByTestId('ma-number').filter({ hasText: 'hidden under' }).first()).toBeVisible(); await beat(A, 1500);
    } finally {
      await switchAllSourcesOff(admin.page).catch(() => undefined);
      await second.close().catch(() => undefined);
      await outlet.close();
      videos.push(await admin.save(), await member.save());
    }
    for (const v of videos) expect(fs.statSync(v).size).toBeGreaterThan(10_000);
    console.log('videos:\n  ' + videos.join('\n  '));
  });
});

test.describe('Media rules (S-225 to S-236)', () => {
  test('@E2E-226 a member and a signed-out visitor are refused by the media admin API; the screen shows the refusal', async ({ page, request }) => {
    const m = await seedPerson(request);
    expect((await request.get(`${API}/media/admin/sources`, { headers: bearer(m.token) })).status()).toBe(403);
    expect((await request.post(`${API}/media/admin/sources`, { data: {} })).status()).toBe(401);
    expect((await request.post(`${API}/media/report`, { data: { kind: 'news', id: 'x', reason: 'wrong' } })).status()).toBe(401);
    await openCivicAs(page, m.token);
    await page.goto('/#/media-admin');
    await expect(page.getByTestId('media-admin')).toBeVisible();
    await expect(page.getByTestId('gate-403').first()).toBeVisible();
  });

  test('@E2E-226 the source form refuses a source with no permission record being switched on, and an address that is not https', async ({ browser, request }) => {
    const a = await seedPerson(request, [{ role: 'admin' }]), b = await seedPerson(request, [{ role: 'admin' }]);
    const ctx = await browser.newContext(); const pa = await ctx.newPage(); const ctxB = await browser.newContext(); const pb = await ctxB.newPage();
    try {
      await openCivicAs(pa, a.token); await pa.goto('/#/media-admin');
      await pa.getByTestId('ma-name').fill('No Permission Daily');
      await pa.getByTestId('ma-site').fill('http://insecure.example.net/');
      await pa.getByTestId('ma-feed').fill('https://nopermission.example.net/feed.xml');
      await pa.getByTestId('ma-add').click();
      await expect(pa.getByRole('alert')).toContainText(/https/);
      await pa.getByTestId('ma-site').fill('https://nopermission.example.net/');
      await pa.getByTestId('ma-add').click();
      await expect(pa.getByTestId('ma-msg')).toContainText('switched off');
      await openCivicAs(pb, b.token); await pb.goto('/#/media-admin');
      const row = pb.getByTestId('ma-source').filter({ hasText: 'No Permission Daily' });
      await row.getByTestId('ma-enable').click();
      await expect(pb.getByRole('alert')).toContainText(/record the permission/);
      await expect(row).toHaveAttribute('data-enabled', '0');
    } finally { await ctx.close(); await ctxB.close(); }
  });

  test('@E2E-226 a member can mute new-video alerts on this device: the badge goes, From us stays reachable', async ({ page, request }) => {
    const a = await seedPerson(request, [{ role: 'admin' }]), b = await seedPerson(request, [{ role: 'admin' }]), m = await seedPerson(request);
    const title = `Mute test video ${Date.now() % 100000}`;
    const c = await (await request.post(`${API}/videocast/admin`, { headers: bearer(a.token), data: { title_en: title, media_url: 'https://media.example.org/mute.wav', credit: 'Own work 2026', confirm_neutral: true, confirm_rights: true } })).json();
    await request.post(`${API}/videocast/admin/${c.id}/approve`, { headers: bearer(b.token) });
    await page.addInitScript(() => { try { localStorage.removeItem('pp-video-seen'); localStorage.removeItem('pp-video-mute'); } catch { /* ignore */ } });
    await openCivicAs(page, m.token);
    await expect(page.getByTestId('nav-media')).toContainText('(', { timeout: 15_000 });
    await openMedia(page);
    await expect(page.getByTestId('media-mute')).not.toBeChecked();
    await page.getByTestId('media-mute').check();
    await page.evaluate(() => { try { localStorage.removeItem('pp-video-seen'); } catch { /* ignore */ } window.dispatchEvent(new Event('pp-video-seen')); });
    await expect(page.getByTestId('nav-media')).toHaveText('Media'); // muted: no badge even though there is something unseen
    await page.getByTestId('media-tab-ours').click();
    await expect(page.getByTestId('video-card').filter({ hasText: title })).toBeVisible(); // still reachable
    await page.getByTestId('media-mute').uncheck();
    await request.post(`${API}/videocast/admin/${c.id}/recall`, { headers: bearer(a.token), data: { note: 'test finished' } }); // leave no live video behind for the other specs
  });

  test('@E2E-226 news, live and the report form read in Telugu at phone width with no overflow and no axe violations', async ({ page, request }) => {
    const a = await seedPerson(request, [{ role: 'admin' }]), b = await seedPerson(request, [{ role: 'admin' }]), m = await seedPerson(request);
    const outlet = await startOutlet(['శీర్షిక పరీక్ష వార్త ఒకటి', 'Second headline for the phone check']);
    try {
      const nm = `Phone Daily ${Date.now() % 100000}`;
      const s = await (await request.post(`${API}/media/admin/sources`, { headers: bearer(a.token), data: { kind: 'news', name_en: nm, name_te: 'ఫోన్ డైలీ', site_url: outlet.base + '/', feed_url: outlet.base + '/feed.xml', allow: 'headline', state: 'BOTH', permission_note: 'Written permission from the editor, 20 Nov 2026', permission_date: '2026-11-20', contact: 'desk@outlet.example' } })).json();
      await request.post(`${API}/media/admin/sources/${s.id}/enable`, { headers: bearer(b.token) });
      await request.post(`${API}/media/admin/sources/${s.id}/refresh`, { headers: bearer(b.token) });
      await page.setViewportSize({ width: 375, height: 800 });
      await openCivicAs(page, m.token, 'te');
      await page.locator('#mobile-menu-toggle').click();
      await page.getByTestId('nav-media').click();
      await page.getByTestId('media-tab-news').click(); // the page opens on From us when a video is unseen
      await expect(page.getByTestId('news-list')).toBeVisible();
      await expect(page.getByTestId('news-item').first()).toBeVisible();
      await expect(page.getByTestId('news-link').first()).toContainText(/[ఀ-౿]/);
      await page.getByTestId('news-item').first().getByTestId('report-open').click();
      await expect(page.getByTestId('report-form')).toBeVisible();
      await expect(page.getByTestId('report-send')).toContainText(/[ఀ-౿]/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
      const r = await new AxeBuilder({ page }).include('[data-testid=media-home]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      await request.post(`${API}/media/admin/sources/${s.id}/disable`, { headers: bearer(a.token) });
    } finally { await outlet.close(); }
  });
});
