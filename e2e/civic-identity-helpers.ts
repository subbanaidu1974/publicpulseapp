import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { openCivic } from './civic-helpers';

const API = '/api/v1/civic';
export const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** A fresh person with a session and optional core roles (server must run with CIVIC_E2E_SEED=1; playwright.config.ts does that). No OTP is spent. */
export async function seedPerson(request: APIRequestContext, roles: { role: string }[] = [], label = 'e2e') {
  const r = await request.post(`${API}/e2e/person`, { data: { roles, label } });
  expect(r.status(), 'e2e seed route must be enabled').toBe(201);
  const j = await r.json();
  return { token: j.token as string, personId: j.person_id as string };
}

/** Real sign-up through the API (spends one OTP request from the per-IP budget). */
export async function signUpApi(request: APIRequestContext, phone: string, label?: string, pin = '4821') {
  const r = await request.post(`${API}/identity/signup/request`, { data: { phone: '+91' + phone } });
  const otp = (await r.json()).dev_otp as string;
  const v = await request.post(`${API}/identity/signup/verify`, { data: { phone: '+91' + phone, otp, pin, consent_version: 'v1', ...(label ? { label } : {}) } });
  expect(v.status()).toBe(201);
  const j = await v.json();
  return { token: j.token as string, personId: j.person.id as string };
}

/** Open the civic tab signed in with an explicit token (replaces any earlier token set by an init script). */
export async function openCivicAs(page: Page, token: string, lang: 'en' | 'te' = 'en') {
  await page.addInitScript((t) => { try { sessionStorage.setItem('civic-token', t); } catch { /* ignore */ } }, token);
  await openCivic(page, lang);
  await expect(page.getByTestId('civic-signed-in')).toBeVisible();
}
