import { test, expect } from '@playwright/test';
import { openCivicAs } from './civic-seed';
import { randomPhone } from './civic-helpers';
import { auth, signUpApi } from './civic-identity-helpers';
import { startOnCivicTab } from './civic-helpers';
test.beforeEach(async ({ page }) => { await startOnCivicTab(page, 'account'); });

const API = '/api/v1/civic/identity';

test.describe('change PIN (S-158)', () => {
  test('@E2E-182 weak and wrong PINs are explained; success signs out the other devices, swaps this token and the new PIN works', async ({ page, request }) => {
    test.skip(test.info().project.name === 'mobile', 'real sign-up runs on the desktop project only (OTP budget)');
    const phone = randomPhone();
    const { token } = await signUpApi(request, phone, undefined, '4821');
    const second = await request.post(`${API}/login`, { data: { phone: '+91' + phone, pin: '4821' } });
    expect(second.ok()).toBeTruthy();
    const otherDevice = (await second.json()).token as string;

    await openCivicAs(page, token);
    await expect(page.getByTestId('sessions-page')).toBeVisible();
    await page.getByTestId('chpin-open').click();
    await expect(page.getByTestId('change-pin')).toContainText('Change your PIN');
    const fill = async (o: string, n: string, a: string) => {
      await page.getByTestId('chpin-old').fill(o); await page.getByTestId('chpin-new').fill(n); await page.getByTestId('chpin-again').fill(a);
      await page.getByTestId('chpin-submit').click();
    };

    await fill('4821', '1111', '1111');
    await expect(page.getByTestId('civic-error')).toContainText(/too easy to guess/); // the server's real weak_pin
    await fill('9999', '7302', '7302');
    await expect(page.getByTestId('civic-error')).toContainText(/current PIN is wrong/);
    await fill('4821', '7302', '7303');
    await expect(page.getByTestId('civic-error')).toContainText(/not the same/); // checked on the page, nothing sent
    await fill('4821', '4821', '4821');
    await expect(page.getByTestId('civic-error')).toContainText(/different from the current/);

    await fill('4821', '7302', '7302');
    await expect(page.getByTestId('chpin-done')).toContainText(/signed out of your other devices/);
    const fresh = await page.evaluate(() => sessionStorage.getItem('civic-token'));
    expect(fresh && fresh !== token).toBeTruthy(); // swapped for the token the server issued

    expect((await request.get(`${API}/me`, { headers: auth(token) })).status()).toBe(401);
    expect((await request.get(`${API}/me`, { headers: auth(otherDevice) })).status()).toBe(401);
    expect((await request.get(`${API}/me`, { headers: auth(fresh!) })).ok()).toBeTruthy();
    expect((await request.post(`${API}/login`, { data: { phone: '+91' + phone, pin: '4821' } })).status()).toBe(401);
    expect((await request.post(`${API}/login`, { data: { phone: '+91' + phone, pin: '7302' } })).ok()).toBeTruthy();
    await expect(page.getByTestId('civic-signed-in')).toBeVisible(); // this device stays signed in on the new token
    await page.getByTestId('civic-tab-mine').click();
    await page.getByTestId('my-reports-refresh').click();
    await expect(page.getByTestId('my-reports-error')).toHaveCount(0); // authenticated calls keep working with the swapped token
  });

  test('@E2E-182 the screen is available in Telugu and can be cancelled', async ({ page, request }) => {
    test.skip(test.info().project.name === 'mobile', 'real sign-up runs on the desktop project only (OTP budget)');
    const { token } = await signUpApi(request, randomPhone());
    await openCivicAs(page, token, 'te');
    await page.getByTestId('chpin-open').click();
    await expect(page.getByTestId('change-pin')).toContainText('మీ PIN మార్చండి');
    await page.getByTestId('chpin-old').fill('4821');
    await page.getByTestId('chpin-new').fill('1111');
    await page.getByTestId('chpin-again').fill('1111');
    await page.getByTestId('chpin-submit').click();
    await expect(page.getByTestId('civic-error')).toContainText('ఊహించడం చాలా సులభం');
    await page.getByTestId('chpin-cancel').click();
    await expect(page.getByTestId('chpin-old')).toHaveCount(0);
    await expect(page.getByTestId('chpin-open')).toBeVisible();
  });
});
