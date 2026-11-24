import { expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, bearer, findVillage, report, seedPerson, uniq, type Seeded } from './civic-seed';

/** Role holders for the scoped dashboards. Roles are real core roles created through the test-only seed route; nothing is faked. */
export async function seedRole(request: APIRequestContext, role: string, opts: { jurisdiction?: string; department?: string } = {}): Promise<Seeded> {
  const r = await request.post(`${API}/e2e/person`, { data: { roles: [{ role, ...opts }] } });
  expect(r.status(), 'seed route missing: CIVIC_E2E_SEED=1').toBe(201);
  const j = await r.json();
  return { token: j.token, personId: j.person_id };
}

export interface Geo { village: string; villageName: string; constituency: string; state: string; chain: string[] }
/** A real village, the constituency it belongs to and the state above it, from the public geo routes. */
export async function geoFor(request: APIRequestContext): Promise<Geo> {
  const v = await findVillage(request, 'Bhimavaram', 'Bhim', 'Kolluru');
  const c = await (await request.get(`${API}/geo/village/${encodeURIComponent(v.lgd)}/constituency`)).json();
  const u = await (await request.get(`${API}/geo/units/${encodeURIComponent(v.lgd)}`)).json();
  const state = (u.ancestors as { lgd: string; level: string }[]).find((a) => a.level === 'state');
  expect(c.constituencies?.length, 'village has a constituency').toBeGreaterThan(0);
  expect(state, 'village has a state ancestor').toBeTruthy();
  const constituency = c.constituencies[0].lgd as string;
  return { village: v.lgd, villageName: v.name, constituency, state: state!.lgd, chain: [constituency, ...(u.ancestors as { lgd: string }[]).map((a) => a.lgd)] };
}

/** Walk the dashboard's unit tree (state -> district -> mandal -> village, or from the unit a scoped role holds) down to a village and pick it. */
export async function pickViaTree(page: Page, geo: Geo): Promise<void> {
  const target = page.locator(`[data-testid=iss-pick][data-lgd="${geo.village}"]`);
  for (let i = 0; i < 6; i++) {
    await expect(page.getByTestId('unit-tree')).toBeVisible();
    await expect(page.getByTestId('tree-loading')).toHaveCount(0);
    await expect(page.getByTestId('tree-units')).toBeVisible();
    if (await target.count()) { await target.click(); return; }
    let opened: string | null = null;
    for (const lgd of geo.chain) {
      const row = page.locator(`[data-testid=tree-unit][data-lgd="${lgd}"]`);
      if (await row.count()) { await row.getByTestId('tree-open').click(); opened = lgd; break; }
    }
    if (!opened) throw new Error('the village is not reachable through the unit tree');
    await expect(page.getByTestId('tree-units')).toHaveAttribute('data-parent', opened);
  }
  throw new Error('unit tree too deep');
}

/** Enough fresh reports in one village and department for a cell to reach the minimum size (30). */
export async function fillCell(request: APIRequestContext, village: string, n = 31, category = 'water'): Promise<void> {
  const reporters: Seeded[] = [];
  for (let i = 0; i < Math.ceil(n / 6); i++) reporters.push(await seedPerson(request));
  const viewer = await seedPerson(request, [{ role: 'journalist' }]);
  // Similar reports in one village and category are merged by the server, so keep topping up with unrelated texts until a cell reaches the minimum size.
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < n; i++) await report(request, reporters[i % reporters.length].token, { category, village, text: `${uniq()} ${uniq()} ${uniq()} ${uniq()} ${uniq()} gutter overflow near ${uniq()} ${uniq()}` });
    const j = await (await request.get(`${API}/scope/issues/summary?unit=${encodeURIComponent(village)}`, { headers: bearer(viewer.token) })).json();
    if (j.cells.length > 0) return;
  }
  throw new Error('could not build a cell of minimum size');
}

export async function openDashboard(page: Page, token: string | null, lang: 'en' | 'te' = 'en') {
  await page.addInitScript(([t, l]) => {
    try { localStorage.setItem('pp-lang', l as string); } catch { /* ignore */ }
    try { if (t) sessionStorage.setItem('civic-token', t as string); } catch { /* ignore */ }
  }, [token, lang]);
  await page.goto('/#/dashboard');
  await expect(page.getByTestId('scope-page')).toBeVisible();
}

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
export const seriousViolations = async (page: Page) =>
  (await new AxeBuilder({ page }).include('[data-testid=scope-page]').withTags(TAGS).analyze()).violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);

export const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

export { bearer };
