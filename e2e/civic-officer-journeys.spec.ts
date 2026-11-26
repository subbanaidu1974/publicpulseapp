import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, bearer, enrolAdmin, openCivicAs, seedPerson, uniq, type Seeded, type Totp } from './civic-seed';
import { startOnCivicTab } from './civic-helpers';
test.beforeEach(async ({ page }) => { await startOnCivicTab(page, 'roles'); });

/**
 * E2E-156 (S-141): an officer applies in the browser with an allow-listed e-mail domain and a letter, proves the address with the e-mailed
 * code, admin 1 checks the letter (TOTP), admin 2 approves through dual control (TOTP), and the officer sees the console. An off-list domain is
 * refused and nothing is stored; nobody approves their own application or request. Real server, real roles through the guarded e2e seed route;
 * the only shortcut is the one-time e-mail code, which the dev mailer hands back (CIVIC_EXPOSE_DEV_MAIL=1) instead of a real inbox.
 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const serious = async (page: Page, root: string) => (await new AxeBuilder({ page }).include(root).withTags(TAGS).analyze()).violations
  .filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
const DEPT = 'Rural Water Supply';

const emailFor = () => `officer.${uniq()}@ap.gov.in`;

async function fillForm(page: Page, email: string, name = 'Venkata Rao Test') {
  await page.getByTestId('officer-apply-open').click();
  await expect(page.getByTestId('oa-domains')).toContainText('gov.in');
  await page.getByTestId('oa-name').fill(name);
  await page.getByTestId('oa-dept').selectOption(DEPT);
  await page.getByTestId('oa-desig').fill('Assistant Engineer');
  await page.getByTestId('oa-email').fill(email);
  await page.getByTestId('oa-letter').setInputFiles({ name: 'posting-order.png', mimeType: 'image/png', buffer: PNG });
}
/** Submit and return what the server answered (the dev mailer's code is in it). */
async function submit(page: Page) {
  const answered = page.waitForResponse((r) => r.url().endsWith('/officers/applications') && r.request().method() === 'POST');
  await page.getByTestId('oa-submit').click();
  const res = await answered;
  return { status: res.status(), body: (await res.json()) as { id?: string; code?: string; email_confirmation?: string; dev_email_code?: string } };
}

/** An application made through the API (letter upload and form), confirmed or not; used where the browser part of the journey is elsewhere. */
async function applyByApi(request: APIRequestContext, person: Seeded, email: string, confirm: boolean) {
  const up = await request.post(`${API}/issues/media`, { headers: { ...bearer(person.token), 'content-type': 'image/png' }, data: PNG });
  expect(up.status()).toBe(201);
  const r = await request.post(`${API}/officers/applications`, { headers: bearer(person.token), data: { full_name: 'Self Applicant Test', department: DEPT, official_email: email, letter_ref: (await up.json()).ref } });
  expect(r.status(), await r.text()).toBe(201);
  const j = await r.json();
  expect(j.dev_email_code).toMatch(/^\d{6}$/);
  if (confirm) expect((await request.post(`${API}/officers/applications/${j.id}/email/confirm`, { headers: bearer(person.token), data: { code: j.dev_email_code } })).status()).toBe(200);
  return j.id as string;
}

async function adminPage(page: Page, admin: Seeded, lang: 'en' | 'te' = 'en') {
  await openCivicAs(page, admin.token, lang);
  await page.getByTestId('console-tab-admin').click();
  await expect(page.getByTestId('officer-queue')).toBeVisible();
}

