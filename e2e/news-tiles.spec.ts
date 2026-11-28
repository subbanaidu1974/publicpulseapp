import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * S-287: the News tab as expandable tiles on a wide screen and a swipe-up feed (one story per screen) on a phone.
 * The news API is answered with made-up items here, so this checks the screens only; real feeds are covered by media-hub.spec.ts.
 */
const N = 50;
const items = Array.from({ length: N }, (_, i) => ({
  id: `n${i}`, title: `Story ${i + 1} headline`, link: `https://publisher.example.org/${i}`, snippet: `Story ${i + 1} summary text.`, published_at: new Date(Date.UTC(2026, 10, 28, 10, 0, 0) - i * 60_000).toISOString(),
  outlet_en: 'Sample Daily', outlet_te: null, source_id: 's1', youtube: i === 1 ? 'dQw4w9WgXcQ' : null,
}));
const payload = { items, digest: items.slice(0, 3), sources: [{ id: 's1', name_en: 'Sample Daily', name_te: null, stale: false }] };

async function openNews(page: Page) {
  await page.route('**/media/news*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }));
  await page.route('**/media/preview', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"preview":false}' }));
  await page.goto('/?state=AP');
  const nav = page.getByTestId('nav-media');
  if (!(await nav.isVisible())) await page.locator('#mobile-menu-toggle').click();
  await nav.click();
  await page.getByTestId('media-tab-news').click();
  await expect(page.getByTestId('news-list')).toBeVisible();
}

test.describe('news tiles on a wide screen', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('@E2E-254 news shows as a grid of tiles; a tile opens to its summary, video and report; the publisher link is always there', async ({ page }) => {
    await openNews(page);
    await expect(page.getByTestId('news-list')).toHaveAttribute('data-view', 'tiles');
    await expect(page.getByTestId('news-swipe')).toHaveCount(0);
    await expect(page.getByTestId('news-view-swipe')).toHaveCount(0); // the swipe choice is for phones
    const first = page.getByTestId('news-item').first();
    await expect(first.getByTestId('news-title')).toContainText('Story 1 headline');
    await expect(first.getByTestId('news-link')).toHaveAttribute('href', 'https://publisher.example.org/0');
    await expect(first.getByTestId('news-snippet')).toHaveCount(0); // closed: headline only
    const a = await page.getByTestId('news-item').nth(0).boundingBox(), b = await page.getByTestId('news-item').nth(1).boundingBox();
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(5); // side by side: more than one column
    const open = first.getByTestId('news-expand');
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await open.click();
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    await expect(first.getByTestId('news-snippet')).toHaveText('Story 1 summary text.');
    await open.click();
    await expect(first.getByTestId('news-snippet')).toHaveCount(0);
    // a story with a video loads nothing from YouTube until it is opened and played
    const vid = page.getByTestId('news-item').filter({ hasText: 'Story 2 headline' });
    await expect(vid.getByTestId('news-yt')).toHaveCount(0);
    await vid.getByTestId('news-expand').click();
    await expect(vid.getByTestId('news-yt-frame')).toHaveCount(0);
    await vid.getByTestId('news-yt-play').click();
    await expect(vid.getByTestId('news-yt-frame')).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  });

  test('@E2E-254 only the first tiles are drawn; "show more" adds the next', async ({ page }) => {
    await openNews(page);
    const earlier = page.locator('[aria-labelledby="news-more-h"] [data-testid="news-item"]');
    await expect(earlier).toHaveCount(30);
    await page.getByTestId('news-show-more').click();
    await expect(earlier).toHaveCount(N - 3);
    await expect(page.getByTestId('news-show-more')).toHaveCount(0);
  });
});

test.describe('news swipe feed on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('@E2E-255 a phone opens on a swipe feed: one story fills the screen, swipe or the arrows move to the next, the count follows', async ({ page }) => {
    await openNews(page);
    await expect(page.getByTestId('news-list')).toHaveAttribute('data-view', 'swipe');
    const feed = page.getByTestId('news-swipe-feed');
    await expect(feed).toBeVisible();
    await expect(page.getByTestId('news-swipe-hint')).toBeVisible();
    await expect(page.getByTestId('news-swipe-count')).toHaveText(`1 / ${N}`);
    await expect(page.getByTestId('news-prev')).toBeDisabled();
    const cardH = await page.getByTestId('news-item').first().evaluate((e) => e.getBoundingClientRect().height);
    const feedH = await feed.evaluate((e) => e.clientHeight);
    expect(Math.abs(cardH - feedH)).toBeLessThan(2); // one story per screen
    await expect(page.getByTestId('news-item').first().getByTestId('news-snippet')).toBeVisible(); // nothing to open on a card
    await page.getByTestId('news-next').click();
    await expect(page.getByTestId('news-swipe-count')).toHaveText(`2 / ${N}`);
    // the second story has snapped to the top of the feed (checked inside the feed, since the page itself may have scrolled to reach the button)
    await expect.poll(() => page.getByTestId('news-item').nth(1).evaluate((e) => { const c = e as HTMLElement; return Math.abs(c.offsetTop - (c.parentElement as HTMLElement).scrollTop); })).toBeLessThan(2);
    await feed.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('news-swipe-count')).toHaveText(`3 / ${N}`);
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId('news-swipe-count')).toHaveText(`2 / ${N}`);
    // a finger swipe is plain native scrolling with snap points: scroll by one screen and it settles on the next story
    await feed.evaluate((e) => e.scrollBy({ top: e.clientHeight, behavior: 'auto' }));
    await expect(page.getByTestId('news-swipe-count')).toHaveText(`3 / ${N}`);
  });

  test('@E2E-255 the feed adds more stories as the reader nears the end, and a phone can switch to tiles and back', async ({ page }) => {
    await openNews(page);
    await expect(page.getByTestId('news-item')).toHaveCount(40);
    await page.getByTestId('news-swipe-feed').evaluate((e) => e.scrollTo({ top: e.scrollHeight, behavior: 'auto' }));
    await expect(page.getByTestId('news-item')).toHaveCount(N);
    await page.getByTestId('news-view-tiles').click();
    await expect(page.getByTestId('news-list')).toHaveAttribute('data-view', 'tiles');
    await expect(page.getByTestId('news-view-tiles')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('news-item').first().getByTestId('news-expand').click();
    await expect(page.getByTestId('news-item').first().getByTestId('news-snippet')).toBeVisible();
    await page.getByTestId('news-view-swipe').click();
    await expect(page.getByTestId('news-swipe-feed')).toBeVisible();
  });

  test('@E2E-255 the swipe feed fits the screen sideways and has no accessibility violations', async ({ page }) => {
    await openNews(page);
    await expect(page.getByTestId('news-swipe-feed')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    const r = await new AxeBuilder({ page }).include('[data-testid=news-list]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});
