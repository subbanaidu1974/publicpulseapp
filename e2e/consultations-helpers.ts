import crypto from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Real-server helpers for the bill-consultation specs. People come from the test-only seeding route (CIVIC_E2E_SEED=1, never in production):
 * the department officer, panel members and respondents hold REAL core roles / a declared village, and every consultation below is created,
 * submitted, approved by two panel members, opened, closed and reported through the real routes. Fault injection lives in
 * consultations-fixtures.ts. The server must run with SURVEY_MIN_CELL=2 SURVEY_ROUND_TO=1 SURVEY_PUBLISH_DELAY_HOURS=0 SURVEY_MIN_OPTION_COUNT=1
 * SURVEY_MIN_OPTION_SHARE=0 so that two respondents are enough to publish figures (the real suppression rule still applies below two).
 */
export const API = '/api/v1/civic';
export const C = `${API}/consultations`;
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
export async function apVillage(request: APIRequestContext): Promise<string> {
  if (villageCache) return villageCache;
  for (const q of ['Kolluru', 'Bhimavaram', 'Bhim']) {
    const hit = (await (await request.get(`${API}/geo/search?q=${encodeURIComponent(q)}`)).json()).results?.[0];
    if (hit?.village?.lgd) { villageCache = hit.village.lgd as string; return villageCache; }
  }
  throw new Error('no village found in the geography data');
}
export const respondent = async (request: APIRequestContext) => seed(request, { residence_unit: await apVillage(request), backdate_days: 40, label: 'respondent' });
export const officerOf = (request: APIRequestContext, dept: string) => seed(request, { roles: [{ role: 'officer', department: dept }], label: 'officer' });
export const panelist = (request: APIRequestContext) => seed(request, { roles: [{ role: 'survey_panel', department: 'TDP' }], label: 'panel' });

export interface ClauseSeed { ref: string; en: string; te: string; audio?: { group: string; file_id: string }[] }
export function draftBody(title: string, o: { clauses?: ClauseSeed[]; groups?: string[]; closesInMs?: number } = {}) {
  const clauses = o.clauses ?? [
    { ref: 'Section 4(2)', en: 'Farmers must register their land before selling crops to a state buyer.', te: 'రైతులు రాష్ట్ర కొనుగోలుదారుకు పంట అమ్మే ముందు తమ భూమిని నమోదు చేయాలి.' },
    { ref: 'Section 9', en: 'A tenant may continue to farm the land for five more years.', te: 'కౌలుదారు మరో ఐదు సంవత్సరాలు ఆ భూమిని సాగు చేయవచ్చు.' },
  ];
  return {
    title_en: title, title_te: 'వ్యవసాయ భూమి బిల్లు సంప్రదింపు ' + title.slice(-6), bill_ref: 'Draft Land Bill ' + title.slice(-6), source_url: 'https://prsindia.gov.in/bill/' + uniq(),
    scope: { state: 'AP', units: {} }, opens_at: new Date(Date.now() - 60_000).toISOString(), closes_at: new Date(Date.now() + (o.closesInMs ?? 7 * DAY)).toISOString(),
    affected_groups: o.groups ?? ['farmers', 'tenants'],
    clauses: clauses.map((c) => ({ original_ref: c.ref, summary_en: c.en, summary_te: c.te, audio: (c.audio ?? []).map((a) => ({ group: a.group, status: 'recorded', file_id: a.file_id, duration_s: 45 })) })),
  };
}

export interface Made { id: string; title: string; dept: string; officer: Person }
export async function makeConsultation(request: APIRequestContext, o: { stage?: 'in_review' | 'approved' | 'open' | 'closed'; clauses?: ClauseSeed[]; dept?: string; title?: string } = {}): Promise<Made> {
  const stage = o.stage ?? 'open';
  const dept = o.dept ?? `Dept ${uniq()}`, title = o.title ?? `Land bill ${uniq()}`;
  const officer = await officerOf(request, dept);
  const c = await request.post(C, { headers: bearer(officer.token), data: draftBody(title, { clauses: o.clauses }) });
  expect(c.status(), await c.text()).toBe(201);
  const id = (await c.json()).id as string;
  const s = await request.post(`${C}/${id}/submit`, { headers: bearer(officer.token), data: {} });
  expect(s.status(), await s.text()).toBe(200);
  const made = { id, title, dept, officer };
  if (stage === 'in_review') return made;
  for (let i = 0; i < 2; i++) {
    const p = await panelist(request);
    const r = await request.post(`${C}/${id}/panel/review`, { headers: bearer(p.token), data: { decision: 'approve', notes: '' } });
    expect(r.status(), await r.text()).toBe(200);
  }
  if (stage === 'approved') return made;
  const op = await request.post(`${C}/${id}/publish`, { headers: bearer(officer.token), data: {} });
  expect(op.status(), await op.text()).toBe(200);
  if (stage === 'open') return made;
  expect((await request.post(`${C}/${id}/close`, { headers: bearer(officer.token), data: {} })).status()).toBe(200);
  return made;
}
export async function give(request: APIRequestContext, p: Person, id: string, clause: number, stance: string, comment?: string, publicOk = false) {
  const r = await request.post(`${C}/${id}/feedback`, { headers: bearer(p.token), data: { clause, stance, ...(comment ? { comment } : {}), public_ok: publicOk } });
  expect(r.status(), await r.text()).toBeLessThan(300);
}

export async function gotoCons(page: Page, path = '', o: { lang?: 'en' | 'te'; token?: string } = {}) {
  await page.addInitScript(({ l, t }) => { try { localStorage.setItem('pp-lang', l); if (t) sessionStorage.setItem('civic-token', t); else sessionStorage.removeItem('civic-token'); } catch { /* ignore */ } }, { l: o.lang ?? 'en', t: o.token ?? '' });
  await page.goto(`/?state=AP&t=${uniq()}#/consultations${path}`); // a new query string forces a full load
  await expect(page.getByTestId('consultations-root')).toBeVisible();
}

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
export async function axeCons(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).include('[data-testid=consultations-root]').withTags(TAGS).analyze();
  return r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}
export async function noHorizontalScroll(page: Page) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s, `horizontal scroll: ${w.s} > ${w.c}`).toBeLessThanOrEqual(w.c + 1);
}
export async function assertTouchTargets(page: Page) {
  const small = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('[data-testid=consultations-root] button, [data-testid=consultations-root] input:not([type=hidden]), [data-testid=consultations-root] select, [data-testid=consultations-root] textarea, [data-testid=consultations-root] a.cn-btn').forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const isCheck = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
      const min = isCheck ? 24 : 44;
      if (r.width < min - 0.5 || r.height < min - 0.5) out.push(`${el.tagName}[${el.getAttribute('data-testid') ?? ''}] ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    return out;
  });
  expect(small, `controls below the minimum touch target: ${small.join(', ')}`).toEqual([]);
}
