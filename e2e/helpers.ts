import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** Open the app home page for a state. */
export async function openHome(page: Page, state: 'AP' | 'TG' = 'AP') {
  await page.goto(`/?state=${state}`);
  await expect(page.getByTestId('state-switcher')).toBeVisible();
}

/** On narrow viewports the nav may be behind a menu button. */
export async function revealNav(page: Page) {
  const nav = page.getByTestId('nav-elections');
  if (await nav.isVisible()) return nav;
  const toggle = page.locator('#mobile-menu-toggle');
  if (await toggle.count()) await toggle.click();
  await expect(nav).toBeVisible();
  return nav;
}

export async function openElections(page: Page, state: 'AP' | 'TG' = 'AP') {
  await openHome(page, state);
  const nav = await revealNav(page);
  await nav.click();
  await expect(page.getByTestId('elections-year-select')).toBeVisible();
}

export async function selectElection(page: Page, year: string, type: string) {
  await page.getByTestId('elections-year-select').selectOption(year);
  await page.getByTestId('elections-type-select').selectOption(type);
}

/** Go to a top-level tab by its nav label (Analytics, Constituencies, Survey, Methodology ...). */
export async function gotoTab(page: Page, label: RegExp) {
  const nav = page.getByTestId('nav-elections');
  if (!(await nav.isVisible())) await revealNav(page);
  const scope = page.locator('#mobile-navigation, nav, header').filter({ has: nav }).first();
  await scope.getByRole('button', { name: label }).first().click();
}

/** Search a constituency and open its profile. */
export async function openConstituency(page: Page, query: string) {
  await page.getByTestId('constituency-search').fill(query);
  const result = page.getByTestId('constituency-result').first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByTestId('constituency-profile')).toBeVisible();
}

/** Fill demographics and walk the verification step up to (and including) the OTP prompt. */
export async function startSurvey(page: Page, phone: string) {
  await page.locator('select').filter({ has: page.locator('option[value="18-25"]') }).selectOption('18-25');
  await page.locator('select').filter({ has: page.locator('option[value="Female"]') }).selectOption('Female');
  await page.getByRole('button', { name: /dual-factor/i }).first().click();
  await page.locator('input[type=tel]').fill(phone);
  await page.getByRole('button', { name: /get otp/i }).click();
  await expect(page.getByTestId('survey-submit')).toBeVisible();
}

/** A random valid Indian mobile number. */
export const randomPhone = () => '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');

/** Complete a whole survey submission using the simulation OTP. */
export async function submitSurvey(page: Page, phone: string) {
  await startSurvey(page, phone);
  await page.getByPlaceholder('e.g. 1234').fill('1234');
  await page.getByTestId('survey-submit').click();
}

export interface SeatInfo { acNo: number; acName: string; acNameTe?: string }

/** Fetch seats for a state's latest assembly election straight from the API, so tests do not hard-code seat names. */
export async function apiSeats(request: APIRequestContext, state: 'AP' | 'TG'): Promise<SeatInfo[]> {
  const states = await (await request.get('/api/v1/states')).json();
  const cfg = (states.states as { code: string; elections: { year: number; type: string }[] }[]).find((s) => s.code === state)!;
  const latest = cfg.elections.filter((e) => e.type === 'assembly').sort((a, b) => b.year - a.year)[0];
  const res = await request.get(`/api/v1/elections?state=${state}&year=${latest.year}&type=assembly`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const seats = (body.seats ?? body.results) as SeatInfo[];
  expect(seats.length).toBeGreaterThan(0);
  return seats;
}
