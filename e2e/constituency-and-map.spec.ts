import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { openHome, openConstituency, gotoTab, apiSeats } from './helpers';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out); else if (/.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

test.describe('constituency search, analytics, compare', () => {
  test('@E2E-12 search by English name opens profile with history and census, no survey card', async ({ page, request }) => {
    const [seat] = await apiSeats(request, 'AP');
    await openHome(page, 'AP');
    await gotoTab(page, /constituenc/i);
    await openConstituency(page, seat.acName);
    const profile = page.getByTestId('constituency-profile');
    await expect(profile).toContainText(seat.acName);
    await expect(profile).toContainText(/census/i);
    // S-34 tail: the placeholder survey card is gone; a constituency profile never shows survey wording or a take-survey link
    await expect(profile).not.toContainText(/survey/i);
    await expect(page.getByTestId("constituency-survey-card")).toHaveCount(0);
    await expect(profile).toContainText(/20\d\d/); // election history years
  });

  test('@E2E-12 search by Telugu name returns results', async ({ page, request }) => {
    const seat = (await apiSeats(request, 'AP')).find((s) => s.acNameTe);
    test.skip(!seat, 'AP seat data has no Telugu names (acNameTe) yet; cannot exercise Telugu search');
    await openHome(page, 'AP');
    await gotoTab(page, /constituenc/i);
    await page.getByTestId('constituency-search').fill(seat!.acNameTe!);
    await expect(page.getByTestId('constituency-result').first()).toBeVisible();
  });

  for (const st of ["AP", "TG"] as const) {
    test(`@E2E-138 analytics for ${st} is state-aware and driven by real API data`, async ({ page, request }) => {
      await openHome(page, st);
      await gotoTab(page, /analytics/i);
      const page_ = page.getByTestId("analytics-page");
      await expect(page_).toBeVisible();
      await expect(page_.locator('[data-testid^="an-tally-"]').first()).toBeVisible();
      const sum = await (await request.get(`/api/v1/elections/${st}/summary?type=assembly`)).json();
      const [topParty, topSeats] = Object.entries(sum.tally as Record<string, number>).sort((x, y) => y[1] - x[1])[0];
      await expect(page.getByTestId(`an-tally-${topParty}`)).toContainText(String(topSeats));
      await expect(page_).toContainText(/census/i);
      await expect(page.getByTestId("ap-only-note")).toHaveCount(0);
      await expect(page_).not.toContainText(/approval|mock|simulat/i);
    });

    test(`@E2E-138 home for ${st} shows real seat counts, no fake counters`, async ({ page, request }) => {
      await openHome(page, st);
      const sum = await (await request.get(`/api/v1/elections/${st}/summary?type=assembly`)).json();
      await expect(page.getByTestId("home-stat-seats")).toContainText(String(sum.totalSeats));
      await expect(page.locator("main")).not.toContainText(/registered users|logged polls/i);
    });
  }

  test("@E2E-138 constituencies tab works for Telangana and has no synthetic profiler", async ({ page, request }) => {
    const [seat] = await apiSeats(request, "TG");
    await openHome(page, "TG");
    await gotoTab(page, /constituenc/i);
    await openConstituency(page, seat.acName);
    await expect(page.getByTestId("ap-only-note")).toHaveCount(0);
  });

  test("@E2E-138 leaflet css is self-hosted and no synthetic data in source", async ({ page }) => {
    const text = sourceFiles(path.join(process.cwd(), "src")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    expect(text).not.toMatch(/staticData|templateMLAs|unpkg\.com/);
    const reqs: string[] = [];
    page.on("request", (r) => reqs.push(r.url()));
    await openHome(page, "AP");
    await expect(page.getByTestId("home-map")).toBeVisible();
    expect(reqs.filter((u) => /unpkg/.test(u))).toEqual([]);
  });

  test('@E2E-14 compare constituencies across states side by side with sources', async ({ page, request }) => {
    const ap = (await apiSeats(request, 'AP'))[0];
    const tg = (await apiSeats(request, 'TG'))[0];
    await openHome(page, 'AP');
    await gotoTab(page, /constituenc/i);
    await openConstituency(page, ap.acName);
    await page.getByRole('button', { name: /compare/i }).first().click();
    await page.getByTestId('state-switcher').selectOption('TG');
    await openConstituency(page, tg.acName);
    await page.getByRole('button', { name: /compare/i }).first().click();
    const compare = page.getByTestId('constituency-compare');
    await expect(compare).toContainText(ap.acName);
    await expect(compare).toContainText(tg.acName);
    await expect(compare).toContainText(/(AP)/);
    await expect(compare).toContainText(/(TG)/);
    await expect(compare).toContainText(/source/i);
  });
});
