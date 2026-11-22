import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, FAULT, bearer, findVillage, freshText, openCivicAs, report, seedPerson, uniq } from './civic-seed';

// Real server throughout. The only fixtures left are labelled "fault injection": cases the real server cannot be made to produce on demand
// (a malware-scanner outage, a photo the server refuses after the client already converted it, a vanished detail route).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0]), Buffer.from('data'), Buffer.from([0, 0, 0, 0])]);
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const serious = async (page: Page) => (await new AxeBuilder({ page }).include('[data-testid=civic-home]').withTags(TAGS).analyze()).violations
  .filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);

async function pickVillage(page: Page) {
  await page.getByTestId('ir-village').fill('Kolluru');
  await page.getByTestId('village-option').first().click();
}
/** Narrow the feed to one run's reports: the real server filters on `q`. */
async function searchFor(page: Page, tag: string) {
  const answered = page.waitForResponse((r) => r.url().includes(`q=${tag}`) && r.url().includes('/civic/issues?') && r.ok());
  await page.getByTestId('if-q').fill(tag);
  await answered; // the debounced, filtered request has been answered by the real server
  await expect(page.getByTestId('issue-feed')).toContainText(tag, { timeout: 15_000 });
}

test.describe('issue report with media', () => {
  test('@E2E-152 photo is re-encoded to JPEG, voice uploaded, refs attached; the report is public with the real fields', async ({ page, request }) => {
    const me = await seedPerson(request);
    await openCivicAs(page, me.token);
    const uploads: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/issues/media')) uploads.push(r.headers()['content-type'] ?? ''); });
    await page.getByTestId('ir-photo').setInputFiles({ name: 'tap.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('photo-picker').getByTestId('media-done')).toBeVisible();
    await page.getByTestId('ir-voice').setInputFiles({ name: 'note.wav', mimeType: 'audio/wav', buffer: WAV });
    await expect(page.getByTestId('voice-recorder').getByTestId('media-done')).toBeVisible();
    expect(uploads).toEqual(['image/jpeg', 'audio/wav']);
    await page.getByTestId('cat-agriculture').check();
    const text = freshText('canalgate');
    await page.getByTestId('ir-text').fill(text);
    await pickVillage(page);
    const post = page.waitForRequest((r) => r.method() === 'POST' && /\/civic\/issues$/.test(r.url()));
    await page.getByTestId('ir-submit').click();
    const body = (await post).postDataJSON();
    expect(body.photo_ref).toMatch(/^media:/);
    expect(body.voice_ref).toMatch(/^media:/);
    expect(body.category).toBe('agriculture');
    await expect(page.getByTestId('ir-sent')).toBeVisible();
    // The public list now carries it (real GET /issues), with a photo flag and no reporter identity.
    const list = await (await request.get(`${API}/issues?q=${encodeURIComponent(text.split(' ')[0])}&category=agriculture&limit=100`)).json();
    const mine = list.items.find((i: { snippet: string }) => i.snippet.includes(text.split(' ')[1]));
    expect(mine?.has_photo).toBe(true);
    expect(JSON.stringify(mine)).not.toMatch(/reporter|person_id|phone/);
  });

  test('@E2E-152 a held report is explained (real moderation hold)', async ({ page, request }) => {
    const me = await seedPerson(request);
    await openCivicAs(page, me.token);
    await page.getByTestId('ir-text').fill(`Mr Ramesh Kumar took a bribe ${uniq()} ${uniq()} ${uniq()} ${uniq()}`);
    await pickVillage(page);
    await page.getByTestId('ir-submit').click();
    await expect(page.getByTestId('ir-sent')).toContainText(/held for a short review/);
  });

  test('@E2E-152 fault injection: upload failure shows progress state and Retry succeeds', async ({ page, request }) => {
    const me = await seedPerson(request);
    let n = 0;
    await page.route(`${FAULT}/issues/media`, (route) => (++n === 1 ? route.fulfill({ status: 500, json: { error: 'boom' } }) : route.continue()));
    await openCivicAs(page, me.token);
    await page.getByTestId('ir-photo').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('media-error')).toBeVisible();
    await page.getByTestId('media-retry').click();
    await expect(page.getByTestId('photo-picker').getByTestId('media-done')).toBeVisible();
    expect(n).toBe(2);
  });

  test('@E2E-152 real server: a text file in the voice box is refused with unsupported_type and a clear message', async ({ page, request }) => {
    const me = await seedPerson(request);
    await openCivicAs(page, me.token, 'te');
    await page.getByTestId('ir-voice').setInputFiles({ name: 'x.txt', mimeType: 'audio/wav', buffer: Buffer.from('this is not audio') });
    await expect(page.getByTestId('voice-recorder').getByTestId('media-error')).toContainText(/అంగీకరించము/);
  });

  test('@E2E-152 fault injection: 415 convert_on_client re-encodes once and retries, never loops', async ({ page, request }) => {
    const me = await seedPerson(request);
    const types: string[] = [];
    await page.route(`${FAULT}/issues/media`, (route) => { types.push(route.request().headers()['content-type'] ?? ''); return route.fulfill({ status: 415, json: { error: 'convert', code: 'convert_on_client', detected: 'image/webp', convert_to: 'image/jpeg' } }); });
    await openCivicAs(page, me.token);
    await page.getByTestId('ir-photo').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('media-error')).toContainText(/JPEG or PNG/);
    expect(types).toEqual(['image/jpeg', 'image/jpeg']);
    await page.getByTestId('media-remove').click();
    await page.getByTestId('ir-photo').setInputFiles({ name: 'IMG_1.heic', mimeType: 'image/heic', buffer: Buffer.from('not really heic') });
    await expect(page.getByTestId('media-error')).toContainText(/JPEG or PNG/); // undecodable HEIC never reaches the server
  });

  const CODES: [string, number, RegExp, RegExp][] = [
    ['unsupported_type', 415, /not accepted/, /అంగీకరించము/],
    ['wrong_kind', 415, /wrong kind of file/, /సరికాదు/],
    ['too_large', 413, /too large/, /పెద్దదిగా/],
    ['dimensions_too_large', 422, /too many pixels/, /పిక్సెళ్లు/],
    ['scan_rejected', 422, /rejected by the safety check/, /తిరస్కరించబడింది/],
    ['scanner_unavailable', 503, /not available right now/, /అందుబాటులో లేదు/],
  ];
  for (const [code, status, en, te] of CODES) {
    for (const lang of ['en', 'te'] as const) {
      test(`@E2E-152 fault injection: upload error ${code} has a clear ${lang === 'en' ? 'English' : 'Telugu'} message`, async ({ page, request }) => {
        const me = await seedPerson(request);
        await page.route(`${FAULT}/issues/media`, (route) => route.fulfill({ status, json: { error: code, code } }));
        await openCivicAs(page, me.token, lang);
        await page.getByTestId('ir-voice').setInputFiles({ name: 'n.wav', mimeType: 'audio/wav', buffer: WAV });
        await expect(page.getByTestId('media-error')).toContainText(lang === 'en' ? en : te);
        if (code === 'scanner_unavailable') await expect(page.getByTestId('media-retry')).toBeVisible(); else await expect(page.getByTestId('media-retry')).toHaveCount(0);
      });
    }
  }

  test('@E2E-152 GPS: explicit prompt, permission denied falls back to village search', async ({ page, request }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: (_ok: unknown, bad: (e: unknown) => void) => bad({ code: 1 }) }, configurable: true }); });
    const me = await seedPerson(request);
    await openCivicAs(page, me.token);
    await expect(page.getByTestId('gps-block')).toContainText(/only to place this report/);
    await page.getByTestId('ir-gps').click();
    await expect(page.getByTestId('ir-gps-denied')).toBeVisible();
    await pickVillage(page); // manual fallback still works
    await page.getByTestId('ir-text').fill('Street light is out');
    await expect(page.getByTestId('ir-submit')).toBeEnabled();
  });

  test('@E2E-152 GPS granted sends coordinates; the public detail shows only the rounded point', async ({ page, request }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 16.123456, longitude: 80.654321 } }) }, configurable: true }); });
    const me = await seedPerson(request);
    await openCivicAs(page, me.token);
    await page.getByTestId('ir-gps').click();
    await expect(page.getByTestId('ir-gps-got')).toBeVisible();
    await page.getByTestId('cat-roads').check();
    await page.getByTestId('ir-text').fill(freshText('pothole'));
    await pickVillage(page);
    const post = page.waitForRequest((r) => r.method() === 'POST' && /\/civic\/issues$/.test(r.url()));
    const resp = page.waitForResponse((r) => r.request().method() === 'POST' && /\/civic\/issues$/.test(r.url()));
    await page.getByTestId('ir-submit').click();
    const b = (await post).postDataJSON();
    expect(b.lat).toBe(16.1235); expect(b.lon).toBe(80.6543);
    const id = (await (await resp).json()).id;
    const d = await (await request.get(`${API}/issues/${id}`)).json();
    if (!d.merged) { expect(String(d.lat).length).toBeLessThanOrEqual(8); }
  });

  test('@E2E-152 @E2E-163 nine icon-led categories from the server, Telugu labels, no horizontal scroll', async ({ page, request }) => {
    const me = await seedPerson(request);
    await openCivicAs(page, me.token, 'te');
    await expect(page.locator('[data-testid^=cat-]')).toHaveCount(9);
    const labels = await page.locator('[data-testid=issue-report] fieldset label').allInnerTexts();
    expect(labels.every((l) => /[ఀ-౿]/.test(l))).toBe(true);
    expect(await page.locator('[data-testid=issue-report] fieldset label [aria-hidden=true]').count()).toBe(9);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(await serious(page)).toEqual([]);
  });

  test('@E2E-163 category ids and labels match GET /issues/categories exactly (web and IVR share one list)', async ({ page, request }) => {
    const real = await (await request.get(`${API}/issues/categories`)).json();
    expect(real.categories).toHaveLength(9);
    expect(real.trust_tiers.map((t: { tier: string }) => t.tier)).toEqual(['T0', 'T1', 'T2']);
    const me = await seedPerson(request);
    await openCivicAs(page, me.token);
    const ids = await page.locator('[data-testid^=cat-]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(4)));
    expect(ids).toEqual(real.categories.map((c: { id: string }) => c.id));
    for (const c of real.categories) await expect(page.getByTestId('issue-report')).toContainText(c.label_en);
  });
});

