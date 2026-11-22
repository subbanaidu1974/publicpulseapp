import { test, expect, type APIRequestContext } from '@playwright/test';
import { openCivic, randomPhone } from './civic-helpers';
import { auth, signUpApi } from './civic-identity-helpers';

const API = '/api/v1/civic/identity';

/** Two adults on one SIM, through the real routes: sign up, then /sim/link with the second adult's own PIN. Real OTP: desktop project only. */
async function sharedSim(request: APIRequestContext) {
  const phone = randomPhone();
  const a = await signUpApi(request, phone, 'Asha');
  const l = await request.post(`${API}/sim/link`, { headers: auth(a.token), data: { pin: '3917', consent_version: 'v1', label: 'RK' } });
  expect(l.status()).toBe(201);
  const rkId = (await l.json()).person.id as string;
  return { phone, ashaId: a.personId, rkId };
}

test.describe.serial('civic login picker (real server)', () => {
  let sim: Awaited<ReturnType<typeof sharedSim>> | null = null;
  test.beforeAll(async ({ request }, info) => { if (info.project.name !== 'mobile') sim = await sharedSim(request); });

  test('@E2E-146 shared SIM: names shown (never PINs), pick yourself by keyboard, then own PIN signs in', async ({ page }) => {
    test.skip(!sim, 'real sign-up runs on the desktop project only (OTP budget)');
    await openCivic(page, 'en');
    await page.getByTestId('civic-login-btn').click();
    await page.getByTestId('li-phone').fill(sim!.phone);
    await page.getByTestId('li-pin').fill('4821');
    await page.getByTestId('li-submit').click();
    const picker = page.getByTestId('li-picker');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('Asha');
    await expect(picker).toContainText('RK');
    await expect(picker).not.toContainText(/\d{4}/);
    // Submitting before a pick is refused with a clear message.
    await page.getByTestId('li-pin').fill('4821');
    await page.getByTestId('li-submit').click();
    await expect(page.getByTestId('civic-error')).toContainText(/Choose your name/);
    // Keyboard: focus the first adult, pick with Space, focus moves to the PIN field.
    await page.getByTestId('li-person').first().focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('li-pin')).toBeFocused();
    const req = page.waitForRequest((r) => r.url().endsWith('/identity/login') && !!r.postDataJSON()?.person_id);
    await page.getByTestId('li-pin').fill('4821');
    await page.keyboard.press('Enter');
    expect((await req).postDataJSON()).toMatchObject({ person_id: sim!.ashaId });
    await expect(page.getByTestId('civic-signed-in')).toBeVisible();
    // The signed-in person sees their own sign-in listed, marked as this device.
    await expect(page.getByTestId('session-row').first()).toContainText(/this device/i);
  });

  test('@E2E-146 lockout (real 423) shows the SIM-holder notice in Telugu and offers PIN reset; locked adult is marked in the picker', async ({ page, request }) => {
    test.skip(!sim, 'real sign-up runs on the desktop project only (OTP budget)');
    let status = 0;
    for (let i = 0; i < 8 && status !== 423; i++) {
      status = (await request.post(`${API}/login`, { data: { phone: '+91' + sim!.phone, pin: '2580', person_id: sim!.rkId } })).status();
    }
    expect(status).toBe(423);
    await openCivic(page, 'te');
    await page.getByTestId('civic-login-btn').click();
    await page.getByTestId('li-phone').fill(sim!.phone);
    await page.getByTestId('li-pin').fill('3917');
    await page.getByTestId('li-submit').click();
    await expect(page.getByTestId('li-picker').locator('legend')).toContainText('ఎవరు');
    await expect(page.getByTestId('li-person-locked')).toHaveCount(1);
    await page.getByTestId('li-person').nth(1).check();
    await page.getByTestId('li-pin').fill('3917');
    await page.getByTestId('li-submit').click();
    await expect(page.getByTestId('li-notice')).toContainText('30 నిమిషాలు');
    await expect(page.getByTestId('li-notice')).toContainText('SIM');
    await expect(page.getByTestId('li-forgot')).toBeVisible();
  });
});

test('@E2E-146 limited state (429, served by a fixture: needs many failed attempts) suggests waiting or resetting', async ({ page }) => {
  await page.route('**/identity/login', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (!body.person_id) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'person_required', members: [{ person_id: 'a', label: 'Asha', locked: false }, { person_id: 'b', label: 'RK', locked: false }] }) });
    return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'too many', limited: true }) });
  });
  await openCivic(page, 'en');
  await page.getByTestId('civic-login-btn').click();
  await page.getByTestId('li-phone').fill('9876543210');
  await page.getByTestId('li-pin').fill('1357');
  await page.getByTestId('li-submit').click();
  await page.getByTestId('li-person').first().check();
  await page.getByTestId('li-pin').fill('1357');
  await page.getByTestId('li-submit').click();
  await expect(page.getByTestId('li-notice')).toContainText(/Wait a while/);
});

test('@E2E-146 a number with one adult logs in without any picker (real server)', async ({ page, request }) => {
  test.skip(test.info().project.name === 'mobile', 'real sign-up runs on the desktop project only (OTP budget)');
  const phone = randomPhone();
  await signUpApi(request, phone);
  await openCivic(page, 'en');
  await page.getByTestId('civic-login-btn').click();
  await page.getByTestId('li-phone').fill(phone);
  await page.getByTestId('li-pin').fill('0000');
  await page.getByTestId('li-submit').click();
  await expect(page.getByTestId('civic-error')).toContainText(/Wrong number or PIN/);
  await expect(page.getByTestId('li-picker')).toHaveCount(0);
  await page.getByTestId('li-pin').fill('4821');
  await page.getByTestId('li-submit').click();
  await expect(page.getByTestId('civic-signed-in')).toBeVisible();
});
