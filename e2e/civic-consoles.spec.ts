import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, FAULT, Totp, bearer, enrolAdmin, findVillage, freshText, openCivicAs, report, seedPerson, uniq } from './civic-seed';
import { startOnCivicTab } from './civic-helpers';
test.beforeEach(async ({ page }) => { await startOnCivicTab(page, 'roles'); });

// Real server for roles, the officer queue, role requests with TOTP and the audit log. Fault injection is marked and limited to
// responses a healthy server never gives (a believed-admin client, a 401 mid-session, a broken audit chain).
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const serious = async (page: Page) => (await new AxeBuilder({ page }).include('[data-testid=civic-home]').withTags(TAGS).analyze()).violations
  .filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);

test.describe('consoles gating', () => {
  test('@E2E-155 no console tabs for a citizen (real /admin/me returns no roles)', async ({ page, request }) => {
    const citizen = await seedPerson(request);
    const me = await (await request.get(`${API}/admin/me`, { headers: bearer(citizen.token) })).json();
    expect(me.roles).toEqual([]);
    await openCivicAs(page, citizen.token);
    await expect(page.getByTestId('consoles')).toHaveCount(0);
  });

  test('@E2E-155 officer tab only (no admin or moderator tab) for a real officer', async ({ page, request }) => {
    const officer = await seedPerson(request, [{ role: 'officer' }]);
    await openCivicAs(page, officer.token);
    await expect(page.getByTestId('console-tab-officer')).toBeVisible();
    await expect(page.getByTestId('console-tab-admin')).toHaveCount(0);
    await expect(page.getByTestId('console-tab-moderator')).toHaveCount(0);
  });

  test('@E2E-155 server 403 beats a client that believes it is admin (fault injection on /admin/me only)', async ({ page, request }) => {
    const citizen = await seedPerson(request);
    await page.route(`${FAULT}/admin/me`, (r) => r.fulfill({ json: { person_id: citizen.personId, roles: ['admin'], mfa: { enrolled: false, confirmed: false } } }));
    await openCivicAs(page, citizen.token);
    await page.getByTestId('console-tab-admin').click();
    await expect(page.getByTestId('jobs-status').getByTestId('gate-403')).toBeVisible(); // real GET /ops/jobs
    await expect(page.getByTestId('role-requests').getByTestId('gate-403')).toBeVisible(); // real GET /admin/roles/requests
  });

  test('@E2E-155 fault injection: a 401 mid-session shows the sign-in-again state', async ({ page, request }) => {
    const admin = await seedPerson(request, [{ role: 'admin' }]);
    await page.route(`${FAULT}/ops/jobs`, (r) => r.fulfill({ status: 401, json: { error: 'authentication required' } }));
    await openCivicAs(page, admin.token);
    await page.getByTestId('console-tab-admin').click();
    await expect(page.getByTestId('jobs-status').getByTestId('gate-401')).toBeVisible();
  });
});

