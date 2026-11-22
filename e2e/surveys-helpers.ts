import crypto from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Real-server helpers for the Pulse Survey specs. People come from the test-only seeding route (CIVIC_E2E_SEED=1, never in production):
 * roles are REAL core roles, the respondent is a real T1 person with a declared village and a backdated account, and every survey below is
 * created, reviewed, approved and opened through the real routes. Fault injection and the published-figures success page live in
 * surveys-fixtures.ts (the only place that fakes a response).
 */
export const API = '/api/v1/civic';
export const S = `${API}/surveys`;
export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
export const uniq = () => crypto.randomBytes(4).toString('hex');
export const DAY = 86_400_000;

export interface Person { token: string; personId: string }
export async function seed(request: APIRequestContext, body: { roles?: { role: string; department?: string }[]; residence_unit?: string; backdate_days?: number; label?: string } = {}): Promise<Person> {
  const r = await request.post(`${API}/e2e/person`, { data: body });
  expect(r.status(), 'seed route missing: the server must run with CIVIC_E2E_SEED=1').toBe(201);
  const j = await r.json();
  return { token: j.token, personId: j.person_id };
}

let villageCache: string | null = null;
/** A real AP village (LGD code) found through the geography search. */
export async function apVillage(request: APIRequestContext): Promise<string> {
  if (villageCache) return villageCache;
  for (const q of ['Kolluru', 'Bhimavaram', 'Bhim']) {
    const r = await request.get(`${API}/geo/search?q=${encodeURIComponent(q)}`);
    const hit = (await r.json()).results?.[0];
    if (hit?.village?.lgd) { villageCache = hit.village.lgd as string; return villageCache; }
  }
  throw new Error('no village found in the geography data');
}
export const respondent = async (request: APIRequestContext) => seed(request, { residence_unit: await apVillage(request), backdate_days: 40, label: 'respondent' });

const opt = (en: string, te: string, prefer_not = false) => ({ label_en: en, label_te: te, prefer_not });
export function draftBody(title: string, over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    topic_class: 'issue_service', title_en: title, title_te: 'తాగునీటి సరఫరా సర్వే ' + title.slice(-6),
    scope: { state: 'AP', units: {} }, opens_at: new Date(now - 60_000).toISOString(), closes_at: new Date(now + 7 * DAY).toISOString(),
    questions: [{ kind: 'single', text_en: 'How reliable is the drinking water supply in your village?', text_te: 'మీ గ్రామంలో తాగునీటి సరఫరా ఎంత నమ్మదగినది?',
      options: [opt('Reliable', 'నమ్మదగినది'), opt('Sometimes reliable', 'కొన్నిసార్లు నమ్మదగినది'), opt('Not reliable', 'నమ్మదగినది కాదు'), opt('Prefer not to say', 'చెప్పడానికి ఇష్టపడను', true)] }],
    ...over,
  };
}

export async function review(request: APIRequestContext, p: Person, id: string, decision: 'approve' | 'reject', notes = '') {
  return request.post(`${S}/${id}/panel/review`, { headers: bearer(p.token), data: { decision, notes } });
}
export const panelist = (request: APIRequestContext, org: string) => seed(request, { roles: [{ role: 'survey_panel', department: org }], label: 'panel' });

export interface Made { id: string; title: string; creator: Person }
/** Create, submit and approve a survey through the real routes; optionally open it. A journalist is the creator (media quota, one per creator). */
export async function makeSurvey(request: APIRequestContext, o: { open?: boolean; approve?: boolean; submit?: boolean; body?: Record<string, unknown>; title?: string; creator?: Person } = {}): Promise<Made> {
  const title = o.title ?? `Water supply ${uniq()}`;
  const creator = o.creator ?? await seed(request, { roles: [{ role: 'journalist' }], label: 'creator' });
  const c = await request.post(S, { headers: bearer(creator.token), data: draftBody(title, o.body) });
  expect(c.status(), await c.text()).toBe(201);
  const id = (await c.json()).id as string;
  if (o.submit === false) return { id, title, creator };
  const s = await request.post(`${S}/${id}/submit`, { headers: bearer(creator.token), data: {} });
  expect(s.status(), await s.text()).toBe(200);
  if (o.approve === false && !o.open) return { id, title, creator };
  const a = await panelist(request, 'TDP'), b = await panelist(request, 'INC');
  expect((await review(request, a, id, 'approve')).status()).toBe(200);
  expect((await review(request, b, id, 'approve')).status()).toBe(200);
  if (o.open) { const op = await request.post(`${S}/${id}/open`, { headers: bearer(creator.token), data: {} }); expect(op.status(), await op.text()).toBe(200); }
  return { id, title, creator };
}

export async function gotoSurveys(page: Page, path = '', o: { lang?: 'en' | 'te'; token?: string } = {}) {
  await page.addInitScript(({ l, t }) => { try { localStorage.setItem('pp-lang', l); if (t) sessionStorage.setItem('civic-token', t); } catch { /* ignore */ } }, { l: o.lang ?? 'en', t: o.token ?? '' });
  await page.goto(`/?state=AP&t=${uniq()}#/surveys${path}`); // a new query string forces a full load (a hash-only change would keep the old session)
  await expect(page.getByTestId('surveys-root')).toBeVisible();
}
/** Hash navigation inside an already loaded page. */
export async function hashTo(page: Page, path: string) {
  await page.evaluate((p) => { window.location.hash = '#/surveys' + p; }, path);
  await expect(page.getByTestId('surveys-root')).toBeVisible();
}

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
export async function axeSurveys(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).include('[data-testid=surveys-root]').withTags(TAGS).analyze();
  return r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}
export async function noHorizontalScroll(page: Page) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s, `horizontal scroll: ${w.s} > ${w.c}`).toBeLessThanOrEqual(w.c + 1);
}
