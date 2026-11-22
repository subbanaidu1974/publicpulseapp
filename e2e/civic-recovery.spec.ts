import { test, expect } from '@playwright/test';
import { openCivic, randomPhone } from './civic-helpers';
import { auth, signUpApi } from './civic-identity-helpers';

test.describe('civic PIN recovery', () => {
  test('@E2E-147 forgot PIN: recovery code, weak PIN explained, reset signs out every device, new PIN works', async ({ page, request }) => {
    test.skip(test.info().project.name === 'mobile', 'real sign-up runs on the desktop project only (OTP budget)');
    const phone = randomPhone();
    const { token } = await signUpApi(request, phone);
    expect((await request.get('/api/v1/civic/identity/me', { headers: auth(token) })).ok()).toBeTruthy();

    await openCivic(page, 'en');
    await page.getByTestId('civic-login-btn').click();
    await page.getByTestId('li-forgot').click();
    await expect(page.getByTestId('recover-flow')).toBeVisible();
    await page.getByTestId('rc-phone').fill(phone);
    await page.getByTestId('rc-send').click();
    const dev = page.getByTestId('dev-otp');
    await expect(dev).toBeVisible();
    const otp = ((await dev.textContent()) ?? '').match(/(\d{6})/)![1];

    // Asking again while the code is still valid: the server does not send another, the screen says so.
    await page.getByTestId('rc-back').click();
    await page.getByTestId('li-forgot').click();
    await page.getByTestId('rc-phone').fill(phone);
    await page.getByTestId('rc-send').click();
    await expect(page.getByTestId('rc-already')).toContainText(/already sent/);
    await expect(page.getByTestId('dev-otp')).toHaveCount(0);

    await page.getByTestId('rc-otp').fill(otp);
    await page.getByTestId('rc-pin').fill('1111');
    await page.getByTestId('rc-submit').click();
    await expect(page.getByTestId('civic-error')).toContainText(/too easy to guess/); // real weak_pin
    await page.getByTestId('rc-pin').fill('7302');
    await page.getByTestId('rc-submit').click();
    await expect(page.getByTestId('rc-done')).toContainText(/signed out on every device/);

    expect((await request.get('/api/v1/civic/identity/me', { headers: auth(token) })).status()).toBe(401); // old session revoked
    expect((await request.post('/api/v1/civic/identity/login', { data: { phone: '+91' + phone, pin: '4821' } })).status()).toBe(401);
    expect((await request.post('/api/v1/civic/identity/login', { data: { phone: '+91' + phone, pin: '7302' } })).ok()).toBeTruthy();
    await page.getByTestId('rc-back').click();
    await expect(page.getByTestId('login-flow')).toBeVisible();
  });

  test('@E2E-147 recovery screen is in Telugu and a wrong code is explained', async ({ page }) => {
    await page.route('**/identity/pin/recover/request', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dev_otp: '123456' }) }));
    await openCivic(page, 'te');
    await page.getByTestId('civic-login-btn').click();
    await page.getByTestId('li-forgot').click();
    await expect(page.getByTestId('recover-flow')).toContainText('మీ PIN రీసెట్ చేయండి');
    await page.getByTestId('rc-phone').fill('9876500000');
    await page.getByTestId('rc-send').click();
    await page.getByTestId('rc-otp').fill('000000'); // real server: no such code
    await page.getByTestId('rc-pin').fill('7302');
    await page.getByTestId('rc-submit').click();
    await expect(page.getByTestId('civic-error')).toContainText('కోడ్ తప్పు');
  });
});
