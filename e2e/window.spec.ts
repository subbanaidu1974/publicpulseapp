import { test, expect, type Page } from '@playwright/test';
import { openElections } from './helpers';

const OPEN_FORECAST = {
  state: 'TG', basedOn: { assembly: 2023, assemblyPrev: 2018, ls: 2024 }, method: 'uniform-swing-damped-v1', blackout: false, window: 'open',
  disclaimer: 'Model projection from past results. Not a poll, not a prediction of any outcome.',
  dataSnapshot: { checksum: 'abcdef0123456789', signature: '1-2' },
  seats: [
    { acNo: 1, acName: 'SIRPUR', leader: 'BJP', runnerUp: 'BRS', marginPct: 1.6, winProbLeader: 0.52, class: 'toss-up' },
    { acNo: 2, acName: 'CHENNUR', leader: 'INC', runnerUp: 'BRS', marginPct: 24.6, winProbLeader: 0.97, class: 'safe' },
  ],
  alliances: [
    { alliance: 'INC', seatsMedian: 60, seatsP10: 50, seatsP90: 70, majorityProb: 0.45 },
    { alliance: 'BRS', seatsMedian: 40, seatsP10: 30, seatsP90: 50, majorityProb: 0.4 },
  ],
  backtest: {
    runs: [{ predictedFrom: { assembly: 2018 }, target: 2023, winnerHitRate: 0.7, persistenceHitRate: 0.72, meanAbsSeatError: 12.3 }],
    summary: 'x',
    calibration: [
      { lo: 0.5, hi: 0.6, n: 10, meanPredicted: 0.55, observed: 0.4 },
      { lo: 0.6, hi: 0.7, n: 0, meanPredicted: null, observed: null },
      { lo: 0.7, hi: 0.8, n: 20, meanPredicted: 0.75, observed: 0.7 },
      { lo: 0.8, hi: 0.9, n: 30, meanPredicted: 0.85, observed: 0.8 },
      { lo: 0.9, hi: 1, n: 50, meanPredicted: 0.97, observed: 0.92 },
    ],
  },
};

