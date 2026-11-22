import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { openHome, gotoTab, revealNav } from './helpers';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(tsx?|css|html)$/.test(e.name)) out.push(p);
  }
  return out;
}
const SRC = sourceFiles(path.join(process.cwd(), 'src')).concat(path.join(process.cwd(), 'index.html'));

test.describe('survey (retired legacy flow)', () => {
  test('@E2E-139 the survey tab is the Pulse Survey registry: opinion survey notice, no election wording, no tallies', async ({ page }) => {
    await openHome(page, 'AP');
    await gotoTab(page, /survey/i);
    await expect(page.getByTestId('surveys-root')).toBeVisible();
    await expect(page.getByTestId('survey-disclaimer')).toContainText(/not an election and not a forecast/i);
    await expect(page.getByTestId('survey-protection')).toBeVisible();
    const body = (await page.locator('main').innerText()).toLowerCase();
    expect(body).not.toMatch(/\b(ballot|poll|polls|vote)\b/);
  });

  test('@E2E-139 no legacy counters, localStorage tallies or leader-preference questions in source', async () => {
    const text = SRC.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(text).not.toMatch(/registered-users-count|logged-polls-count|Leadership Preference|Election Preference|INITIAL_MOCK_RESPONSES/);
  });

  test('@E2E-139 no tallies are written to localStorage', async ({ page }) => {
    await openHome(page, 'AP');
    await gotoTab(page, /survey/i);
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys.filter((k) => !/^(app-theme|pp-lang|pp-state)$/.test(k))).toEqual([]);
  });

  test('@E2E-18 methodology and sources page is reachable and shows sourced data status', async ({ page }) => {
    await openHome(page, 'AP');
    await gotoTab(page, /methodology/i);
    await expect(page.getByRole('heading', { name: /methodology/i }).first()).toBeVisible();
    await expect(page.getByTestId('data-status-public')).toBeVisible();
  });
});

test.describe('legacy login and credentials (retired)', () => {
  test('@E2E-68 no seeded accounts, passwords, role gates or browser OTP in source', async () => {
    const text = SRC.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(text).not.toMatch(/admin@peoplepulse|userDatabase|validateUser|is-logged-in|current-user-role|current-user-email|dispatchedOtp|\/api\/send-otp|\/api\/admin\/config/);
    expect(text).not.toMatch(/Math\.random/);
    expect(text).not.toMatch(/password\s*[:=]\s*["'][^"']{4,}["']/i);
  });

  test('@E2E-68 Sign in leads to the Civic sign-in', async ({ page }) => {
    await openHome(page, 'AP');
    if (!(await page.getByTestId('sign-in').isVisible())) await revealNav(page);
    await page.getByRole('button', { name: /^sign in$/i }).first().click();
    await expect(page.locator('main')).toContainText(/sign|phone|mobile/i);
    expect(await page.evaluate(() => localStorage.getItem('is-logged-in'))).toBeNull();
  });
});

test.describe('hard-coded content and third-party media (retired)', () => {
  test('@E2E-140 no hotlinked media or hard-coded reports in source', async () => {
    const text = SRC.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(text).not.toMatch(/youtube\.com|youtu\.be|mixkit|unsplash|unpkg\.com|NEWS_CARDS|TESTIMONIALS|TRENDING_VIDEOS|bREPORTSb\b/);
  });

  test('@E2E-140 every tab makes only same-origin, Esri tile or font requests (fonts: E2E-145 will self-host)', async ({ page }) => {
    const foreign: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.protocol.startsWith('http') && u.origin !== new URL(page.url() === 'about:blank' ? r.url() : page.url()).origin && !/(arcgisonline\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(u.hostname)) foreign.push(r.url());
    });
    await openHome(page, 'AP');
    for (const label of [/analytics/i, /elections/i, /constituenc/i, /survey/i, /methodology/i, /faq/i]) await gotoTab(page, label);
    expect(foreign).toEqual([]);
  });
});

test.describe('language', () => {
  test('@E2E-17 toggle EN to Telugu translates nav and persists', async ({ page }) => {
    await openHome(page, 'AP');
    const navText = async () => ((await (await revealNav(page)).textContent()) ?? '').trim();
    const english = await navText();
    await page.getByTestId('lang-toggle').click();
    await expect.poll(navText).toMatch(/[ఀ-౿]/);
    await page.reload();
    await expect.poll(navText).toMatch(/[ఀ-౿]/);
    await page.getByTestId('lang-toggle').click();
    await expect.poll(navText).toBe(english);
  });
});

test.describe('admin', () => {
  test('@E2E-19 no session: admin data status is hidden', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByTestId('admin-denied')).toBeVisible();
    await expect(page.getByTestId('admin-data-status')).toBeHidden();
  });

  test('@E2E-19 a civic session without server-confirmed admin role is denied', async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem('civic-token', 'not-an-admin'));
    await page.goto('/admin');
    await expect(page.getByTestId('admin-denied')).toBeVisible();
    await expect(page.getByTestId('admin-data-status')).toBeHidden();
  });

  test('@E2E-19 admin session confirmed by the server shows per-source status', async ({ page }) => {
    await page.route('**/api/v1/data-status/admin', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await page.addInitScript(() => sessionStorage.setItem('civic-token', 'server-says-admin'));
    await page.goto('/admin');
    await expect(page.getByTestId('admin-data-status')).toBeVisible();
    await expect(page.getByTestId('admin-data-status')).toContainText(/elections/i);
  });
});