test.describe('officer console (real queue)', () => {
  test('@E2E-155 queue, status change, reroute and public reply call the real server', async ({ page, request }) => {
    // A village of its own scopes the officer's queue to this test's report (core roles carry a jurisdiction, not a department). Not the scope
    // specs' village (Bhimavaram): they fill it with 100+ reports, which would push this one past the queue's 100-row page.
    const village = await findVillage(request, 'Kolluru');
    const tag = `e2eoff${uniq()}`;
    const reporter = await seedPerson(request);
    const officer = await seedPerson(request, [{ role: 'officer', jurisdiction: village.lgd }]);
    const made = await report(request, reporter.token, { category: 'welfare', village: village.lgd, text: freshText(tag) });

    await openCivicAs(page, officer.token);
    await page.getByTestId('console-tab-officer').click();
    const row = page.getByTestId('officer-item').filter({ hasText: tag });
    await expect(row).toHaveCount(1);
    await expect(page.getByTestId('officer-scope')).toContainText(village.lgd);
    await row.getByTestId('officer-manage').click();
    await page.getByTestId('oc-note').fill('Inspector sent');
    await page.getByTestId('oc-apply').click();
    await expect(page.getByTestId('oc-msg')).toContainText(/Updated/);
    await expect(page.getByTestId('officer-item').filter({ hasText: tag })).toContainText('Verified');
    await page.getByTestId('oc-reply').fill('Pump repair scheduled for Friday');
    await page.getByTestId('oc-post-reply').click();
    await expect(page.getByTestId('oc-msg')).toContainText(/posted/i);
    const pub = await (await request.get(`${API}/issues/${made.id}`)).json();
    expect(pub.status).toBe('Verified');
    expect(pub.officer_responses.map((r: { text: string }) => r.text)).toContain('Pump repair scheduled for Friday');
    expect(pub.timeline.some((e: { status: string }) => e.status === 'Verified')).toBe(true);
    await page.getByTestId('oc-dep').selectOption('Health');
    await page.getByTestId('oc-reroute').click();
    await expect(page.getByTestId('oc-msg')).toContainText(/other department/);
    expect((await (await request.get(`${API}/issues/${made.id}`)).json()).department).toBe('Health');
    expect(await serious(page)).toEqual([]);
  });

  test('@E2E-155 fault injection: an out-of-jurisdiction 403 is explained', async ({ page, request }) => {
    const village = await findVillage(request, 'Kolluru');
    const tag = `e2ejur${uniq()}`;
    const reporter = await seedPerson(request);
    // scoped to the village: an unscoped officer's queue is the whole platform's oldest 100 open reports, which this test's new report is not part of
    const officer = await seedPerson(request, [{ role: 'officer', jurisdiction: village.lgd }]);
    await report(request, reporter.token, { category: 'education', village: village.lgd, text: freshText(tag) });
    await page.route(/\/civic\/issues\/[^/]+\/transition$/, (r) => r.fulfill({ status: 403, json: { error: 'outside your jurisdiction', hint: 'out_of_jurisdiction' } }));
    await openCivicAs(page, officer.token);
    await page.getByTestId('console-tab-officer').click();
    await page.getByTestId('officer-item').filter({ hasText: tag }).getByTestId('officer-manage').click();
    await page.getByTestId('oc-apply').click();
    await expect(page.getByTestId('civic-error')).toContainText(/outside your department or area/);
  });
});

