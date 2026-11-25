import { test, expect } from '@playwright/test';
import { API, bearer, seedPerson } from './civic-seed';

const N = `${API}/notify`;

async function open(page: import('@playwright/test').Page, token: string) {
  await page.addInitScript((t) => { try { localStorage.setItem('pp-lang', 'en'); sessionStorage.setItem('civic-token', t); } catch { /* ignore */ } }, token);
  await page.goto('/#/notifications/settings');
  await expect(page.locator('.notify-root')).toBeVisible();
}

test.describe('email notification channel (S-184)', () => {
  test('@E2E-197 an email account can switch the email channel on and off; a phone account never sees it', async ({ page, request }) => {
    const email = `e2e.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.org`;
    const rq = await request.post('/api/v1/civic/identity/signup/email/request', { data: { email } });
    const otp = (await rq.json()).dev_otp as string;
    const up = await (await request.post('/api/v1/civic/identity/signup/email/verify', { data: { email, otp, pin: '4821', consent_version: 'v1' } })).json();
    await open(page, up.token);
    const box = page.getByTestId('email-ok');
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
    await box.click();
    await expect(box).toBeChecked();
    let prefs = await (await request.get(`${N}/prefs`, { headers: bearer(up.token) })).json();
    expect(prefs).toMatchObject({ email_ok: true, has_email: true });
    await box.click();
    await expect(box).not.toBeChecked();
    prefs = await (await request.get(`${N}/prefs`, { headers: bearer(up.token) })).json();
    expect(prefs.email_ok).toBe(false);
  });

  test('@E2E-197 a person with only a phone has no email option and the server refuses to switch it on', async ({ page, request }) => {
    const me = await seedPerson(request);
    await open(page, me.token);
    await expect(page.getByTestId('channels-panel')).toBeVisible();
    await expect(page.getByTestId('email-ok')).toHaveCount(0);
    const r = await request.put(`${N}/prefs`, { headers: bearer(me.token), data: { email_ok: true } });
    expect(r.status()).toBe(400);
  });
});
