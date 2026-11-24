/**
 * Accessibility sweep (INTERNAL SELF-ASSESSMENT, NOT INDEPENDENT; it does not replace RELEASE_GATE row 9, which needs a human audit
 * with Telugu screen-reader testing). One axe run per route x language (EN, TE) x viewport (desktop 1280x800, mobile 375x812).
 *
 *   PORT=4950 npx playwright test e2e/a11y-sweep.spec.ts --project=chromium
 *
 * Critical and serious WCAG 2.x A/AA violations fail the run. Moderate and minor ones are collected, never hidden: set
 * A11Y_SWEEP_OUT=<file.json> to write every violation (all impacts) for the evidence report. Routes are the anonymous main routes;
 * signed-in civic screens are covered by e2e/civic-a11y.spec.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 812 } } as const;

/** [name, url]: tabs are opened through the app's own `pp-nav` event after load; hash routes by URL. */
const ROUTES: { name: string; hash?: string; tab?: string; path?: string }[] = [
  { name: 'home', tab: 'home' }, { name: 'map-tab', tab: 'map' }, { name: 'analytics', tab: 'analytics' }, { name: 'elections', tab: 'elections' },
  { name: 'civic', tab: 'civic' }, { name: 'constituencies', tab: 'constituencies' }, { name: 'survey', tab: 'survey' }, { name: 'methodology', tab: 'methodology' },
  { name: 'faq', tab: 'faq' }, { name: 'privacy', tab: 'privacy' }, { name: 'terms', tab: 'terms' }, { name: 'who', tab: 'who' }, { name: 'people', tab: 'people' },
  { name: 'admin', path: '/admin' },
  { name: 'map-route', hash: '#/map' }, { name: 'analytics-turnout', hash: '#/analytics/turnout' }, { name: 'analytics-compare', hash: '#/analytics/compare' },
  { name: 'analytics-history', hash: '#/analytics/history' }, { name: 'people-party', hash: '#/people/party/INC' }, { name: 'people-leaders', hash: '#/people/leaders' },
  { name: 'surveys', hash: '#/surveys' }, { name: 'consultations', hash: '#/consultations' }, { name: 'dashboard', hash: '#/dashboard' },
  { name: 'notifications', hash: '#/notifications' }, { name: 'notifications-keys', hash: '#/notifications/keys' }, { name: 'countday', hash: '#/countday' },
  { name: 'constituency-profile', hash: '#/constituency/AP/1' },
  { name: 'lite', path: '/lite' },
];

interface Row { route: string; lang: string; viewport: string; id: string; impact: string | null | undefined; nodes: string[] }
const rows: Row[] = [];
let n = 0;

for (const lang of ['en', 'te'] as const) {
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    test.describe(`a11y sweep ${lang} ${vpName}`, () => {
      test.use({ viewport: vp });
      for (const r of ROUTES) {
        test(`@E2E-57 ${r.name} (${lang}, ${vpName})`, async ({ page }) => {
          await page.addInitScript((l) => { try { localStorage.setItem('pp-lang', l); } catch { /* ignore */ } }, lang);
          const url = r.path ? r.path + `?t=${++n}` : `/?state=AP&t=${++n}${r.hash ?? ''}`;
          await page.goto(url);
          if (r.tab) {
            await page.waitForSelector('main', { timeout: 20_000 });
            await page.waitForLoadState('load');
            await page.waitForTimeout(300); // the dev server may still be reloading after dependency optimisation
            for (let attempt = 0; attempt < 4; attempt++) {
              try { await page.evaluate((tab) => window.dispatchEvent(new CustomEvent('pp-nav', { detail: tab })), r.tab); break; }
              catch (e) { if (!/context was destroyed|navigation/i.test(String(e)) || attempt === 3) throw e; await page.waitForLoadState('load'); await page.waitForTimeout(800); }
            }
          }
          await page.waitForSelector('main, body > *', { timeout: 20_000 });
          await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => { /* long polling or maps: axe still runs on what rendered */ });
          await page.waitForTimeout(400);
          // A dev-server hot reload (another editor saving a file) can destroy the page mid-run: wait for it to settle and run again.
          let res: Awaited<ReturnType<AxeBuilder['analyze']>> | undefined;
          for (let attempt = 0; attempt < 4 && !res; attempt++) {
            try { res = await new AxeBuilder({ page }).withTags(TAGS).analyze(); }
            catch (e) { if (!/context was destroyed|navigation/i.test(String(e)) || attempt === 3) throw e; await page.waitForLoadState('load'); await page.waitForTimeout(800); }
          }
          if (!res) throw new Error('axe did not run');
          for (const v of res.violations) rows.push({ route: r.name, lang, viewport: vpName, id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map((x) => x.target.join(' ')) });
          const blocking = res.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
          expect(blocking.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 5).map((x) => x.target.join(' ')).join(' | ')}`), `${r.name} ${lang} ${vpName}`).toEqual([]);
        });
      }
    });
  }
}

test.afterAll(() => {
  const out = process.env.A11Y_SWEEP_OUT;
  if (!out) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const existing: Row[] = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : [];
  fs.writeFileSync(out, JSON.stringify([...existing, ...rows], null, 1));
});
