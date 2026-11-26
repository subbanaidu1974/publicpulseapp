import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { openHome, revealNav, randomPhone } from './helpers';

export { randomPhone };

/** Open the Civic tab (works on desktop and the 375px menu). */
export async function openCivic(page: Page, lang: 'en' | 'te' = 'en') {
  await page.addInitScript((l) => { try { localStorage.setItem('pp-lang', l); } catch { /* ignore */ } }, lang);
  await openHome(page, 'AP');
  let nav = page.getByTestId('nav-civic');
  if (!(await nav.isVisible())) {
    await revealNav(page);
    nav = page.getByTestId('nav-civic');
  }
  await nav.click();
  await expect(page.getByTestId('civic-home')).toBeVisible();
}

/** Accept the consent notice, then phone, dev OTP and PIN (server must run with CIVIC_EXPOSE_DEV_OTP=1). */
export async function completeSignUpFromConsent(page: Page, phone = randomPhone(), pin = '4821') {
  await page.getByTestId('consent-notice-check').check();
  await page.getByTestId('consent-notice-accept').click();
  await page.getByTestId('su-phone').fill(phone);
  await page.getByTestId('su-send-otp').click();
  const dev = page.getByTestId('dev-otp');
  await expect(dev).toBeVisible();
  const otp = ((await dev.textContent()) ?? '').match(/(\d{6})/)![1];
  await page.getByTestId('su-otp').fill(otp);
  await page.getByTestId('su-otp-next').click();
  await page.getByTestId('su-pin').fill(pin);
  await page.getByTestId('su-submit').click();
  await expect(page.getByTestId('civic-signed-in')).toBeVisible();
  return { phone, pin };
}

export async function signUp(page: Page) {
  await page.getByTestId('civic-signup-btn').click();
  await expect(page.getByTestId('consent-notice')).toBeVisible();
  return completeSignUpFromConsent(page);
}

/**
 * One shared dev account for all signed-in civic specs (the server caps OTP requests per IP, so UI sign-ups are kept
 * to the two specs that test them). Created once through the API, cached in the temp dir, guarded by a lock file.
 */
export async function sharedToken(request: APIRequestContext): Promise<string> {
  const file = path.join(os.tmpdir(), 'civic-e2e-shared.json');
  const lock = file + '.lock';
  const valid = async (t: string) => (await request.get('/api/v1/civic/identity/me', { headers: { authorization: `Bearer ${t}` } })).ok();
  const read = (): string | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).token; } catch { return null; } };
  for (let i = 0; i < 40; i++) {
    const cached = read();
    if (cached && (await valid(cached))) return cached;
    let owner = false;
    try { fs.closeSync(fs.openSync(lock, 'wx')); owner = true; } catch { /* another worker is creating it */ }
    if (owner) {
      try {
        const phone = randomPhone();
        const r = await request.post('/api/v1/civic/identity/signup/request', { data: { phone: '+91' + phone } });
        const otp = (await r.json()).dev_otp as string;
        const v = await request.post('/api/v1/civic/identity/signup/verify', { data: { phone: '+91' + phone, otp, pin: '4821', consent_version: 'v1' } });
        const token = (await v.json()).token as string;
        fs.writeFileSync(file, JSON.stringify({ token }));
        return token;
      } finally { try { fs.unlinkSync(lock); } catch { /* ignore */ } }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('could not obtain shared civic session');
}

/** Open the Civic tab already signed in as the shared dev account. */
export async function openCivicSignedIn(page: Page, request: APIRequestContext, lang: 'en' | 'te' = 'en') {
  const token = await sharedToken(request);
  await page.addInitScript((t) => { try { sessionStorage.setItem('civic-token', t); } catch { /* ignore */ } }, token);
  await openCivic(page, lang);
  await expect(page.getByTestId('civic-signed-in')).toBeVisible();
}

/** The Civic page opens on its Issues tab. Specs for another tab call this once; it persists across reloads in the same page. */
export async function startOnCivicTab(page: Page, tab: 'report' | 'mine' | 'household' | 'account' | 'explore' | 'roles') {
  await page.addInitScript((t) => { try { sessionStorage.setItem('pp-civic-tab', t); } catch { /* ignore */ } }, tab);
}
