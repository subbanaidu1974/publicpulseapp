import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomPhone, sharedToken } from './civic-helpers';
import { auth, seedPerson, signUpApi } from './civic-identity-helpers';

async function headInvite(request: APIRequestContext, phone: string) {
  const token = await sharedToken(request);
  await request.post('/api/v1/civic/households/', { headers: auth(token) }); // idempotent: 409 when it exists
  const r = await request.post('/api/v1/civic/households/members/invite', { headers: auth(token), data: { phone, relation: 'spouse' } });
  expect(r.status()).toBe(201);
  return (await r.json()).inviteId as string;
}

test.describe('civic invite acceptance', () => {
  test('@E2E-150 notice is shown before sign-in and before anything is stored; unknown and expired codes have clear copy', async ({ page, request }) => {
    const id = await headInvite(request, randomPhone());
    await page.addInitScript(() => { try { localStorage.setItem('pp-lang', 'en'); } catch { /* ignore */ } });
    const accepts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/households/invites/')) accepts.push(r.url()); });
    await page.goto(`/?invite=${id}`);
    await expect(page.getByTestId('invite-accept')).toBeVisible();
    await expect(page.getByTestId('inv-notice-text')).toBeVisible();
    await expect(page.getByTestId('invite-accept')).toContainText(/Nothing about you is stored until you accept/);
    await expect(page.getByTestId('inv-signin')).toBeVisible();
    expect(accepts).toEqual([]);

    await page.goto('/?invite=does-not-exist-code');
    await expect(page.getByTestId('inv-gone')).toBeVisible();

    await page.route('**/households/invites/*/notice', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'expired', expiresAt: 1 }) }));
    await page.goto(`/?invite=${id}`);
    await expect(page.getByTestId('inv-expired')).toContainText(/expired/);
    await expect(page.getByTestId('inv-accept')).toHaveCount(0);
  });

  test('@E2E-150 Telugu notice; wrong phone and wrong PIN are told apart; accepting with the existing PIN joins the household', async ({ page, request }) => {
    test.skip(test.info().project.name === 'mobile', 'real sign-up runs on the desktop project only (OTP budget)');
    const phone = randomPhone();
    const invitee = await signUpApi(request, phone);
    const other = await sharedToken(request);
    const id = await headInvite(request, phone);

    // Wrong phone (real 403 phone_mismatch): someone else's session sees the notice but cannot answer.
    await page.addInitScript(([t, l]) => { try { if (!sessionStorage.getItem('civic-token')) sessionStorage.setItem('civic-token', t); localStorage.setItem('pp-lang', l); } catch { /* ignore */ } }, [other, 'te']);
    await page.goto(`/?invite=${id}`);
    await expect(page.getByTestId('inv-notice-text')).toContainText(/[ఀ-౿]/);
    await page.getByTestId('inv-read').check();
    await page.getByTestId('inv-pin').fill('4821');
    await page.getByTestId('inv-accept').click();
    await expect(page.getByTestId('civic-error')).toContainText('వేరే మొబైల్ నంబర్');

    // The invited person: wrong existing PIN (real 403 wrong_pin), then the right one.
    await page.evaluate((t) => sessionStorage.setItem('civic-token', t), invitee.token);
    await page.goto(`/?invite=${id}`);
    await page.getByTestId('inv-read').check();
    await page.getByTestId('inv-pin').fill('9999');
    await page.getByTestId('inv-accept').click();
    await expect(page.getByTestId('civic-error')).toContainText('PIN తప్పు');
    await page.getByTestId('inv-pin').fill('4821');
    await page.getByTestId('inv-accept').click();
    await expect(page.getByTestId('inv-accepted')).toBeVisible();
    await page.getByTestId('inv-home').click();
    await expect(page.getByTestId('civic-signed-in')).toBeVisible();
    expect(page.url()).not.toContain('invite=');
  });

  test('@E2E-150 I did not agree to this (real) removes the pending invite and the person is told; decline is wired (fixture)', async ({ page, request }) => {
    test.skip(test.info().project.name === 'mobile', 'real sign-up runs on the desktop project only (OTP budget)');
    const phone = randomPhone();
    const invitee = await signUpApi(request, phone);
    const id = await headInvite(request, phone);
    await page.addInitScript((t) => { try { sessionStorage.setItem('civic-token', t); localStorage.setItem('pp-lang', 'en'); } catch { /* ignore */ } }, invitee.token);
    await page.goto(`/?invite=${id}`);
    await page.getByTestId('inv-notagreed').click();
    await expect(page.getByTestId('inv-reported')).toContainText(/not a member/);
    // Re-inviting the same number right away is blocked (cooldown): the head sees the explanation in the household screen tests.
    const again = await request.post('/api/v1/civic/households/members/invite', { headers: auth(await sharedToken(request)), data: { phone, relation: 'spouse' } });
    expect(again.status()).toBe(429);
    expect((await again.json()).code).toBe('invite_cooldown');
  });

  test('@E2E-150 decline shows that nothing about the person was stored (fixture for the decline call)', async ({ page, request }) => {
    const id = await headInvite(request, randomPhone());
    const me = await seedPerson(request);
    await page.route('**/households/invites/decline', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
    await page.addInitScript((t) => { try { sessionStorage.setItem('civic-token', t); localStorage.setItem('pp-lang', 'te'); } catch { /* ignore */ } }, me.token);
    await page.goto(`/?invite=${id}`);
    await page.getByTestId('inv-decline').click();
    await expect(page.getByTestId('inv-declined')).toContainText('ఏమీ నిల్వ చేయలేదు');
  });
});
