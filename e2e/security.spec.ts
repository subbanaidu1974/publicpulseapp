import { test, expect } from '@playwright/test';

test('@E2E-69 CSP and security headers on the served app and no CSP violations on load', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  const res = await page.goto('/');
  const h = res!.headers();
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['permissions-policy']).toContain('geolocation=()');
  await page.waitForLoadState('networkidle');
  expect(violations).toEqual([]);
});

test('@E2E-66 spoofed admin header does not reach a config endpoint', async ({ request }) => {
  const res = await request.get('/api/admin/config', { headers: { 'x-user-role': 'Super Admin' } });
  expect([401, 404]).toContain(res.status());
  expect(await res.text()).not.toMatch(/SMTP|WEB3FORMS/);
});

test('@E2E-67 /api/send-otp no longer exists', async ({ request }) => {
  const res = await request.post('/api/send-otp', { data: { email: 'a@b.c', otp: '123456' } });
  expect(res.status()).toBe(404);
});
