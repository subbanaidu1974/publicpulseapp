import crypto from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { openCivic } from './civic-helpers';

/**
 * Real-server helpers for the issues / consoles specs. People are created through the test-only seeding route
 * (POST /api/v1/civic/e2e/person, mounted only when CIVIC_E2E_SEED=1 and NODE_ENV is not production), which grants REAL core roles,
 * so every console call below goes through the normal authorisation path. Nothing here fakes a response.
 */
export const API = '/api/v1/civic';
export interface Seeded { token: string; personId: string }
export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
export const uniq = () => crypto.randomBytes(5).toString('hex');

export async function seedPerson(request: APIRequestContext, roles: { role: string; jurisdiction?: string }[] = []): Promise<Seeded> {
  const r = await request.post(`${API}/e2e/person`, { data: { roles } });
  expect(r.status(), 'seed route missing: start the server with CIVIC_E2E_SEED=1 (playwright.config.ts does)').toBe(201);
  const j = await r.json();
  return { token: j.token, personId: j.person_id };
}

export interface VillageHit { lgd: string; name: string }
/** First real village matching any of the queries (geo data is real, so names are tried in order). */
export async function findVillage(request: APIRequestContext, ...queries: string[]): Promise<VillageHit> {
  for (const q of queries) {
    const r = await request.get(`${API}/geo/search?q=${encodeURIComponent(q)}`);
    const hit = (await r.json()).results?.[0];
    if (hit?.village?.lgd) return { lgd: hit.village.lgd, name: hit.village.name_en };
  }
  throw new Error(`no village found for ${queries.join(', ')}`);
}

export async function report(request: APIRequestContext, token: string, b: { category?: string; text: string; village: string; photoRef?: string }) {
  const r = await request.post(`${API}/issues`, { headers: bearer(token), data: { category: b.category ?? 'water', village_lgd: b.village, description_en: b.text, photo_ref: b.photoRef } });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as { id: string; held?: boolean; merged?: boolean };
}

/** Text that cannot be merged into another report (the server dedupes similar reports in the same village and category). */
export const freshText = (tag: string) => `${tag} ${uniq()} ${uniq()} ${uniq()} pump leaking`;

export async function openCivicAs(page: Page, token: string, lang: 'en' | 'te' = 'en') {
  await page.addInitScript((t) => { try { sessionStorage.setItem('civic-token', t); } catch { /* ignore */ } }, token);
  await openCivic(page, lang);
  await expect(page.getByTestId('civic-signed-in')).toBeVisible();
}

// ---- TOTP (RFC 6238, SHA1, 6 digits, 30 s). The server accepts +/-1 step and a strictly increasing counter, so codes are single-use. ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, '')) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest(); const o = h[h.length - 1] & 0xf;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}
export class Totp {
  private last = 0;
  constructor(private secret: string) {}
  /** The next unused code: the smallest counter above the last one that the server still accepts (waits for the clock when all three are used). */
  async next(): Promise<string> {
    for (;;) {
      const now = Math.floor(Date.now() / 30_000);
      const c = Math.max(this.last + 1, now - 1);
      if (c <= now + 1) { this.last = c; return hotp(b32(this.secret), c); }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** Enrol and confirm TOTP for an admin through the API; returns the generator. */
export async function enrolAdmin(request: APIRequestContext, token: string): Promise<Totp> {
  const e = await request.post(`${API}/admin/mfa/enrol`, { headers: bearer(token), data: {} });
  expect(e.status()).toBe(201);
  const totp = new Totp((await e.json()).secret);
  const v = await request.post(`${API}/admin/mfa/confirm`, { headers: bearer(token), data: { code: await totp.next() } });
  expect(v.ok(), await v.text()).toBe(true);
  return totp;
}

/**
 * Fault injection only: the few cases a real server cannot be made to produce on demand (a scanner outage, a corrupt audit chain, a 5xx).
 * Everything else in these specs hits the real routes.
 */
export const FAULT = '**/api/v1/civic';
