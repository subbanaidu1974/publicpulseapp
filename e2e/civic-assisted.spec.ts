import { test, expect, type APIRequestContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, bearer, findVillage, freshText, openCivicAs, seedPerson, uniq, type Seeded } from './civic-seed';

// Real server (ASSISTED_ENABLED=1 with a far sunset date comes from playwright.config.ts). People, roles and sessions are made through the
// test-only seed route, so every call below goes through the normal authorisation path. @E2E-59
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ticks = { adult: true, explained: true, willing_self: true, deletion_known: true };
type Volunteer = Seeded & { phone: string; pin: string };

async function seedVolunteer(request: APIRequestContext): Promise<Volunteer> {
  const r = await request.post(`${API}/e2e/person`, { data: { roles: [{ role: 'volunteer' }] } });
  expect(r.status()).toBe(201);
  const j = await r.json();
  return { token: j.token, personId: j.person_id, phone: j.phone, pin: j.pin };
}

/** A coordinator, two volunteers formed into a pair for the village, and a reviewer covering it. */
async function setup(request: APIRequestContext, ...names: string[]) {
  const village = await findVillage(request, ...(names.length ? names : ['Kolluru']));
  const coord = await seedPerson(request, [{ role: 'assist_coordinator' }]);
  const reviewer = await seedPerson(request, [{ role: 'assist_reviewer' }]);
  const a = await seedVolunteer(request), b = await seedVolunteer(request);
  const made = await request.post(`${API}/assisted/pairs`, { headers: bearer(coord.token), data: { village_lgd: village.lgd, member_a: a.personId, member_b: b.personId, label: 'e2e pair' } });
  expect(made.status(), await made.text()).toBe(201);
  return { village, coord, reviewer, a, b };
}
const apiRecord = (request: APIRequestContext, a: Volunteer, b: Volunteer, text: string) =>
  request.post(`${API}/assisted/records`, { headers: { ...bearer(a.token), 'x-assist-partner-authorization': `Bearer ${b.token}` }, data: { category: 'water', description_en: text, adult_attested: true, consent_a: ticks, consent_b: ticks } });