test.describe('admin console (real admin routes, TOTP)', () => {
  test('@E2E-155 TOTP enrolment shows secret and recovery codes once with a save-now notice, rejects a wrong code, accepts a right one', async ({ page, request }) => {
    const admin = await seedPerson(request, [{ role: 'admin' }]);
    await openCivicAs(page, admin.token);
    await page.getByTestId('console-tab-admin').click();
    await expect(page.getByTestId('mfa-state')).toContainText(/not set up/);
    await page.getByTestId('mfa-start').click();
    const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
    await expect(page.getByTestId('mfa-recovery')).toContainText(/only once/i);
    await expect(page.getByTestId('mfa-recovery-code')).toHaveCount(8);
    await expect(page.getByTestId('mfa-verify')).toBeDisabled();
    await page.getByTestId('mfa-code').fill('000000');
    await page.getByTestId('mfa-verify').click();
    await expect(page.getByTestId('civic-error')).toContainText(/not accepted/);
    await page.getByTestId('mfa-code').fill(await new Totp(secret).next());
    await page.getByTestId('mfa-verify').click();
    await expect(page.getByTestId('mfa-msg')).toContainText(/accepted/);
    await page.getByTestId('mfa-recovery-saved').click();
    await expect(page.getByTestId('mfa-recovery')).toHaveCount(0);
    await expect(page.getByTestId('mfa-state')).toContainText(/is on/);
    expect(await serious(page)).toEqual([]);
  });

  test('@E2E-155 dual control: request with a TOTP code, requester cannot approve, a second admin approves, the role is granted', async ({ page, request }) => {
    const a = await seedPerson(request, [{ role: 'admin' }]);
    const b = await seedPerson(request, [{ role: 'admin' }]);
    const target = await seedPerson(request);
    const totpB = await enrolAdmin(request, b.token);

    await openCivicAs(page, a.token);
    await page.getByTestId('console-tab-admin').click();
    await page.getByTestId('mfa-start').click();
    const totpA = new Totp((await page.getByTestId('mfa-secret').textContent())!.trim());
    await page.getByTestId('mfa-code').fill(await totpA.next());
    await page.getByTestId('mfa-verify').click();
    await expect(page.getByTestId('mfa-msg')).toBeVisible();
    await page.getByTestId('mfa-recovery-saved').click();

    // no code, no request
    await page.getByTestId('rr-person').fill(target.personId);
    await page.getByTestId('rr-reason').fill('Covers the Guntur desk');
    await expect(page.getByTestId('rr-submit')).toBeDisabled();
    await page.getByTestId('rr-totp').fill('000000');
    await page.getByTestId('rr-submit').click();
    await expect(page.getByTestId('civic-error')).toContainText(/not accepted or was already used/);
    await page.getByTestId('rr-person').fill(target.personId);
    await page.getByTestId('rr-reason').fill('Covers the Guntur desk');
    await page.getByTestId('rr-totp').fill(await totpA.next());
    await page.getByTestId('rr-submit').click();
    await expect(page.getByTestId('rr-msg')).toContainText(/created/);
    const mine = page.getByTestId('rr-item').filter({ hasText: target.personId });
    await expect(mine).toHaveCount(1);
    await expect(mine.getByTestId('rr-approve')).toBeDisabled(); // own request
    await expect(mine.getByTestId('rr-status')).toContainText(/Awaiting/);
    const reqId = (await (await request.get(`${API}/admin/roles/requests`, { headers: bearer(a.token) })).json()).requests.find((r: { person_id: string }) => r.person_id === target.personId).id;
    const self = await request.post(`${API}/admin/roles/requests/${reqId}/approve`, { headers: { ...bearer(a.token), 'x-totp-code': await totpA.next() } });
    expect(self.status()).toBe(403);
    expect((await self.json()).code).toBe('dual_control');
    expect((await (await request.get(`${API}/admin/me`, { headers: bearer(target.token) })).json()).roles).toEqual([]);

    // the second admin approves in the UI with their own code
    const ctx = await page.context().browser()!.newContext();
    try {
      const p2 = await ctx.newPage();
      await startOnCivicTab(p2, 'roles');
      await openCivicAs(p2, b.token);
      await p2.getByTestId('console-tab-admin').click();
      const row = p2.getByTestId('rr-item').filter({ hasText: target.personId });
      await expect(row).toHaveCount(1);
      await p2.getByTestId('rr-totp').fill(await totpB.next());
      await row.getByTestId('rr-approve').click();
      await expect(p2.getByTestId('rr-msg')).toContainText(/recorded/);
    } finally { await ctx.close(); }
    expect((await (await request.get(`${API}/admin/me`, { headers: bearer(target.token) })).json()).roles).toEqual(['officer']);
  });

  test('@E2E-155 jobs status, audit head and a passing verify on the real routes (Telugu, axe, no overflow)', async ({ page, request }) => {
    const admin = await seedPerson(request, [{ role: 'admin' }]);
    await openCivicAs(page, admin.token, 'te');
    await page.getByTestId('console-tab-admin').click();
    await expect(page.getByTestId('jobs-status')).toBeVisible();
    await expect(page.getByTestId('audit-head')).toContainText(/[0-9a-f]{16}/);
    await page.getByTestId('audit-verify').click();
    await expect(page.getByTestId('audit-verify-ok')).toBeVisible();
    expect(await serious(page)).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('@E2E-155 fault injection: a 409 from /audit/verify is shown as an alarm, and jobs alarms are shown', async ({ page, request }) => {
    const admin = await seedPerson(request, [{ role: 'admin' }]);
    await page.route(`${FAULT}/audit/verify`, (r) => r.fulfill({ status: 409, json: { ok: false, chain_ok: false, anchor_matches_chain: null, sink: 'file', head: null, last_anchor: null, unanchored_entries: 0, witness: null } }));
    await page.route(`${FAULT}/ops/jobs`, (r) => r.fulfill({ json: { started: true, alarm: { kind: 'audit_chain_broken', at: 'x', detail: 'audit chain broken at 41' }, jobs: [{ name: 'retention', runs: 4, failures: 1, lastRunAt: '2026-11-20T10:00:00Z', lastOk: false, lastError: 'disk' }, { name: 'sweep', runs: 0, failures: 0, lastRunAt: null, lastOk: null, lastError: null }] } }));
    await openCivicAs(page, admin.token);
    await page.getByTestId('console-tab-admin').click();
    await page.getByTestId('audit-verify').click();
    await expect(page.getByTestId('audit-alarm')).toBeVisible();
    await expect(page.getByTestId('jobs-alarm')).toContainText('audit chain broken at 41');
    await expect(page.getByTestId('job-row')).toHaveCount(2);
  });
});
