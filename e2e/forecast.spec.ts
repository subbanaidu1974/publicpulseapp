import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openElections } from './helpers';

const FORECAST = {
  state: 'TG',
  basedOn: [2018, 2023],
  method: 'Swing-adjusted margin simulation',
  disclaimer: 'Model projection from past results. Not a poll and not a prediction of any outcome.',
  blackout: false,
  seats: [
    { acNo: 1, acName: 'SIRPUR', leader: 'BJP', runnerUp: 'BRS', marginPct: 1.6, winProbLeader: 0.52, class: 'toss-up' },
    { acNo: 2, acName: 'CHENNUR', leader: 'INC', runnerUp: 'BRS', marginPct: 24.6, winProbLeader: 0.97, class: 'safe' },
    { acNo: 3, acName: 'BELLAMPALLI', leader: 'INC', runnerUp: 'BRS', marginPct: 8, winProbLeader: 0.75, class: 'lean' },
  ],
  alliances: [
    { alliance: 'INC', seatsMedian: 60, seatsP10: 50, seatsP90: 70, majorityProb: 0.45 },
    { alliance: 'BRS', seatsMedian: 40, seatsP10: 30, seatsP90: 50, majorityProb: 0.99 },
  ],
  backtest: { runs: [{ predictedFrom: { assembly: 2018 }, target: 2023, winnerHitRate: 0.7, persistenceHitRate: 0.72, meanAbsSeatError: 12.3 }], summary: 'x' },
};

async function mockForecast(page: Page, body: unknown, status = 200) {
  await page.route('**/api/v1/elections/*/forecast*', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}

test.describe('forecast panel and elections analytics', () => {
  test('@E2E-60 trend charts render with real data and provenance banner hides DEMO', async ({ page }) => {
    await mockForecast(page, { error: 'Not found' }, 404);
    await openElections(page, 'TG');
    const charts = page.getByTestId('trend-charts');
    await expect(charts.getByTestId('trend-seats-chart').first()).toBeVisible();
    await expect(charts.getByTestId('trend-share-chart').first()).toBeVisible();
    await expect(charts.getByTestId('trend-swing').first()).toBeVisible();
    await expect(charts.locator('svg[role="img"]').first()).toHaveAttribute('aria-label', /20(18|23)/);
    await expect(page.getByTestId('provenance-banner')).toContainText(/TCPD/);
    await expect(page.getByTestId('demo-badge')).toHaveCount(0);
    // table fallback available
    await charts.getByText(/show data table/i).first().click();
    await expect(charts.locator('table').first()).toBeVisible();
    // 404 forecast degrades quietly
    await expect(page.getByTestId('forecast-unavailable')).toBeVisible();
  });

  test('@E2E-61 forecast shows disclaimer, ranges, classes, toss-up table and back-test', async ({ page }) => {
    await mockForecast(page, FORECAST);
    await openElections(page, 'TG');
    const panel = page.getByTestId('forecast-panel');
    await expect(panel.getByTestId('forecast-disclaimer')).toBeVisible();
    await expect(panel).toContainText(/model projection from past results/i);
    await expect(panel.getByTestId('forecast-alliance')).toHaveCount(2);
    await expect(panel.getByTestId('forecast-alliance').first()).toContainText('50–70 (60)');
    await expect(panel.getByTestId('forecast-classes')).toContainText(/safe/i);
    await expect(panel.getByTestId('forecast-toss-table')).toContainText('SIRPUR');
    await expect(panel.getByTestId('forecast-toss-table')).not.toContainText('CHENNUR');
    await expect(panel.getByTestId('forecast-backtest-table')).toContainText('2018 → 2023');
    await expect(panel.getByTestId('forecast-backtest-sentence')).toContainText(/mechanical extrapolation, not an expectation/);
    await expect(panel.getByTestId('forecast-alliance').nth(1)).toContainText('>90%');
    await expect(panel.getByTestId('forecast-alliance').nth(1)).not.toContainText('99%');
    const ui = (await panel.locator(':scope > :not([data-testid="forecast-disclaimer"])').allInnerTexts()).join(' ');
    expect(ui).not.toMatch(/\b(poll|prediction)\b/i);
  });

  test('@E2E-62 blackout hides the forecast and shows only a notice', async ({ page }) => {
    await mockForecast(page, { ...FORECAST, blackout: true });
    await openElections(page, 'TG');
    const panel = page.getByTestId('forecast-panel');
    await expect(panel.getByTestId('forecast-blackout')).toBeVisible();
    await expect(page.getByTestId('forecast-disclaimer')).toHaveCount(0);
    await expect(page.getByTestId('forecast-alliance')).toHaveCount(0);
    await expect(page.getByTestId('forecast-toss-table')).toHaveCount(0);
  });

  test('@E2E-63 Telugu toggle translates analytics and forecast labels', async ({ page }) => {
    await mockForecast(page, FORECAST);
    await openElections(page, 'AP');
    await page.getByRole('button', { name: 'తెలుగు' }).first().click();
    await expect(page.getByTestId('forecast-panel')).toContainText('తదుపరి ఎన్నికల అంచనా దృశ్యం');
    await expect(page.getByTestId('trend-charts')).toContainText('ఎన్నికల వారీ ధోరణులు');
    await expect(page.getByTestId('provenance-banner')).toContainText('నిజమైన ఫలితాలు');
  });

  test('@E2E-64 axe: no critical violations on elections analytics and forecast', async ({ page }) => {
    await mockForecast(page, FORECAST);
    await openElections(page, 'TG');
    await expect(page.getByTestId('forecast-toss-table')).toBeVisible();
    await expect(page.getByTestId('trend-seats-chart').first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations.filter((v) => v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`)).toEqual([]);
  });

  test('@E2E-65 no horizontal overflow at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockForecast(page, FORECAST);
    await openElections(page, 'TG');
    await expect(page.getByTestId('trend-seats-chart').first()).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(0);
  });
});
