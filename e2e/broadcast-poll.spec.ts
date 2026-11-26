import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, bearer } from './civic-seed';
import { openCivic } from './civic-helpers';

// A broadcast poll blocks every signed-in person while it is open, so each test closes what it opened (and the suite closes any leftovers
// first). Keep polls open for seconds, not minutes, when running the whole browser suite in parallel.
test.describe.configure({ mode: 'serial' });
const B = `${API}/broadcast`;

async function adminToken(request: APIRequestContext): Promise<string> {
  const r = await request.post(`${API}/demo/login`, { data: { persona: 'admin' } });
  return (await r.json()).token as string;
}
async function closeAll(request: APIRequestContext, token: string) {
  const l = await (await request.get(`${B}/admin`, { headers: bearer(token) })).json();
  for (const p of l.polls ?? []) if (p.status === 'open' || p.status === 'scheduled') await request.post(`${B}/admin/${p.id}/close`, { headers: bearer(token) });
}
async function newUser(request: APIRequestContext): Promise<string> {
  const email = `poll.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.org`;
  const otp = (await (await request.post(`${API}/identity/signup/email/request`, { data: { email } })).json()).dev_otp as string;
  return (await (await request.post(`${API}/identity/signup/email/verify`, { data: { email, otp, pin: '4821', consent_version: 'v1' } })).json()).token as string;
}
async function asUser(page: Page, token: string, lang: 'en' | 'te' = 'en') {
  await page.addInitScript(([t, l]) => { try { sessionStorage.setItem('civic-token', t as string); localStorage.setItem('pp-lang', l as string); } catch { /* ignore */ } }, [token, lang]);
  await page.goto('/');
}
const POLL = {
  title_en: 'Water supply in your village', title_te: 'మీ గ్రామంలో నీటి సరఫరా', intro_en: 'Two quick questions.',
  questions: [
    { kind: 'single', text_en: 'How reliable is your drinking water?', text_te: 'మీ తాగునీరు ఎంత నమ్మదగినది?', options: [{ label_en: 'Reliable', label_te: 'నమ్మదగినది' }, { label_en: 'Not reliable', label_te: 'నమ్మదగినది కాదు' }] },
    { kind: 'multi', max_select: 2, text_en: 'Which services need work?', options: [{ label_en: 'Roads' }, { label_en: 'Water' }, { label_en: 'Power' }] },
  ],
};