async function mockForecast(page: Page, body: unknown) {
  await page.route('**/api/v1/elections/*/forecast*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
}

test.describe('election window (S-118)', () => {
  test('@E2E-133 the real server fails closed: calendar unknown, forecast withheld with a notice and no seats', async ({ page, request }) => {
    const w = await (await request.get('/api/v1/election-window?state=AP')).json();
    test.skip(w.window !== 'unknown' || w.flagSource !== 'calendar', 'server is running with a window override');
    expect(w.forecast).toEqual({ show: false, reason: 'unknown' });
    expect(w.surveysAllowed).toBe(false);
    expect(w.notificationsAllowed).toBe(false);
    const f = await (await request.get('/api/v1/elections/AP/forecast')).json();
    expect(f.blackout).toBe(true);
    expect(f.seats).toBeUndefined();
    await openElections(page, 'AP');
    await expect(page.getByTestId('forecast-unknown')).toBeVisible();
    await expect(page.getByTestId('forecast-alliance')).toHaveCount(0);
    await expect(page.getByTestId('forecast-toss-table')).toHaveCount(0);
  });

  test('@E2E-133 the notice for an unknown window is translated', async ({ page }) => {
    await mockForecast(page, { ...OPEN_FORECAST, blackout: true, window: 'unknown', withheldReason: 'unknown', seats: undefined, alliances: undefined, backtest: undefined });
    await openElections(page, 'TG');
    await page.getByRole('button', { name: 'తెలుగు' }).first().click();
    await expect(page.getByTestId('forecast-unknown')).toContainText('క్యాలెండర్ నిర్ధారణ');
  });

  test('@E2E-133 an election-window blackout shows the blackout notice, not the unknown notice', async ({ page }) => {
    await mockForecast(page, { ...OPEN_FORECAST, blackout: true, window: 'blackout', withheldReason: 'blackout', seats: undefined, alliances: undefined, backtest: undefined });
    await openElections(page, 'TG');
    await expect(page.getByTestId('forecast-blackout')).toBeVisible();
    await expect(page.getByTestId('forecast-unknown')).toHaveCount(0);
  });

  test('@E2E-133 GET /election-window validates the state', async ({ request }) => {
    expect((await request.get('/api/v1/election-window')).status()).toBe(400);
    expect((await request.get('/api/v1/election-window?state=XX')).status()).toBe(404);
  });
});

test.describe('forecast product review (S-119)', () => {
  test('@E2E-134 shows a what-this-is-not box, calibration bins and the data snapshot beside the headline', async ({ page }) => {
    await mockForecast(page, OPEN_FORECAST);
    await openElections(page, 'TG');
    const panel = page.getByTestId('forecast-panel');
    await expect(panel.getByTestId('forecast-not')).toContainText(/Not a poll/);
    await expect(panel.getByTestId('forecast-not')).toContainText(/Not a prediction/);
    await expect(panel.getByTestId('forecast-calibration')).toBeVisible();
    await expect(panel.getByTestId('forecast-cal-row')).toHaveCount(5);
    await expect(panel.getByTestId('forecast-cal-row').first()).toContainText('50-60%');
    await expect(panel.getByTestId('forecast-cal-row').first()).toContainText('40%'); // observed hit rate shown beside the stated 55%
    await expect(panel.getByTestId('forecast-cal-row').nth(1)).toContainText(/No back-test seats/);
    await expect(panel.getByTestId('forecast-snapshot')).toContainText('abcdef0123456789');
    // the back-test sits in the same panel as the headline ranges
    await expect(panel.getByTestId('forecast-backtest')).toBeVisible();
    await expect(panel.getByTestId('forecast-alliance').first()).toBeVisible();
  });

  test('@E2E-134 the seat table can be hidden, stays hidden after reload, and the choice is reversible', async ({ page }) => {
    await mockForecast(page, OPEN_FORECAST);
    await openElections(page, 'TG');
    await expect(page.getByTestId('forecast-toss-table')).toBeVisible();
    await page.getByTestId('forecast-seats-toggle').click();
    await expect(page.getByTestId('forecast-toss-table')).toHaveCount(0);
    await expect(page.getByTestId('forecast-seats-toggle')).toHaveAttribute('aria-pressed', 'true');
    // persisted per viewer in localStorage; openElections reloads the page
    await openElections(page, 'TG');
    await expect(page.getByTestId('forecast-toss-table')).toHaveCount(0);
    await expect(page.getByTestId('forecast-backtest')).toBeVisible(); // hiding seats never hides the back-test
    await page.getByTestId('forecast-seats-toggle').click();
    await expect(page.getByTestId('forecast-toss-table')).toBeVisible();
  });

  test('@E2E-134 calibration and not-box are translated', async ({ page }) => {
    await mockForecast(page, OPEN_FORECAST);
    await openElections(page, 'TG');
    await page.getByRole('button', { name: 'తెలుగు' }).first().click();
    await expect(page.getByTestId('forecast-not')).toContainText('ఇది ఏమి కాదు');
    await expect(page.getByTestId('forecast-calibration')).toContainText('క్రమాంకనం');
  });
});

test.describe('share cards (S-122)', () => {
  test('@E2E-137 elections Share opens a card whose text has the figure, source and as-of date', async ({ page }) => {
    await mockForecast(page, { error: 'x' });
    await openElections(page, 'AP');
    await expect(page.getByTestId('elections-source')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('elections-share-button').click();
    const text = page.getByTestId('elections-share-text');
    await expect(text).toContainText(/Source: ECI/);
    await expect(text).toContainText(/Data as of: \S+/);
    await expect(page.getByTestId('elections-share-preview')).toHaveAttribute('src', /^data:image\/svg\+xml/);
    const svg = decodeURIComponent((await page.getByTestId('elections-share-preview').getAttribute('src'))!.split(',')[1]);
    expect(svg).toContain('Source');
    expect(svg).not.toMatch(/Model projection/); // a results card is not labelled a projection
  });

  test('@E2E-137 the forecast card carries the projection disclaimer and the data snapshot', async ({ page }) => {
    await mockForecast(page, OPEN_FORECAST);
    await openElections(page, 'TG');
    await page.getByTestId('forecast-share-button').click();
    const text = page.getByTestId('forecast-share-text');
    await expect(text).toContainText(/Not a poll, not a prediction/);
    await expect(text).toContainText(/abcdef0123456789/);
    await expect(text).toContainText(/Source: uniform-swing-damped-v1/);
  });

  test('@E2E-137 PNG download produces an image', async ({ page }) => {
    await mockForecast(page, OPEN_FORECAST);
    await openElections(page, 'TG');
    await page.getByTestId('forecast-share-button').click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('forecast-share-png').click()]);
    expect(dl.suggestedFilename()).toMatch(/\.png$/);
  });
});
