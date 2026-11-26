import { test, expect } from '@playwright/test';
import { API, bearer, findVillage, openCivicAs, report, seedPerson, uniq } from './civic-seed';
import { startOnCivicTab } from './civic-helpers';
test.beforeEach(async ({ page }) => { await startOnCivicTab(page, 'mine'); });

// Real server: the held report comes from the real moderation rules, the owner view and the appeal are the real routes, and the moderator decision is the real one.
const held = (tag: string) => `Mr Ramesh Kumar took a bribe ${tag} ${uniq()} ${uniq()} ${uniq()}`; // unique words: similar visible reports would be merged

test.describe('my reports and appeal (S-157)', () => {
  test('@E2E-181 a held report appears under My reports with the reason class, the owner appeals, a moderator releases it, and it becomes public', async ({ page, request }) => {
    const village = await findVillage(request, 'Kolluru');
    const mod = await seedPerson(request, [{ role: 'moderator' }]);
    const owner = await seedPerson(request);
    const other = await seedPerson(request);
    const tag = `e2eown${uniq()}`;
    const mine = await report(request, owner.token, { category: 'water', village: village.lgd, text: held(tag) });
    expect(mine.held, 'the real rules hold this text').toBe(true);
    const visible = await report(request, owner.token, { category: 'roads', village: village.lgd, text: `Pothole ${tag} ${uniq()} ${uniq()} ${uniq()} near the school road` });
    const theirs = await report(request, other.token, { category: 'water', village: village.lgd, text: held(`e2eoth${uniq()}`) });

    await openCivicAs(page, owner.token);
    const list = page.getByTestId('my-reports');
    await expect(list).toBeVisible();
    await expect(list.getByTestId('my-report-row')).toHaveCount(2); // the other person's held report is not here
    const row = list.getByTestId('my-report-row').filter({ hasText: tag }).filter({ has: page.getByTestId('my-report-state') });
    await expect(row.getByTestId('my-report-state')).toContainText(/Waiting for review/);
    await expect(list.locator('[data-moderation=ok]')).toHaveCount(1);
    await row.getByTestId('my-report-open').click();

    const detail = page.getByTestId('issue-detail');
    await expect(detail.getByTestId('owner-moderation-state')).toHaveText('Waiting for review');
    await expect(detail.getByTestId('owner-moderation-classes')).toContainText(/name a person/);
    await expect(detail.getByTestId('issue-metoo')).toHaveCount(0);
    await detail.getByLabel(/Why should this report be shown/).fill('It names a place, not a person');
    await detail.getByRole('button', { name: 'Appeal' }).click();
    await expect(detail.getByTestId('issue-msg')).toHaveText(/Appeal sent/);
    await expect(detail.getByTestId('owner-appeal-state')).toContainText(/waiting for a human reviewer/);
    await expect(detail.getByTestId('issue-appeal')).toHaveCount(0); // one appeal at a time
    expect((await request.get(`${API}/issues/${mine.id}`)).status()).toBe(404); // still not public

    // the moderator sees the appeal and approves
    const q = await (await request.get(`${API}/issues/moderation/queue?status=held`, { headers: bearer(mod.token) })).json();
    expect(JSON.stringify(q)).toContain(mine.id);
    const done = await request.post(`${API}/issues/${mine.id}/moderate`, { headers: bearer(mod.token), data: { decision: 'approve' } });
    expect(done.ok(), await done.text()).toBe(true);

    await page.getByTestId('issue-back').click();
    await expect(list.locator('[data-moderation=held]')).toHaveCount(0);
    await expect(list.locator('[data-moderation=ok]')).toHaveCount(2);
    expect((await request.get(`${API}/issues/${mine.id}`)).status()).toBe(200);
    // never someone else's
    expect((await request.get(`${API}/issues/mine/${theirs.id}`, { headers: bearer(owner.token) })).status()).toBe(404);
    expect((await request.get(`${API}/issues/mine/${visible.id}`, { headers: bearer(owner.token) })).status()).toBe(200);
  });

  test('@E2E-181 a removed report can be appealed, the page is available in Telugu, and an upheld hold can be appealed again', async ({ page, request }) => {
    const village = await findVillage(request, 'Kolluru');
    const mod = await seedPerson(request, [{ role: 'moderator' }]);
    const owner = await seedPerson(request);
    const tag = `e2erm${uniq()}`;
    const r = await report(request, owner.token, { category: 'water', village: village.lgd, text: held(tag) });
    expect((await request.post(`${API}/issues/${r.id}/moderate`, { headers: bearer(mod.token), data: { decision: 'reject' } })).ok()).toBe(true);

    await openCivicAs(page, owner.token, 'te');
    const list = page.getByTestId('my-reports');
    await expect(list).toContainText('నా నివేదికలు');
    const row = list.getByTestId('my-report-row').filter({ hasText: tag });
    await expect(row.getByTestId('my-report-state')).toContainText('తొలగించబడింది');
    await row.getByTestId('my-report-open').click();
    const detail = page.getByTestId('issue-detail');
    await expect(detail.getByTestId('owner-moderation-state')).toHaveText('తొలగించబడింది');
    await detail.locator('#ia-reason').fill('ఇది నిజమైన సమస్య');
    await detail.getByTestId('issue-appeal').getByRole('button').click();
    await expect(detail.getByTestId('owner-appeal-state')).toContainText('మానవ సమీక్షకుని');

    expect((await request.post(`${API}/issues/${r.id}/moderate`, { headers: bearer(mod.token), data: { decision: 'uphold' } })).ok()).toBe(true);
    await page.getByTestId('issue-back').click();
    await list.getByTestId('my-report-row').filter({ hasText: tag }).getByTestId('my-report-open').click();
    await expect(page.getByTestId('issue-appeal')).toBeVisible(); // can appeal again
    await expect(page.getByTestId('owner-appeal-state')).toContainText('నిలిపివేతలోనే');
  });
});