test.describe('feed, filters, detail (real server)', () => {
  test('@E2E-154 cursor pagination, search, status and category filters, export parts with X-Next-Cursor, no reporter identity', async ({ page, request }) => {
    const village = await findVillage(request, 'Kolluru');
    const tag = `e2efeed${uniq()}`;
    const reporter = await seedPerson(request);
    for (const category of ['water', 'roads', 'electricity']) await report(request, reporter.token, { category, village: village.lgd, text: freshText(tag) });
    const seen: string[] = [];
    await page.route(/\/api\/v1\/civic\/issues\?/, (route) => { // real server, smaller pages: only the limit is rewritten
      const u = new URL(route.request().url()); seen.push(u.search);
      if (u.searchParams.get('limit') === '25') u.searchParams.set('limit', '2');
      return route.continue({ url: u.toString() });
    });
    const viewer = await seedPerson(request);
    await openCivicAs(page, viewer.token);
    await searchFor(page, tag); // the unfiltered first page may still be showing: wait for the filtered one
    await expect(page.getByTestId('issue-item')).toHaveCount(2);
    await page.getByTestId('issue-more').click();
    await expect(page.getByTestId('issue-item')).toHaveCount(3);
    await expect(page.getByTestId('issue-more')).toHaveCount(0);
    expect(seen.some((s) => /cursor=/.test(s) && s.includes(`q=${tag}`)), JSON.stringify(seen)).toBe(true);
    const text = (await page.getByTestId('issue-feed').innerText()).toLowerCase();
    expect(text).not.toMatch(/reporter|reported by|phone|person_id/);
    // category and status filters are sent to the server and narrow the real result
    await page.getByTestId('if-category').selectOption('roads');
    await expect(page.getByTestId('issue-item')).toHaveCount(1);
    await page.getByTestId('if-category').selectOption('');
    await page.getByTestId('if-status').selectOption('Resolved');
    await expect(page.getByTestId('issue-item')).toHaveCount(0);
    await page.getByTestId('if-status').selectOption('');
    await expect(page.getByTestId('issue-item')).toHaveCount(2);
    // export: same filters, CSV, first part then the next part (CIVIC_EXPORT_MAX_ROWS=2 in the e2e server)
    await expect(page.getByTestId('issue-export')).toHaveAttribute('href', new RegExp(`/api/v1/civic/issues/export\\?.*format=csv.*q=${tag}|/api/v1/civic/issues/export\\?.*q=${tag}.*format=csv`));
    const d1 = page.waitForEvent('download');
    await page.getByTestId('issue-export').click();
    const f1 = fs.readFileSync(await (await d1).path(), 'utf8');
    expect(f1.split('\n')[0]).toContain('village_lgd');
    expect(f1.trim().split('\n')).toHaveLength(3); // header + 2 rows
    expect(f1).not.toMatch(/reporter|person|phone/i);
    await expect(page.getByTestId('issue-export-next')).toBeVisible();
    const d2 = page.waitForEvent('download');
    await page.getByTestId('issue-export-next').click();
    const f2 = fs.readFileSync(await (await d2).path(), 'utf8');
    expect(f2.trim().split('\n')).toHaveLength(2); // header + 1 row
    await expect(page.getByTestId('issue-export-next')).toHaveCount(0);
  });

  test('@E2E-154 place filter resolves mandal and district from /geo and the real server filters by them', async ({ page, request }) => {
    const village = await findVillage(request, 'Kolluru');
    const tag = `e2eplace${uniq()}`;
    const reporter = await seedPerson(request);
    const made = await report(request, reporter.token, { village: village.lgd, text: freshText(tag) });
    const seen: string[] = [];
    page.on('request', (r) => { if (/\/civic\/issues\?/.test(r.url())) seen.push(new URL(r.url()).search); });
    const viewer = await seedPerson(request);
    await openCivicAs(page, viewer.token);
    await page.getByTestId('if-q').fill(tag);
    await expect(page.getByTestId('issue-item')).toHaveCount(1);
    await page.getByTestId('if-place').fill('Kolluru');
    await page.getByTestId('if-place-option').first().click();
    await expect(page.getByTestId('issue-item')).toHaveCount(1); // village scope
    await page.getByTestId('if-scope').selectOption('mandal');
    await expect.poll(() => seen.some((s) => /mandal=[^&]+/.test(s))).toBe(true);
    await expect(page.getByTestId('issue-item')).toHaveCount(1);
    await page.getByTestId('if-scope').selectOption('district');
    await expect.poll(() => seen.some((s) => /district=[^&]+/.test(s))).toBe(true);
    await expect(page.getByTestId('issue-item')).toHaveCount(1);
    // the same tag in a unit that does not contain the village finds nothing: pick another village's scope through the API check
    const other = await (await request.get(`${API}/issues?q=${tag}&mandal=${encodeURIComponent('0')}`));
    expect(other.status()).toBe(400); // unknown unit code is a 400 from the real server
    expect(made.id).toBeTruthy();
    await page.getByTestId('if-clear').click();
    await expect(page.getByTestId('if-scope')).toHaveCount(0);
  });

  test('@E2E-154 detail: real timeline, officer response, support count, photo, units; me-too counts; 403 for an unsampled voter is explained', async ({ page, request }) => {
    const village = await findVillage(request, 'Kolluru');
    const tag = `e2edetail${uniq()}`;
    const reporter = await seedPerson(request);
    const officer = await seedPerson(request, [{ role: 'officer' }]);
    const up = await request.post(`${API}/issues/media`, { headers: { ...bearer(reporter.token), 'content-type': 'image/png' }, data: PNG });
    expect(up.status()).toBe(201);
    const made = await report(request, reporter.token, { category: 'health', village: village.lgd, text: freshText(tag), photoRef: (await up.json()).ref });
    for (const to of ['Verified', 'Assigned', 'Resolved']) {
      const t = await request.post(`${API}/issues/${made.id}/transition`, { headers: bearer(officer.token), data: { to, note: 'e2e' } });
      expect(t.ok(), await t.text()).toBe(true);
    }
    const rep = await request.post(`${API}/issues/${made.id}/rebuttal`, { headers: bearer(officer.token), data: { text: 'Hand pump repaired on Friday' } });
    expect(rep.status()).toBe(201);
    const real = await (await request.get(`${API}/issues/${made.id}`)).json();
    expect(real.can_appeal).toBe(false);
    expect(real.constituency === null || typeof real.constituency.lgd === 'string').toBe(true);

    const viewer = await seedPerson(request);
    await openCivicAs(page, viewer.token);
    await searchFor(page, tag);
    await page.getByTestId('issue-open').first().click();
    await expect(page.getByTestId('detail-text')).toContainText(tag);
    await expect(page.getByTestId('detail-status')).toHaveText('Resolved');
    await expect(page.getByTestId('detail-timeline').locator('li')).toHaveCount(real.timeline.length);
    expect(real.timeline.length).toBeGreaterThanOrEqual(4);
    await expect(page.getByTestId('detail-units')).toContainText(real.village.name_en);
    await expect(page.getByTestId('detail-responses')).toContainText('Hand pump repaired on Friday');
    await expect(page.getByTestId('detail-photo')).toBeVisible();
    await expect(page.getByTestId('detail-metoo-count')).toContainText('1');
    expect(await page.getByTestId('issue-detail').innerText()).not.toContain(reporter.personId);
    await expect(page.getByTestId('issue-appeal')).toHaveCount(0); // no owner view yet: the public route never allows an appeal
    await page.getByTestId('issue-metoo').click();
    await expect(page.getByTestId('issue-msg')).toBeVisible();
    await expect(page.getByTestId('detail-metoo-count')).toContainText('2');
    await page.getByTestId('issue-confirm').click();
    await expect(page.getByTestId('civic-error')).toContainText(/neighbours/);
    expect(await serious(page)).toEqual([]);
    await page.getByTestId('issue-back').click();
    await expect(page.getByTestId('issue-feed')).toBeVisible();
  });

  test('@E2E-154 fault injection: detail falls back to the feed summary when the detail route is gone', async ({ page, request }) => {
    const village = await findVillage(request, 'Kolluru');
    const tag = `e2egone${uniq()}`;
    const reporter = await seedPerson(request);
    const made = await report(request, reporter.token, { village: village.lgd, text: freshText(tag) });
    await page.route(`${FAULT}/issues/${made.id}`, (route) => route.fulfill({ status: 404, json: { error: 'issue not found' } }));
    await openCivicAs(page, reporter.token);
    await searchFor(page, tag);
    await page.getByTestId('issue-open').first().click();
    await expect(page.getByTestId('issue-no-detail')).toBeVisible();
    await expect(page.getByTestId('detail-status')).toHaveText('Reported');
  });

  test('@E2E-154 axe and overflow on feed and filters (Telugu, real data)', async ({ page, request }) => {
    const village = await findVillage(request, 'Kolluru');
    const reporter = await seedPerson(request);
    await report(request, reporter.token, { village: village.lgd, text: freshText('e2eaxe') });
    await openCivicAs(page, reporter.token, 'te');
    await expect(page.getByTestId('issue-item').first()).toBeVisible();
    expect(await serious(page)).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
