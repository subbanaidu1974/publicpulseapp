import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, bearer, findVillage, freshText, openCivicAs, report, seedPerson, uniq } from './civic-seed';
import { startOnCivicTab } from './civic-helpers';
test.beforeEach(async ({ page }) => { await startOnCivicTab(page, 'roles'); });

/**
 * E2E-160 (S-145): a verified representative posts a labelled reply with scheme tags on an issue in their constituency, from the real console;
 * the reply shows labelled on the public issue page; a revision keeps the history; a moderation hold hides the new version while the earlier
 * one stays; and none of it changes the issue's order or status. Real server, real roles (seeded through the guarded e2e route), no fixtures.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const serious = async (page: Page, root: string) => (await new AxeBuilder({ page }).include(root).withTags(TAGS).analyze()).violations
  .filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

const REPLY_1 = 'We have asked the water board to repair the pump this week and will visit the village on Saturday.';
const REPLY_2 = 'The pump repair is scheduled for Friday and I will check the water supply in person on Saturday.';
// a named private person plus an accusation: held by the same layered rules as citizen reports (see tests/civic/representatives.test.ts)
const FLAGGED = 'Mr Ramesh Kumar from the contractor office took money and delayed the work on purpose.';

async function setup(request: APIRequestContext) {
  const village = await findVillage(request, 'Kolluru');
  const tag = `e2erep${uniq()}`;
  const reporter = await seedPerson(request);
  const made = await report(request, reporter.token, { category: 'water', village: village.lgd, text: freshText(tag) });
  const pub = await (await request.get(`${API}/issues/${made.id}`)).json();
  expect(pub.constituency?.lgd, 'the test village must lie in a constituency').toBeTruthy();
  const rep = await seedPerson(request, [{ role: 'politician', jurisdiction: pub.constituency.lgd }]);
  const mod = await seedPerson(request, [{ role: 'moderator' }]);
  return { village, tag, id: made.id, constituency: pub.constituency as { lgd: string; name_en: string }, reporter, rep, mod };
}
const strip = (d: Record<string, unknown>) => { const { official_reply: _o, ...rest } = d; void _o; return rest; };
const feedIds = async (request: APIRequestContext, tag: string) => ((await (await request.get(`${API}/issues?q=${tag}`)).json()).items as { id: string }[] | undefined)?.map((i) => i.id) ?? [];

async function openIssue(page: Page, tag: string) {
  const answered = page.waitForResponse((r) => r.url().includes(`q=${tag}`) && r.url().includes('/civic/issues?') && r.ok());
  await page.getByTestId('if-q').fill(tag);
  await answered;
  await expect(page.getByTestId('issue-feed')).toContainText(tag, { timeout: 15_000 });
  await page.getByTestId('issue-open').first().click();
  await expect(page.getByTestId('detail-text')).toContainText(tag);
}

test.describe('E2E-160 representative reply', () => {
  test('@E2E-160 post with scheme tags, public label, revision history, moderation hold, no change to order or status', async ({ page, request, browser }) => {
    const s = await setup(request);
    const before = await (await request.get(`${API}/issues/${s.id}`)).json();
    expect(before.official_reply ?? null).toBeNull();
    const orderBefore = await feedIds(request, s.tag);

    // 1. the representative posts from the console, with two scheme tags
    await openCivicAs(page, s.rep.token);
    await page.getByTestId('console-tab-politician').click();
    await expect(page.getByTestId('politician-console')).toBeVisible();
    await page.getByTestId('pc-issue').fill(s.id);
    await page.getByTestId('pc-load').click();
    await expect(page.getByTestId('pc-save')).toBeDisabled(); // no text yet
    await page.getByTestId('pc-text').fill(REPLY_1);
    await page.getByTestId('pc-tag-jal_jeevan').check();
    await page.getByTestId('pc-tag-mplads').check();
    await page.getByTestId('pc-save').click();
    await expect(page.getByTestId('pc-msg')).toContainText(/Saved/);
    await expect(page.getByTestId('pc-versions').locator('li')).toHaveCount(1);
    expect(await serious(page, '[data-testid=politician-console]')).toEqual([]);
    await noOverflow(page);

    // 2. the public issue page (a citizen's view) shows it labelled, with the constituency and the tags
    const ctx = await browser.newContext();
    try {
      const citizen = await seedPerson(request);
      const p2 = await ctx.newPage();
      await openCivicAs(p2, citizen.token);
      await openIssue(p2, s.tag);
      const reply = p2.getByTestId('official-reply');
      await expect(reply).toBeVisible();
      await expect(reply).toContainText('Official reply from the elected representative for');
      await expect(reply).toContainText(s.constituency.name_en);
      await expect(p2.getByTestId('official-reply-text')).toHaveText(REPLY_1);
      await expect(p2.getByTestId('official-reply-tags').locator('li')).toHaveText([/Jal Jeevan/, /Local area development fund/]);
      await expect(p2.getByTestId('official-reply-history')).toHaveCount(0);
      expect(await p2.getByTestId('issue-detail').innerText()).not.toContain(s.rep.personId);
      expect(await serious(p2, '[data-testid=issue-detail]')).toEqual([]);
      await noOverflow(p2);
    } finally { await ctx.close(); }
    const afterPost = await (await request.get(`${API}/issues/${s.id}`)).json();
    expect(afterPost.official_reply).toMatchObject({ label: 'representative_reply', version: 1 });
    expect(strip(afterPost)).toEqual(strip(before)); // byte-identical apart from the reply
    expect(afterPost.status).toBe(before.status);
    expect(await feedIds(request, s.tag)).toEqual(orderBefore);

    // 3. a revision is a new version; the earlier text stays visible as history
    await page.getByTestId('pc-load').click();
    await expect(page.getByTestId('pc-versions').locator('li')).toHaveCount(1);
    await page.getByTestId('pc-text').fill(REPLY_2);
    await page.getByTestId('pc-save').click();
    await expect(page.getByTestId('pc-msg')).toContainText(/Saved/);
    await expect(page.getByTestId('pc-versions').locator('li')).toHaveCount(2);
    await page.getByTestId('pc-text').fill(FLAGGED);

    // 4. a flagged revision is held: the page keeps showing version 2
    await page.getByTestId('pc-save').click();
    await expect(page.getByTestId('pc-msg')).toContainText(/waiting for a moderator/);
    await expect(page.getByTestId('pc-versions').locator('li')).toHaveCount(3);
    await expect(page.getByTestId('pc-versions').locator('li').nth(2)).toContainText('Waiting for a moderator');
    const held = await (await request.get(`${API}/issues/${s.id}`)).json();
    expect(held.official_reply).toMatchObject({ version: 2, edited: true });
    expect(JSON.stringify(held)).not.toContain('Ramesh');
    expect(held.official_reply.history.map((h: { version: number }) => h.version)).toEqual([1]);

    const ctx2 = await browser.newContext();
    try {
      const p3 = await ctx2.newPage();
      await openCivicAs(p3, (await seedPerson(request)).token);
      await openIssue(p3, s.tag);
      await expect(p3.getByTestId('official-reply-text')).toHaveText(REPLY_2);
      await expect(p3.getByTestId('official-reply-history')).toContainText('Version 1');
      await p3.getByTestId('official-reply-history').locator('summary').click();
      await expect(p3.getByTestId('official-reply-history')).toContainText(REPLY_1);
      await expect(p3.getByTestId('issue-detail')).not.toContainText('Ramesh');
      await expect(p3.getByTestId('official-reply-tags').locator('li')).toHaveCount(2); // the console keeps the ticked tags for the next version
    } finally { await ctx2.close(); }

    // 5. the moderator sees the held version (only a moderator can) and removes it; the public page is unchanged
    expect((await request.get(`${API}/representatives/moderation/queue`, { headers: bearer(s.rep.token) })).status()).toBe(403);
    const ctx3 = await browser.newContext();
    try {
      const pm = await ctx3.newPage();
      await startOnCivicTab(pm, 'roles');
      await openCivicAs(pm, s.mod.token);
      await pm.getByTestId('console-tab-moderator').click();
      const item = pm.getByTestId('rep-mod-item').filter({ hasText: 'Ramesh' });
      await expect(item).toHaveCount(1);
      await item.getByLabel('Reason for removing').fill('names a private person');
      await item.getByTestId('rep-mod-remove').click();
      await expect(pm.getByTestId('rep-mod-item').filter({ hasText: 'Ramesh' })).toHaveCount(0);
    } finally { await ctx3.close(); }
    const end = await (await request.get(`${API}/issues/${s.id}`)).json();
    expect(end.official_reply).toMatchObject({ version: 2 });
    expect(end.status).toBe(before.status);
    expect(strip(end)).toEqual(strip(before));
    expect(await feedIds(request, s.tag)).toEqual(orderBefore);
  });

  test('@E2E-160 a representative of another constituency and a citizen are refused; the console explains it', async ({ page, request }) => {
    const s = await setup(request);
    const other = await seedPerson(request, [{ role: 'politician', jurisdiction: 'NOT-THIS-SEAT-' + uniq().slice(0, 4) }]);
    const refused = await request.post(`${API}/representatives/issues/${s.id}/reply`, { headers: bearer(other.token), data: { text: REPLY_1 } });
    expect(refused.status()).toBe(403);
    expect((await request.post(`${API}/representatives/issues/${s.id}/reply`, { headers: bearer(s.reporter.token), data: { text: REPLY_1 } })).status()).toBe(403);
    await openCivicAs(page, other.token);
    await page.getByTestId('console-tab-politician').click();
    await page.getByTestId('pc-issue').fill(s.id);
    await page.getByTestId('pc-load').click();
    await page.getByTestId('pc-text').fill(REPLY_1);
    await page.getByTestId('pc-save').click();
    await expect(page.getByTestId('civic-error')).toContainText(/outside your constituency/);
    expect((await (await request.get(`${API}/issues/${s.id}`)).json()).official_reply ?? null).toBeNull();
  });

  test('@E2E-160 Telugu: the labelled reply, tags and console read in Telugu, with no overflow and no serious axe issues', async ({ page, request, browser }) => {
    const s = await setup(request);
    const posted = await request.post(`${API}/representatives/issues/${s.id}/reply`, { headers: bearer(s.rep.token), data: { text: REPLY_1, scheme_tags: ['pmgsy'] } });
    expect(posted.status(), await posted.text()).toBe(201);
    await openCivicAs(page, s.rep.token, 'te');
    await page.getByTestId('console-tab-politician').click();
    await expect(page.getByTestId('politician-console')).toContainText('అధికారిక సమాధానం');
    await page.getByTestId('pc-issue').fill(s.id);
    await page.getByTestId('pc-load').click();
    await expect(page.getByTestId('pc-tag-pmgsy')).toBeVisible();
    expect(await serious(page, '[data-testid=politician-console]')).toEqual([]);
    const ctx = await browser.newContext();
    try {
      const p2 = await ctx.newPage();
      await openCivicAs(p2, (await seedPerson(request)).token, 'te');
      await openIssue(p2, s.tag);
      await expect(p2.getByTestId('official-reply')).toContainText('ఎన్నికైన ప్రజాప్రతినిధి అధికారిక సమాధానం');
      await expect(p2.getByTestId('official-reply-tags')).toContainText('గ్రామ సడక్ యోజన');
      await expect(p2.getByTestId('official-reply-text')).toHaveText(REPLY_1);
      expect(await serious(p2, '[data-testid=issue-detail]')).toEqual([]);
      await noOverflow(p2);
    } finally { await ctx.close(); }
  });
});
