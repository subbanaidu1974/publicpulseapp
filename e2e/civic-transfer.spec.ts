import { test, expect } from '@playwright/test';
import { randomPhone } from './civic-helpers';
import { auth, openCivicAs, seedPerson, signUpApi } from './civic-identity-helpers';

import type { Page } from '@playwright/test';
import { startOnCivicTab } from './civic-helpers';
test.beforeEach(async ({ page }) => { await startOnCivicTab(page, 'household'); });
async function toCivic(p: Page) { await p.goto('/?state=AP'); const nav = p.getByTestId('nav-civic'); if (!(await nav.isVisible())) await p.locator('#mobile-menu-toggle').click(); await nav.click(); }

const H = '/api/v1/civic/households';

test.describe('civic household head transfer (two-step)', () => {
  test('@E2E-164 head asks, can cancel, asks again; the member confirms (Telugu) and becomes head; decline leaves everything unchanged', async ({ page, request }) => {
    test.skip(test.info().project.name === 'mobile', 'real sign-up of the member runs on the desktop project only (OTP budget)');
    const head = await seedPerson(request, [], 'Head');
    const phone = randomPhone();
    const member = await signUpApi(request, phone, 'Member');
    expect((await request.post(`${H}/`, { headers: auth(head.token) })).status()).toBe(201);
    const inv = await request.post(`${H}/members/invite`, { headers: auth(head.token), data: { phone, relation: 'spouse' } });
    expect(inv.status()).toBe(201);
    const acc = await request.post(`${H}/invites/accept`, { headers: auth(member.token), data: { inviteId: (await inv.json()).inviteId, pin: '4821' } });
    expect(acc.ok()).toBeTruthy();

    // Head: ask, see the waiting notice, cancel.
    await openCivicAs(page, head.token, 'en');
    await page.getByTestId('household-transfer').first().click();
    await expect(page.getByTestId('household-message')).toContainText(/Nothing changes until they confirm/);
    const pending = page.getByTestId('transfer-pending');
    await expect(pending).toHaveAttribute('data-role', 'sender');
    await expect(page.getByTestId('household-transfer').first()).toBeDisabled();
    await page.getByTestId('transfer-cancel').click();
    await expect(pending).toHaveCount(0);
    await page.getByTestId('household-transfer').first().click();
    await expect(page.getByTestId('transfer-pending')).toBeVisible();

    // Member (Telugu): sees the request as recipient, declines first, then is asked again and accepts.
    const memberPage = await page.context().newPage();
    await startOnCivicTab(memberPage, 'household');
    await memberPage.addInitScript((t) => { try { sessionStorage.setItem('civic-token', t); localStorage.setItem('pp-lang', 'te'); } catch { /* ignore */ } }, member.token);
    await toCivic(memberPage);
    await expect(memberPage.getByTestId('transfer-pending')).toHaveAttribute('data-role', 'recipient');
    await expect(memberPage.getByTestId('transfer-pending')).toContainText('ప్రత్యేక హక్కు కాదు');
    await memberPage.getByTestId('transfer-decline').click();
    await expect(memberPage.getByTestId('household-message')).toContainText('ఏదీ మారలేదు');
    await expect(memberPage.getByTestId('transfer-pending')).toHaveCount(0);

    await toCivic(page);
    await page.getByTestId('household-transfer').first().click();
    await toCivic(memberPage);
    await memberPage.getByTestId('transfer-accept').click();
    await expect(memberPage.getByTestId('household-message')).toContainText('కుటుంబ పెద్ద');
    // Now the member is the head: the invite form is theirs.
    await expect(memberPage.getByTestId('invite-submit')).toBeVisible();
  });

  test('@E2E-164 dependents cap and invitation limits are explained in plain words', async ({ page, request }) => {
    const head = await seedPerson(request, [], 'Head2');
    expect((await request.post(`${H}/`, { headers: auth(head.token) })).status()).toBe(201);
    await page.route('**/households/dependents', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'a household can list at most 8 dependents', code: 'dependents_cap' }) }));
    await page.route('**/households/members/invite', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'invite_cooldown', retryAt: Date.now() + 3600_000 }) }));
    await openCivicAs(page, head.token, 'en');
    await page.getByTestId('invite-phone').fill(randomPhone());
    await page.getByTestId('invite-submit').click();
    await expect(page.getByTestId('household-error')).toContainText(/recently declined/);
    await page.getByTestId('dependent-yob').fill(String(new Date().getFullYear() - 5));
    await page.getByTestId('dependent-continue').click();
    await page.getByTestId('consent-notice-check').check();
    await page.getByTestId('consent-notice-accept').click();
    await expect(page.getByTestId('household-error')).toContainText(/limit for listed children/);
  });
});
