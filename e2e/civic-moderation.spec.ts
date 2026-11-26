import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, FAULT, bearer, findVillage, openCivicAs, report, seedPerson, uniq } from './civic-seed';
import { startOnCivicTab } from './civic-helpers';
test.beforeEach(async ({ page }) => { await startOnCivicTab(page, 'roles'); });

// Real server: moderators are real core roles created through the test-only seeding route; held reports come from the real moderation rules.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const serious = async (page: Page) => (await new AxeBuilder({ page }).include('[data-testid=civic-home]').withTags(TAGS).analyze()).violations
  .filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);

const held = (tag: string) => `Mr Ramesh Kumar took a bribe ${tag} ${uniq()} ${uniq()} ${uniq()}`; // unique words: similar visible reports would be merged
const item = (page: Page, tag: string) => page.getByTestId('mod-item').filter({ hasText: tag });

test.describe('moderation (S-142)', () => {
  test('@E2E-157 queue shows rule reasons and metrics; approve, reject, escalate and appeal uphold hit the real server', async ({ page, request }) => {
    const village = await findVillage(request, 'Kolluru');
    const mod = await seedPerson(request, [{ role: 'moderator' }]);
    const reporter = await seedPerson(request);
    const t = { a: `e2ea${uniq()}`, b: `e2eb${uniq()}`, c: `e2ec${uniq()}`, d: `e2ed${uniq()}` };
    const ids: Record<string, string> = {};
    for (const [k, tag] of Object.entries(t)) {
      const r = await report(request, reporter.token, { category: k === 'a' ? 'law_order' : 'water', village: village.lgd, text: held(tag) });
      expect(r.held, `${k} should be held by the real rules`).toBe(true);
      ids[k] = r.id;
    }
    const ap = await request.post(`${API}/issues/${ids.c}/appeal`, { headers: bearer(reporter.token), data: { reason: 'I did not name anyone' } });
    expect(ap.status()).toBe(201);

    await openCivicAs(page, mod.token);
    await page.getByTestId('console-tab-moderator').click();
    await expect(page.getByTestId('mod-hold-rate')).toHaveText(/%$/);
    await expect(page.getByTestId('mod-fp-rate')).toBeVisible();
    await expect(page.getByTestId('mod-lex-version')).toBeVisible();
    await expect(item(page, t.a).getByTestId('mod-reasons')).toContainText(/\w/);
    await expect(item(page, t.c).getByTestId('mod-appeal')).toContainText('I did not name anyone');
    expect(await serious(page)).toEqual([]);

    await item(page, t.a).getByTestId('mod-approve').click();
    await expect(item(page, t.a)).toHaveCount(0);
    expect((await (await request.get(`${API}/issues/${ids.a}`)).json()).id).toBe(ids.a); // released: now public
    await item(page, t.b).getByTestId('mod-reject').click();
    await expect(item(page, t.b)).toHaveCount(0);
    expect((await request.get(`${API}/issues/${ids.b}`)).status()).toBe(404); // taken down: not public
    await item(page, t.c).getByTestId('mod-uphold').click();
    await expect(item(page, t.c).getByTestId('mod-appeal')).toHaveCount(0); // appeal decided; the hold itself stays
    expect((await request.get(`${API}/issues/${ids.c}`)).status()).toBe(404);
    await item(page, t.d).getByTestId('mod-escalate').click();
    await expect(item(page, t.d)).toContainText(/Escalated to an admin/); // still held, now an admin decision
    await expect(item(page, t.d).getByTestId('mod-escalate')).toHaveCount(0);

    // escalated reports are an admin decision: the moderator sees them in the Escalated list and is told so
    await page.getByTestId('mq-status').selectOption('escalated');
    await expect(item(page, t.d)).toHaveCount(1);
    await item(page, t.d).getByTestId('mod-approve').click();
    await expect(page.getByTestId('civic-error')).toContainText(/Only an admin/);
    const admin = await seedPerson(request, [{ role: 'admin' }]);
    const done = await request.post(`${API}/issues/${ids.d}/moderate`, { headers: bearer(admin.token), data: { decision: 'approve' } });
    expect(done.ok(), await done.text()).toBe(true);
  });

  test('@E2E-157 lexicon: propose, own proposal cannot be reviewed, a second moderator approves and the version moves', async ({ page, browser, request }) => {
    const m1 = await seedPerson(request, [{ role: 'moderator' }]);
    const m2 = await seedPerson(request, [{ role: 'moderator' }]);
    const term = `zzterm${uniq()}`;
    const before = (await (await request.get(`${API}/issues/moderation/lexicon`, { headers: bearer(m1.token) })).json()).version as number;

    await openCivicAs(page, m1.token, 'te');
    await page.getByTestId('console-tab-moderator').click();
    await page.getByTestId('lx-term').fill(term);
    await page.getByTestId('lx-add').click();
    await expect(page.getByTestId('lx-msg')).toBeVisible();
    const mine = page.getByTestId('lx-item').filter({ hasText: term });
    await expect(mine.getByTestId('lx-meta')).toContainText('0/1');
    await mine.getByTestId('lx-accept').click();
    await expect(page.getByTestId('civic-error')).toContainText(/మీ స్వంత ప్రతిపాదన/); // independent review is enforced and explained
    await page.getByTestId('lx-term').fill(term);
    await page.getByTestId('lx-add').click();
    await expect(page.getByTestId('civic-error')).toContainText(/అదే ప్రతిపాదన/); // duplicate proposal
    expect(await serious(page)).toEqual([]);

    const ctx = await browser.newContext();
    try {
      const p2 = await ctx.newPage();
      await startOnCivicTab(p2, 'roles');
      await openCivicAs(p2, m2.token);
      await p2.getByTestId('console-tab-moderator').click();
      await p2.getByTestId('lx-item').filter({ hasText: term }).getByTestId('lx-accept').click();
      await expect(p2.getByTestId('lx-msg')).toContainText(/Applied/);
    } finally { await ctx.close(); }
    const after = (await (await request.get(`${API}/issues/moderation/lexicon`, { headers: bearer(m1.token) })).json()).version as number;
    expect(after).toBe(before + 1);
  });

  test('@E2E-157 a plain citizen gets the 403 state from the real queue and lexicon routes', async ({ page, request }) => {
    const citizen = await seedPerson(request);
    // the client is made to believe it is a moderator (fault injection on /admin/me only); the real server still refuses
    await page.route(`${FAULT}/admin/me`, (r) => r.fulfill({ json: { person_id: citizen.personId, roles: ['moderator'], mfa: { enrolled: false, confirmed: false } } }));
    await openCivicAs(page, citizen.token);
    await page.getByTestId('console-tab-moderator').click();
    await expect(page.getByTestId('mod-queue').getByTestId('gate-403')).toBeVisible();
    await expect(page.getByTestId('mod-lexicon').getByTestId('gate-403')).toBeVisible();
  });
});