test.describe('E2E-156 verified officer onboarding', () => {
  test('@E2E-156 apply with an allow-listed domain and a letter, confirm the e-mail, admin 1 verifies the letter, admin 2 approves, the officer sees the console', async ({ page, request, browser }) => {
    test.setTimeout(90_000);
    const applicant = await seedPerson(request);
    const a1 = await seedPerson(request, [{ role: 'admin' }]);
    const a2 = await seedPerson(request, [{ role: 'admin' }]);
    const totp1: Totp = await enrolAdmin(request, a1.token);
    const totp2: Totp = await enrolAdmin(request, a2.token);
    const email = emailFor();

    // 1. the applicant has no console yet; an e-mail outside the allow-list is refused and nothing is stored
    await openCivicAs(page, applicant.token);
    await expect(page.getByTestId('console-tab-officer')).toHaveCount(0);
    await fillForm(page, 'someone.' + uniq() + '@gmail.com');
    expect((await submit(page)).status).toBe(422);
    await expect(page.getByTestId('civic-error')).toContainText(/not on the official list/);
    expect((await (await request.get(`${API}/officers/applications/mine`, { headers: bearer(applicant.token) })).json()).applications).toHaveLength(0);
    await page.getByTestId('oa-email').fill('x@evilgov.in'); // a look-alike is not a subdomain of gov.in
    expect((await submit(page)).status).toBe(422);

    // 2. an allow-listed address and the letter: the application is stored, the code goes to the official address
    await page.getByTestId('oa-email').fill(email);
    const sent = await submit(page);
    expect(sent.status).toBe(201);
    expect(sent.body.email_confirmation).toBe('sent');
    await expect(page.getByTestId('oa-msg')).toBeVisible();
    await expect(page.getByTestId('officer-app-status')).toContainText('Waiting for the letter check');
    await expect(page.getByTestId('officer-app-mail')).toContainText('not confirmed');
    expect(await serious(page, '[data-testid=officer-apply]')).toEqual([]);
    await noOverflow(page);

    // 3. admin 1 sees it, but cannot send it on until the applicant has proven the address
    const ctx1 = await browser.newContext();
    try {
      const p1 = await ctx1.newPage();
      await startOnCivicTab(p1, 'roles');
      await adminPage(p1, a1);
      const row = p1.getByTestId('oq-item').filter({ hasText: email });
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('oq-mail')).toContainText('not confirmed');
      await row.getByTestId('oq-checked').check();
      await p1.getByTestId('oq-totp').fill('123456');
      await expect(row.getByTestId('oq-verify')).toBeDisabled(); // even with a code typed: the e-mail is not proven (the API refuses too, tests/civic/officers.test.ts)
      await ctx1.close();

      // 4. the applicant types a wrong code, then the right one
      await page.getByTestId('oa-mailcode').fill(sent.body.dev_email_code === '000000' ? '111111' : '000000');
      await page.getByTestId('oa-mailconfirm').click();
      await expect(page.getByTestId('civic-error')).toContainText(/not right/);
      await page.getByTestId('oa-mailcode').fill(sent.body.dev_email_code!);
      await page.getByTestId('oa-mailconfirm').click();
      await expect(page.getByTestId('oa-msg')).toContainText(/confirmed/);
      await expect(page.getByTestId('officer-app-mail')).toContainText('E-mail confirmed');
      await expect(page.getByTestId('oa-mailcode')).toHaveCount(0);
    } finally { await ctx1.close().catch(() => undefined); }

    // 5. admin 1 now sees "e-mail confirmed", opens the letter, ticks the check and sends it for second approval with a TOTP code
    const ctx2 = await browser.newContext();
    try {
      const p1 = await ctx2.newPage();
      await startOnCivicTab(p1, 'roles');
      await adminPage(p1, a1);
      const row = p1.getByTestId('oq-item').filter({ hasText: email });
      await expect(row.getByTestId('oq-mail')).toContainText('confirmed by the applicant');
      await row.getByTestId('oq-show').click();
      await expect(row.getByTestId('oq-letter')).toBeVisible();
      await row.getByTestId('oq-checked').check();
      await p1.getByTestId('oq-totp').fill(await totp1.next());
      await row.getByTestId('oq-verify').click();
      await expect(p1.getByTestId('oq-msg')).toContainText(/second approval/);
      await expect(p1.getByTestId('oq-item').filter({ hasText: email }).getByTestId('oq-awaiting')).toBeVisible();
      // nobody holds the role yet, and admin 1 cannot approve what admin 1 filed
      expect((await (await request.get(`${API}/admin/me`, { headers: bearer(applicant.token) })).json()).roles).toEqual([]);
      await adminPage(p1, a1); // reopen: the role-request list was loaded before the application was sent on
      const mine = p1.getByTestId('rr-item').filter({ hasText: applicant.personId });
      await expect(mine).toHaveCount(1);
      await expect(mine.getByTestId('rr-approve')).toBeDisabled();
      const reqId = (await (await request.get(`${API}/admin/roles/requests`, { headers: bearer(a1.token) })).json()).requests.find((r: { person_id: string }) => r.person_id === applicant.personId).id;
      const self = await request.post(`${API}/admin/roles/requests/${reqId}/approve`, { headers: { ...bearer(a1.token), 'x-totp-code': await totp1.next() } });
      expect(self.status()).toBe(403);
      expect((await self.json()).code).toBe('dual_control');
    } finally { await ctx2.close(); }

    // 6. admin 2 approves with their own code
    const ctx3 = await browser.newContext();
    try {
      const p2 = await ctx3.newPage();
      await startOnCivicTab(p2, 'roles');
      await openCivicAs(p2, a2.token);
      await p2.getByTestId('console-tab-admin').click();
      const row = p2.getByTestId('rr-item').filter({ hasText: applicant.personId });
      await expect(row).toHaveCount(1);
      await p2.getByTestId('rr-totp').fill(await totp2.next());
      await row.getByTestId('rr-approve').click();
      await expect(p2.getByTestId('rr-msg')).toContainText(/recorded/);
    } finally { await ctx3.close(); }

    // 7. the officer sees the console and the approved status
    expect((await (await request.get(`${API}/admin/me`, { headers: bearer(applicant.token) })).json()).roles).toEqual(['officer']);
    await openCivicAs(page, applicant.token); // a fresh load of the Civic tab
    await expect(page.getByTestId('console-tab-officer')).toBeVisible();
    await expect(page.getByTestId('console-tab-admin')).toHaveCount(0);
    await expect(page.getByTestId('officer-app-status')).toContainText('Approved');
    await page.getByTestId('console-tab-officer').click();
    await expect(page.getByTestId('officer-scope')).toBeVisible();
    const done = (await (await request.get(`${API}/officers/applications/mine`, { headers: bearer(applicant.token) })).json()).applications[0];
    expect(done).toMatchObject({ status: 'approved', letter_checked: true, email_confirmed: true });
    expect(JSON.stringify(done)).not.toContain(email);
  });

  test('@E2E-156 nobody approves their own application: an admin applicant cannot verify it, and cannot approve the request another admin files', async ({ page, request, browser }) => {
    const self = await seedPerson(request, [{ role: 'admin' }]);
    const other = await seedPerson(request, [{ role: 'admin' }]);
    const totpSelf = await enrolAdmin(request, self.token);
    const totpOther = await enrolAdmin(request, other.token);
    const email = emailFor();
    const appId = await applyByApi(request, self, email, true);

    await adminPage(page, self);
    const row = page.getByTestId('oq-item').filter({ hasText: email });
    await expect(row).toHaveCount(1);
    await row.getByTestId('oq-checked').check();
    await page.getByTestId('oq-totp').fill(await totpSelf.next());
    await row.getByTestId('oq-verify').click();
    await expect(page.getByTestId('civic-error')).toContainText(/for yourself/);
    expect((await (await request.get(`${API}/admin/me`, { headers: bearer(self.token) })).json()).roles).not.toContain('officer');

    // a different admin files it; the applicant (an admin) still cannot approve the request
    const v = await request.post(`${API}/officers/admin/applications/${appId}/verify`, { headers: { ...bearer(other.token), 'x-totp-code': await totpOther.next() }, data: { letter_checked: true } });
    expect(v.status(), await v.text()).toBe(201);
    const approve = await request.post(`${API}/admin/roles/requests/${(await v.json()).role_request_id}/approve`, { headers: { ...bearer(self.token), 'x-totp-code': await totpSelf.next() } });
    expect(approve.status()).toBe(403);
    expect((await approve.json()).code).toBe('self_grant');
    const ctx = await browser.newContext();
    try {
      const p2 = await ctx.newPage();
      await startOnCivicTab(p2, 'roles');
      await openCivicAs(p2, self.token);
      await p2.getByTestId('console-tab-admin').click();
      const rr = p2.getByTestId('rr-item').filter({ hasText: self.personId });
      await expect(rr).toHaveCount(1);
      await expect(rr.getByTestId('rr-approve')).toBeDisabled();
    } finally { await ctx.close(); }
    expect((await (await request.get(`${API}/admin/me`, { headers: bearer(self.token) })).json()).roles).not.toContain('officer');
  });

  test('@E2E-156 Telugu spot check: the application form, the e-mail proof and the admin queue read in Telugu, no overflow, no serious axe issues', async ({ page, request, browser }) => {
    const applicant = await seedPerson(request);
    const a1 = await seedPerson(request, [{ role: 'admin' }]);
    const email = emailFor();
    await openCivicAs(page, applicant.token, 'te');
    await page.getByTestId('officer-apply-open').click();
    await expect(page.getByTestId('officer-apply')).toContainText('ధృవీకరించిన అధికారి దరఖాస్తు');
    await expect(page.getByTestId('oa-domains')).toContainText('gov.in');
    await page.getByTestId('oa-email').fill('someone@gmail.com');
    await page.getByTestId('oa-name').fill('Venkata Rao Test');
    await page.getByTestId('oa-dept').selectOption(DEPT);
    await page.getByTestId('oa-letter').setInputFiles({ name: 'posting-order.png', mimeType: 'image/png', buffer: PNG });
    expect((await submit(page)).status).toBe(422);
    await expect(page.getByTestId('civic-error')).toContainText('అధికారిక జాబితాలో లేదు');
    await page.getByTestId('oa-email').fill(email);
    expect((await submit(page)).status).toBe(201);
    await expect(page.getByTestId('oa-mailcode')).toBeVisible();
    await expect(page.getByTestId('officer-app-mail')).toContainText('ఈ-మెయిల్ ఇంకా నిర్ధారించలేదు');
    expect(await serious(page, '[data-testid=officer-apply]')).toEqual([]);
    await noOverflow(page);
    const ctx = await browser.newContext();
    try {
      const p1 = await ctx.newPage();
      await startOnCivicTab(p1, 'roles');
      await adminPage(p1, a1, 'te');
      const row = p1.getByTestId('oq-item').filter({ hasText: email });
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('oq-mail')).toContainText('ఈ-మెయిల్ ఇంకా నిర్ధారించలేదు');
      expect(await serious(p1, '[data-testid=officer-queue]')).toEqual([]);
      await noOverflow(p1);
    } finally { await ctx.close(); }
  });
});