test.describe('broadcast polls (S-185)', () => {
  test.beforeAll(async ({ request }) => { await closeAll(request, await adminToken(request)); });

  test('@E2E-199 an admin writes a poll on screen and pushes it; the open poll appears in the list and can be closed', async ({ page, request }) => {
    try {
      await openCivic(page);
      await page.getByTestId('demo-admin').click();
      await expect(page.getByTestId('civic-signed-in')).toBeVisible();
      await page.getByTestId('civic-tab-roles').click();
      await page.getByTestId('console-tab-admin').click();
      await page.getByTestId('polls-admin-link').click();
      const panel = page.getByTestId('polls-admin');
      await expect(panel).toBeVisible();
      await expect(page.getByTestId('pa-publish')).toBeDisabled(); // needs the confirmation tick
      await page.getByTestId('pa-title').fill('Road safety in your area');
      await page.getByTestId('pa-text-0').fill('Is the main road safe to walk at night?');
      await page.getByTestId('pa-options-0').fill('Yes | అవును\nNo | కాదు');
      await page.getByTestId('pa-confirm').check();
      await page.getByTestId('pa-publish').click();
      await expect(page.getByTestId('pa-msg')).toContainText('Poll opened');
      const item = page.getByTestId('pa-item').first();
      await expect(item).toHaveAttribute('data-status', 'open');
      await expect(page.getByTestId('poll-dialog')).toHaveCount(0); // the admin is never blocked
      await item.getByTestId('pa-close').click();
      await expect(item).toHaveAttribute('data-status', 'closed');
    } finally { await closeAll(request, await adminToken(request)); }
  });

  test('@E2E-199 a refused poll shows the reason (party choice) and nothing opens', async ({ page, request }) => {
    try {
      await openCivic(page);
      await page.getByTestId('demo-admin').click();
      await page.getByTestId('civic-tab-roles').click();
      await page.getByTestId('console-tab-admin').click();
      await page.getByTestId('polls-admin-link').click();
      await page.getByTestId('pa-title').fill('Next election mood');
      await page.getByTestId('pa-text-0').fill('Which party will you vote for?');
      await page.getByTestId('pa-options-0').fill('A\nB');
      await page.getByTestId('pa-confirm').check();
      await page.getByTestId('pa-publish').click();
      await expect(page.getByTestId('civic-error')).toContainText('party or candidate');
      const l = await (await request.get(`${B}/admin`, { headers: bearer(await adminToken(request)) })).json();
      expect(l.polls.filter((p: { status: string }) => p.status === 'open')).toHaveLength(0);
    } finally { await closeAll(request, await adminToken(request)); }
  });

  test('@E2E-200 a signed-in user is blocked by the poll until every question is answered, then reaches the app; a second user is blocked too', async ({ page, browser, request }) => {
    const admin = await adminToken(request);
    try {
      const u1 = await newUser(request), u2 = await newUser(request);
      const open = await request.post(`${B}/admin`, { headers: bearer(admin), data: POLL });
      expect(open.status()).toBe(201);

      await asUser(page, u1);
      const dlg = page.getByTestId('poll-dialog');
      await expect(dlg).toBeVisible();
      await expect(dlg).toHaveAttribute('aria-modal', 'true');
      await expect(page.getByTestId('poll-title')).toBeFocused();
      // everything behind is inert: the navigation cannot be used
      await expect(page.locator('main')).toHaveJSProperty('inert', false); // the <main> itself is not inert...
      expect(await page.evaluate(() => !!document.querySelector('[inert] main'))).toBe(true); // ...its wrapper is
      await page.keyboard.press('Escape');
      await expect(dlg).toBeVisible(); // cannot be dismissed
      const submit = page.getByTestId('poll-submit');
      await expect(submit).toBeDisabled();
      await page.getByTestId('poll-opt-0-0').check();
      await expect(submit).toBeDisabled(); // question 2 still open
      await expect(page.getByTestId('poll-progress')).toContainText('1 of 2');
      // multi choice: at most 2; a 'prefer not' pick replaces the others
      await page.getByTestId('poll-opt-1-0').check();
      await page.getByTestId('poll-opt-1-1').check();
      await page.getByTestId('poll-opt-1-2').click(); // refused: only two allowed
      await expect(page.getByTestId('poll-opt-1-2')).not.toBeChecked();
      await page.getByTestId('poll-opt-1-3').check(); // prefer not to say
      await expect(page.getByTestId('poll-opt-1-0')).not.toBeChecked();
      await expect(submit).toBeEnabled();
      await submit.click();
      await expect(dlg).toHaveCount(0);
      expect(await page.evaluate(() => !!document.querySelector('[inert]'))).toBe(false);
      await expect(page.getByTestId('nav-civic').or(page.getByRole('button', { name: /civic/i })).first()).toBeVisible();
      await page.reload();
      await expect(page.getByTestId('poll-dialog')).toHaveCount(0); // answered: never asked again

      const ctx2 = await browser.newContext(); const p2 = await ctx2.newPage();
      await asUser(p2, u2);
      await expect(p2.getByTestId('poll-dialog')).toBeVisible();
      await ctx2.close();
    } finally { await closeAll(request, admin); }
  });

  test('@E2E-200 the poll shows in Telugu for a Telugu user, is axe-clean, and closing it frees a blocked user without a reload', async ({ page, request }) => {
    const admin = await adminToken(request);
    try {
      const u = await newUser(request);
      await request.post(`${B}/admin`, { headers: bearer(admin), data: POLL });
      await asUser(page, u, 'te');
      const dlg = page.getByTestId('poll-dialog');
      await expect(dlg).toBeVisible();
      await expect(page.getByTestId('poll-title')).toHaveText('మీ గ్రామంలో నీటి సరఫరా');
      await expect(dlg).toContainText('చెప్పదలచుకోలేదు');
      const scan = await new AxeBuilder({ page }).include('[data-testid="poll-dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      expect(scan.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      await closeAll(request, admin);
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); // the gate re-checks on focus; no reload needed
      await expect(dlg).toHaveCount(0);
    } finally { await closeAll(request, admin); }
  });

  test('@E2E-200 results stay hidden below ten answers; an ordinary user cannot reach the admin routes', async ({ request }) => {
    const admin = await adminToken(request);
    try {
      const u = await newUser(request);
      const id = (await (await request.post(`${B}/admin`, { headers: bearer(admin), data: POLL })).json()).id as string;
      expect((await request.get(`${B}/admin`, { headers: bearer(u) })).status()).toBe(403);
      expect((await request.post(`${B}/admin`, { headers: bearer(u), data: POLL })).status()).toBe(403);
      expect((await request.post(`${B}/${id}/answer`, { headers: bearer(u), data: { answers: [[0]] } })).status()).toBe(400);
      expect((await request.post(`${B}/${id}/answer`, { headers: bearer(u), data: { answers: [[0], [3]] } })).status()).toBe(200);
      const r = await (await request.get(`${B}/admin/${id}/results`, { headers: bearer(admin) })).json();
      expect(r).toMatchObject({ responses: 1, suppressed: true });
      expect(JSON.stringify(r.results)).not.toMatch(/"n":[1-9]/);
    } finally { await closeAll(request, admin); }
  });

  test('@E2E-201 an admin schedules a poll for tomorrow on screen: it is listed as scheduled, blocks nobody, and can be cancelled', async ({ page, request }) => {
    try {
      await openCivic(page);
      await page.getByTestId('demo-admin').click();
      await page.getByTestId('civic-tab-roles').click();
      await page.getByTestId('console-tab-admin').click();
      await page.getByTestId('polls-admin-link').click();
      await page.getByTestId('pa-title').fill('Tomorrow morning poll');
      await page.getByTestId('pa-text-0').fill('Is the bus service on time?');
      await page.getByTestId('pa-options-0').fill('Yes\nNo');
      const d = new Date(Date.now() + 86_400_000), p2 = (n: number) => String(n).padStart(2, '0');
      await page.getByTestId('pa-opens').fill(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T09:00`);
      await page.getByTestId('pa-confirm').check();
      await page.getByTestId('pa-publish').click();
      await expect(page.getByTestId('pa-msg')).toContainText('Poll scheduled for');
      const item = page.getByTestId('pa-item').first();
      await expect(item).toHaveAttribute('data-status', 'scheduled');
      const user = await newUser(request);
      expect((await (await request.get(`${B}/pending`, { headers: bearer(user) })).json()).poll).toBeNull();
      await item.getByTestId('pa-close').click();
      await expect(item).toHaveAttribute('data-status', 'closed');
    } finally { await closeAll(request, await adminToken(request)); }
  });

  test('@E2E-201 a poll scheduled a few seconds ahead appears on a page that is already open, without a reload', async ({ page, request }) => {
    const admin = await adminToken(request);
    try {
      const u = await newUser(request);
      const r = await request.post(`${B}/admin`, { headers: bearer(admin), data: { ...POLL, opens_at: new Date(Date.now() + 4000).toISOString() } });
      expect(r.status()).toBe(201);
      await asUser(page, u);
      await expect(page.getByTestId('poll-dialog')).toHaveCount(0);
      await page.waitForTimeout(4500);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByTestId('poll-dialog')).toBeVisible();
    } finally { await closeAll(request, admin); }
  });
});
