import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openHome, revealNav } from './helpers';

/** Media tab shell (S-224) and the free media player (S-227). */

/** One second of a 440 Hz tone as a mono 8-bit 8 kHz WAV, built here so the test needs no media file. */
function wav(seconds = 1): Buffer {
  const rate = 8000, n = rate * seconds, data = Buffer.alloc(n);
  for (let i = 0; i < n; i++) data[i] = 128 + Math.round(60 * Math.sin((2 * Math.PI * 440 * i) / rate));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, data]);
}
const VTT = Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n');

async function openMedia(page: Page, lang: 'en' | 'te' = 'en') {
  await page.addInitScript((l) => { try { localStorage.setItem('pp-lang', l); sessionStorage.removeItem('pp-media-tab'); } catch { /* ignore */ } }, lang);
  await openHome(page, 'AP');
  let nav = page.getByTestId('nav-media');
  if (!(await nav.isVisible())) { await revealNav(page); nav = page.getByTestId('nav-media'); }
  await nav.click();
  await expect(page.getByTestId('media-home')).toBeVisible();
}

test.describe('media tab shell (S-224)', () => {
  test('@E2E-218 the Media tab opens with four sections and honest empty states, nothing hard-coded', async ({ page }) => {
    await openMedia(page);
    const ids = await page.locator('[data-testid=media-tabs] [role=tab]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(ids).toEqual(['media-tab-news', 'media-tab-watch', 'media-tab-live', 'media-tab-ours']);
    await expect(page.getByTestId('media-tab-news')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('media-news-empty')).toBeVisible();
    await expect(page.getByTestId('media-news-empty')).toContainText('No news is shown yet');
    for (const [tab, id] of [['live', 'media-live-empty'], ['ours', 'media-ours-signin']] as const) {
      await page.getByTestId(`media-tab-${tab}`).click();
      await expect(page.getByTestId(id)).toBeVisible();
    }
    // no outside links or embedded frames in the shell
    expect(await page.locator('[data-testid=media-home] iframe').count()).toBe(0);
    expect(await page.locator('[data-testid=media-home] a[href^="http"]').count()).toBe(0);
  });

  test('@E2E-218 sections work from the keyboard, read in Telugu with the review note, and the choice survives a reload', async ({ page }) => {
    await openMedia(page, 'te');
    await expect(page.getByTestId('translation-review-note')).toBeVisible();
    for (const t of ['news', 'watch', 'live', 'ours']) await expect(page.getByTestId(`media-tab-${t}`)).toContainText(/[ఀ-౿]/);
    await page.getByTestId('media-tab-news').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('media-tab-watch')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('media-tab-watch')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId('media-tab-ours')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight'); // wraps to the first
    await expect(page.getByTestId('media-tab-news')).toHaveAttribute('aria-selected', 'true');
  });

  test('@E2E-218 the Media tab fits a phone and passes the accessibility scan', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openMedia(page);
    for (const t of ['news', 'watch', 'live', 'ours']) {
      await page.getByTestId(`media-tab-${t}`).click();
      const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(over, `no sideways scroll on ${t}`).toBe(false);
      const r = await new AxeBuilder({ page }).include('[data-testid=media-home]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`), t).toEqual([]);
    }
  });
});

test.describe('free media player (S-227)', () => {
  test('@E2E-219 a chosen audio file plays on this device only: no autoplay, speed and time work, nothing is uploaded or stored', async ({ page }) => {
    const posts: string[] = [];
    await openMedia(page);
    await page.getByTestId('media-tab-watch').click();
    await expect(page.getByTestId('mp-empty')).toBeVisible();
    page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${r.url()}`); }); // from here on: choosing and playing a file
    await page.getByTestId('mp-file').setInputFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wav(2) });
    await expect(page.getByTestId('mp-name')).toHaveText('tone.wav');
    const media = page.getByTestId('mp-media');
    await expect(media).toHaveAttribute('src', /^blob:/);
    await expect(page.getByTestId('mp-time')).toContainText('0:00 / 0:02');
    expect(await media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(true); // it did not start by itself
    expect(await media.evaluate((m: HTMLMediaElement) => m.autoplay)).toBe(false);
    await page.getByTestId('mp-speed').selectOption('1.5');
    expect(await media.evaluate((m: HTMLMediaElement) => m.playbackRate)).toBe(1.5);
    await media.evaluate((m: HTMLMediaElement) => { m.muted = true; return m.play(); });
    await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime)).toBeGreaterThan(0);
    await media.evaluate((m: HTMLMediaElement) => m.pause());
    await expect(page.getByTestId('mp-audioonly')).toHaveCount(0); // audio has no picture to hide
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('tone.wav'))).toBe(false); // nothing about the file is kept
    await page.getByTestId('mp-clear').click();
    await expect(page.getByTestId('mp-empty')).toBeVisible();
    expect(posts, 'nothing sent anywhere').toEqual([]);
  });

  test('@E2E-219 a file that is not audio or video is refused with a plain message, and a bad captions file is refused', async ({ page }) => {
    await openMedia(page);
    await page.getByTestId('media-tab-watch').click();
    await page.getByTestId('mp-file').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await expect(page.getByTestId('mp-msg')).toContainText('not a video or audio file');
    await expect(page.getByTestId('mp-empty')).toBeVisible();
    await page.getByTestId('mp-file').setInputFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wav(1) });
    await expect(page.getByTestId('mp-name')).toHaveText('tone.wav');
    await page.getByTestId('mp-cap').setInputFiles({ name: 'subs.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
    await expect(page.getByTestId('mp-msg')).toContainText('.vtt');
    await page.getByTestId('mp-cap').setInputFiles({ name: 'subs.vtt', mimeType: 'text/vtt', buffer: VTT });
    await expect(page.getByTestId('mp-media').locator('track')).toHaveAttribute('kind', 'captions');
  });

  test('@E2E-219 a file the browser cannot decode shows a clear error instead of a silent blank', async ({ page }) => {
    await openMedia(page);
    await page.getByTestId('media-tab-watch').click();
    await page.getByTestId('mp-file').setInputFiles({ name: 'broken.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('this is not audio') });
    await expect(page.getByTestId('mp-error')).toBeVisible();
    await expect(page.getByTestId('mp-error')).toContainText('could not be played');
  });

  test('@E2E-219 the player is labelled, keyboard reachable, and in Telugu at phone width with no overflow or axe violations', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openMedia(page, 'te');
    await page.getByTestId('media-tab-watch').click();
    await page.getByTestId('mp-file').setInputFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wav(1) });
    await expect(page.getByTestId('mp-media')).toHaveAttribute('aria-label', /మీడియా ప్లేయర్/);
    await expect(page.getByTestId('mp-speed')).toBeVisible();
    await page.getByTestId('mp-speed').focus();
    await expect(page.getByTestId('mp-speed')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    const r = await new AxeBuilder({ page }).include('[data-testid=media-home]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});

test.describe('YouTube link player (S-240)', () => {
  test('@E2E-232 a pasted YouTube link plays in the Watch section, nothing loads from YouTube before Play, a bad link is refused, nothing is stored or sent to our server', async ({ page }) => {
    let framed = 0;
    const ours: string[] = [];
    await page.route('https://www.youtube-nocookie.com/**', (r) => { framed++; return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>player</title>' }); });
    page.on('request', (r) => { if (r.url().includes('dQw4w9WgXcQ') && !r.url().includes('youtube-nocookie')) ours.push(r.url()); });
    await openMedia(page);
    await page.getByTestId('media-tab-watch').click();
    await expect(page.getByTestId('yt-player')).toBeVisible();
    expect(framed).toBe(0);
    await page.getByTestId('yt-link').fill('https://example.com/video');
    await page.getByTestId('yt-go').click();
    await expect(page.getByTestId('yt-bad')).toBeVisible();
    await expect(page.getByTestId('yt-frame')).toHaveCount(0);
    expect(framed).toBe(0);
    await page.getByTestId('yt-link').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await page.getByTestId('yt-go').click();
    await expect(page.getByTestId('yt-frame')).toHaveAttribute('src', /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
    await expect.poll(() => framed).toBeGreaterThan(0);
    expect(ours).toEqual([]); // the link never went to our server
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain('dQw4w9WgXcQ');
    const r = await new AxeBuilder({ page }).include('[data-testid=yt-player]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await page.getByTestId('yt-clear').click();
    await expect(page.getByTestId('yt-frame')).toHaveCount(0);
  });
});