test.describe('assisted participation journey (@E2E-59)', () => {
  test('@E2E-59 pair signs in, consent first, records, receipt shown once, appears labelled, re-check logged', async ({ page, request }) => {
    const { reviewer, a, b } = await setup(request);
    const tag = `e2eas${uniq()}`;
    await openCivicAs(page, a.token);
    await expect(page.getByTestId('assisted-entry')).toBeVisible();
    // consent step comes first: nothing else is offered until both assistants tick every box
    await expect(page.getByTestId('as-script')).toBeVisible();
    await expect(page.getByTestId('as-step-form')).toHaveCount(0);
    await expect(page.getByTestId('as-consent-next')).toBeDisabled();
    for (const who of ['a', 'b']) for (const k of ['adult', 'explained', 'willing_self', 'deletion_known']) {
      await expect(page.getByTestId('as-consent-next')).toBeDisabled();
      await page.getByTestId(`as-tick-${who}-${k}`).check();
    }
    await expect(page.getByTestId('as-consent-next')).toBeEnabled();
    await page.getByTestId('as-consent-next').click();
    // the partner signs in with their own PIN
    await page.getByTestId('as-partner-phone').fill(b.phone);
    await page.getByTestId('as-partner-pin').fill('0000');
    await page.getByTestId('as-partner-signin').click();
    await expect(page.getByTestId('civic-error')).toBeVisible(); // a wrong PIN does not pass
    await page.getByTestId('as-partner-pin').fill(b.pin);
    await page.getByTestId('as-partner-signin').click();
    await expect(page.getByTestId('as-partner-ok')).toBeVisible();
    await page.getByTestId('as-words').fill(freshText(tag));
    await page.getByTestId('as-save').click();
    const code = (await page.getByTestId('as-receipt-code').textContent()) ?? '';
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await page.getByTestId('as-another').click();
    await expect(page.getByTestId('as-step-receipt')).toHaveCount(0); // the code is not shown again
    await expect(page.getByText(code)).toHaveCount(0);

    // the record is in the separate, labelled segment and nowhere in the organic list
    await openCivicAs(page, a.token);
    const seg = page.getByTestId('assisted-segment');
    await expect(seg.getByTestId('assisted-segment-label')).toHaveText('Reported with assistance');
    const item = seg.getByTestId('assisted-item').filter({ hasText: tag });
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId('assisted-badge')).toBeVisible();
    await expect(page.getByTestId('issue-feed').getByTestId('issue-item').filter({ hasText: tag })).toHaveCount(0);
    const segApi = await (await request.get(`${API}/assisted/segment`)).json();
    const mine = segApi.items.find((i: { snippet: string }) => i.snippet?.includes(tag));
    expect(mine).toMatchObject({ channel: 'assisted' });
    const organic = await (await request.get(`${API}/issues?limit=100`)).json();
    expect(JSON.stringify(organic)).not.toContain(tag);

    // the reviewer re-checks (a new pair: every record is queued) and the outcome is logged
    await openCivicAs(page, reviewer.token);
    await page.getByTestId('admin-more').click({ timeout: 2500 }).catch(() => undefined);
    await page.getByTestId('civic-tab-roles').click();
    await page.getByTestId('console-tab-assist_reviewer').click();
    const row = page.getByTestId('asrv-item').filter({ hasText: tag });
    await expect(row).toHaveCount(1);
    await row.getByTestId('asrv-note').fill('spoke to the person');
    await row.getByTestId('asrv-confirmed').click();
    await expect(page.getByTestId('asrv-msg')).toContainText(/recorded/i);
    await expect(page.getByTestId('asrv-item').filter({ hasText: tag })).toHaveCount(0);
    const queue = await (await request.get(`${API}/assisted/rechecks`, { headers: bearer(reviewer.token) })).json();
    expect(JSON.stringify(queue)).not.toContain(tag);
    // still shown after being confirmed
    expect((await (await request.get(`${API}/assisted/segment`)).json()).items.some((i: { snippet: string }) => i.snippet?.includes(tag))).toBe(true);
  });

  test('@E2E-59 coordinator forms and suspends a pair in the console; a suspended pair is refused', async ({ page, request }) => {
    // its own village: the area hold below must not stop the other tests' pairs, which run in parallel
    const { village, coord } = await setup(request, 'Bhimavaram');
    const a = await seedVolunteer(request), b = await seedVolunteer(request);
    await openCivicAs(page, coord.token);
    await page.getByTestId('admin-more').click({ timeout: 2500 }).catch(() => undefined);
    await page.getByTestId('civic-tab-roles').click();
    await page.getByTestId('console-tab-assist_coordinator').click();
    await page.getByTestId('asco-village').fill(village.lgd);
    await page.getByTestId('asco-a').fill(a.personId);
    await page.getByTestId('asco-b').fill(b.personId);
    const label = `pair${uniq()}`;
    await page.getByTestId('asco-label').fill(label);
    await page.getByTestId('asco-create').click();
    await expect(page.getByTestId('asco-msg')).toContainText(/formed/i);
    // the same volunteers cannot be paired twice
    await page.getByTestId('asco-a').fill(a.personId);
    await page.getByTestId('asco-b').fill(b.personId);
    await page.getByTestId('asco-create').click();
    await expect(page.getByTestId('civic-error')).toBeVisible();
    expect((await apiRecord(request, a, b, freshText('before'))).status()).toBe(201);
    const card = page.getByTestId('asco-pair').filter({ hasText: label });
    await card.getByTestId('asco-reason').fill('complaint from the village');
    await card.getByTestId('asco-suspend').click();
    await expect(page.getByTestId('asco-msg')).toContainText(/suspended/i);
    const refused = await apiRecord(request, a, b, freshText('after'));
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('pair_suspended');
    // lifting a manual suspension, and pausing the whole village, from the console
    await page.getByTestId('asco-pair').filter({ hasText: label }).getByTestId('asco-reason').fill('training finished');
    await page.getByTestId('asco-pair').filter({ hasText: label }).getByTestId('asco-reinstate').click();
    await expect(page.getByTestId('asco-msg')).toContainText(/active again/i);
    expect((await apiRecord(request, a, b, freshText('again'))).status()).toBe(201);
    await page.getByTestId('ash-unit').fill(village.lgd);
    await page.getByTestId('ash-reason').fill('dispute in the village');
    await page.getByTestId('ash-on').click();
    await expect(page.getByTestId('ash-msg')).toBeVisible();
    expect((await (await apiRecord(request, a, b, freshText('held'))).json()).code).toBe('village_suspended');
    await page.getByTestId('ash-off').click();
    await expect(page.getByTestId('ash-held')).toHaveCount(0);
    await expect(page.getByTestId('assisted-alerts')).toBeVisible();
  });

  test('@E2E-59 refusals: one assistant alone, a minor, personal details, and a person who deletes by receipt', async ({ request, page }) => {
    const { a, b } = await setup(request);
    const base = { category: 'water', description_en: freshText('refuse'), adult_attested: true, consent_a: ticks, consent_b: ticks };
    const alone = await request.post(`${API}/assisted/records`, { headers: bearer(a.token), data: base });
    expect(alone.status()).toBe(401);
    const hdr = { ...bearer(a.token), 'x-assist-partner-authorization': `Bearer ${b.token}` };
    expect((await (await request.post(`${API}/assisted/records`, { headers: hdr, data: { ...base, adult_attested: false } })).json()).code).toBe('adult_required');
    expect((await (await request.post(`${API}/assisted/records`, { headers: hdr, data: { ...base, consent_b: { ...ticks, willing_self: false } } })).json()).code).toBe('consent_required');
    expect((await (await request.post(`${API}/assisted/records`, { headers: hdr, data: { ...base, name: 'Someone' } })).json()).code).toBe('personal_field_not_allowed');
    const held = await (await request.post(`${API}/assisted/records`, { headers: hdr, data: { ...base, description_en: `${freshText('topic')} ask the party candidate` } })).json();
    expect(held.held).toBe(true);

    // deletion by receipt through the page
    const tag = `e2edel${uniq()}`;
    const ok = await apiRecord(request, a, b, freshText(tag));
    expect(ok.status()).toBe(201);
    const code = (await ok.json()).receipt_code as string;
    await openCivicAs(page, a.token);
    const item = page.getByTestId('assisted-item').filter({ hasText: tag });
    await expect(item).toHaveCount(1);
    await page.getByTestId('as-receipt-tools').locator('summary').click();
    await page.getByTestId('as-rc-code').fill(code);
    await page.getByTestId('as-rc-delete').click();
    await expect(page.getByTestId('as-rc-msg')).toContainText(/deleted/i);
    await openCivicAs(page, a.token);
    await expect(page.getByTestId('assisted-item').filter({ hasText: tag })).toHaveCount(0);
  });

  test('@E2E-59 Telugu at 375px: consent screen has no horizontal scroll and passes axe', async ({ page, request }) => {
    const { a } = await setup(request);
    await page.setViewportSize({ width: 375, height: 800 });
    await openCivicAs(page, a.token, 'te');
    const entry = page.getByTestId('assisted-entry');
    await expect(entry).toBeVisible();
    await expect(entry.getByRole('heading', { level: 2 })).toContainText('సహాయంతో');
    await expect(page.getByTestId('as-script')).toContainText('పేరు');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await page.getByTestId('as-consent-next').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    const bad = (await new AxeBuilder({ page }).include('[data-testid=assisted-entry]').withTags(TAGS).analyze()).violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([]);
  });
});
