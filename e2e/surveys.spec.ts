import { test, expect, type Page } from '@playwright/test';
import { S, apVillage, axeSurveys, bearer, gotoSurveys, hashTo, makeSurvey, noHorizontalScroll, panelist, respondent, review, seed, uniq } from './surveys-helpers';
import { mockElectionChoice, mockFigures } from './surveys-fixtures';

// Pulse Survey screens against the REAL server (serial: run with --workers=1). Stories: E2E-37 registry/lifecycle, E2E-38 eligibility,
// E2E-39 anonymous credential, E2E-40 single-shot response, E2E-41/42 published figures, E2E-43 election-window rules.
test.describe.configure({ mode: 'serial' });

const DISCLAIMER = /Opinion survey, not an election and not a forecast/;

async function assertTouchTargets(page: Page) {
  const small = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('[data-testid=surveys-root] button, [data-testid=surveys-root] input:not([type=hidden]), [data-testid=surveys-root] select, [data-testid=surveys-root] textarea, [data-testid=surveys-root] a.sv-btn').forEach((el) => {
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

test.describe('registry and detail', () => {
  test('@E2E-37 registry lists surveys the same way for every creator, with hash, history link and public cancellation reason', async ({ page, request }) => {
    const open = await makeSurvey(request, { open: true });
    const cancelled = await makeSurvey(request, { open: true });
    const c = await request.post(`${S}/${cancelled.id}/cancel`, { headers: bearer(cancelled.creator.token), data: { reason_code: 'duplicate', reason_text: 'Duplicate of an existing survey in the registry' } });
    expect(c.status()).toBe(200);
    await gotoSurveys(page);
    await expect(page.getByTestId('survey-heading')).toBeVisible();
    await expect(page.getByTestId('survey-disclaimer')).toContainText(DISCLAIMER);
    await expect(page.getByTestId('survey-protection')).toBeVisible();
    const card = page.locator(`[data-survey-id="${open.id}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('survey-card-creator')).toContainText('Media');
    await expect(card.getByTestId('survey-card-hash')).toHaveText(/^[0-9a-f]{10}$/);
    await expect(card.getByTestId('survey-card-history')).toHaveAttribute('href', `#/surveys/${open.id}/versions`);
    const cc = page.locator(`[data-survey-id="${cancelled.id}"]`);
    await expect(cc.getByTestId('survey-cancel-reason')).toContainText('Duplicate of an existing survey in the registry');
    // filters (real server): search narrows the list to the one survey; status filter shows the cancelled one
    await page.getByTestId('reg-search').fill(open.title);
    await expect(page.getByTestId('survey-card')).toHaveCount(1);
    await page.getByTestId('reg-search').fill('');
    await page.getByTestId('reg-status').selectOption('cancelled');
    await expect(page.locator(`[data-survey-id="${cancelled.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-survey-id="${open.id}"]`)).toHaveCount(0);
    // no party colour styling or ranking: every card has the same class list
    await page.getByTestId('reg-status').selectOption('');
    const classes = await page.getByTestId('survey-card').evaluateAll((els) => [...new Set(els.map((e) => e.className))]);
    expect(classes.length).toBe(1);
  });

  test('@E2E-37 "load more" follows the server cursor', async ({ page, request }) => {
    await makeSurvey(request, { open: true });
    await makeSurvey(request, { open: true });
    await page.route(/\/api\/v1\/civic\/surveys\?/, (route) => route.continue({ url: route.request().url().replace(/limit=\d+/, 'limit=1') }));
    await gotoSurveys(page);
    await expect(page.getByTestId('survey-card')).toHaveCount(1);
    await page.getByTestId('reg-more').click();
    await expect(page.getByTestId('survey-card')).toHaveCount(2);
  });

  test('@E2E-37 public change log shows registrations and the cancellation reason', async ({ page, request }) => {
    const made = await makeSurvey(request, { open: true });
    await request.post(`${S}/${made.id}/cancel`, { headers: bearer(made.creator.token), data: { reason_code: 'wording_dispute', reason_text: 'The wording was disputed by the panel' } });
    await gotoSurveys(page, '/log');
    await expect(page.getByTestId('registry-log')).toBeVisible();
    await expect(page.getByTestId('log-entry').first()).toBeVisible();
    await expect(page.getByTestId('survey-disclaimer')).toContainText(DISCLAIMER);
    const kinds = await page.getByTestId('log-entry').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
    expect(kinds).toContain('registered');
    expect(kinds).toContain('cancelled');
  });

  test('@E2E-37 detail shows the frozen wording, version hashes, panel decisions without identities, and who can answer', async ({ page, request }) => {
    const made = await makeSurvey(request, { open: true });
    await gotoSurveys(page, `/${made.id}`);
    await expect(page.getByTestId('survey-heading')).toHaveText(made.title);
    await expect(page.getByTestId('survey-disclaimer')).toContainText(DISCLAIMER);
    await expect(page.getByTestId('detail-questions')).toContainText('How reliable is the drinking water supply in your village?');
    await expect(page.getByTestId('detail-who')).toBeVisible();
    await expect(page.getByTestId('version-row')).toHaveCount(1);
    await page.getByTestId('ver-toggle-1').click();
    await expect(page.getByTestId('ver-wording-1')).toContainText('Reliable');
    await expect(page.getByTestId('detail-panel')).toContainText('2 of 2');
    const panelText = await page.getByTestId('detail-panel').locator('xpath=..').innerText();
    expect(panelText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no reviewer ids
    await expect(page.getByTestId('panel-decision')).toHaveCount(2);
    // the protection box states the per-channel secrecy truthfully
    const prot = page.getByTestId('survey-protection');
    await expect(prot.getByTestId('prot-app')).toContainText(/cannot link/i);
    await expect(prot.getByTestId('prot-assisted')).toContainText(/can link/i);
    await expect(prot.getByTestId('prot-once')).toContainText(/one answer/i);
    await expect(prot.getByTestId('prot-lost')).toContainText(/10 minutes/i);
  });

  test('@E2E-43 an election-choice survey in a blackout shows a neutral notice and no wording', async ({ page, request }) => {
    // The class is off on a real server; the real detail payload is rewritten only to say election_choice, the figures refusal is real.
    const made = await makeSurvey(request, { open: true });
    await mockElectionChoice(page, made.id);
    await gotoSurveys(page, `/${made.id}/figures`);
    await expect(page.getByTestId('fig-not-published')).toBeVisible();
    await expect(page.getByTestId('fig-blackout')).toBeVisible();
  });
});

test.describe('take flow', () => {
  test('@E2E-38 the Take button explains exactly why a person cannot answer', async ({ page, request }) => {
    const made = await makeSurvey(request, { open: true });
    // not signed in
    await gotoSurveys(page, `/${made.id}`);
    await expect(page.getByTestId('take-box')).toHaveAttribute('data-take-state', 'signin');
    // a brand-new account: waiting period (server reason + date)
    const fresh = await seed(request, { label: 'fresh' });
    await page.addInitScript((t) => { sessionStorage.setItem('civic-token', t); }, fresh.token);
    await page.reload();
    await expect(page.getByTestId('take-box')).toHaveAttribute('data-take-state', 'not_eligible_account_too_new');
    await expect(page.getByTestId('take-msg')).toContainText(/waiting period/i);
    // old account but no declared village
    const noVillage = await seed(request, { backdate_days: 40, label: 'novillage' });
    await page.addInitScript((t) => { sessionStorage.setItem('civic-token', t); }, noVillage.token);
    await page.reload();
    await expect(page.getByTestId('take-box')).toHaveAttribute('data-take-state', 'not_eligible_tier_too_low');
    // outside scope: a TG survey, an AP resident
    const tg = await makeSurvey(request, { open: true, body: { scope: { state: 'TG', units: {} } } });
    const ap = await respondent(request);
    await page.addInitScript((t) => { sessionStorage.setItem('civic-token', t); }, ap.token);
    await hashTo(page, `/${tg.id}`);
    await page.reload();
    await expect(page.getByTestId('take-box')).toHaveAttribute('data-take-state', 'not_eligible_outside_scope');
    // approved but not open yet, and a closed survey
    const approved = await makeSurvey(request, { approve: true });
    await hashTo(page, `/${approved.id}`);
    await page.reload();
    await expect(page.getByTestId('take-box')).toHaveAttribute('data-take-state', 'not_open_not_yet');
    const closed = await makeSurvey(request, { open: true });
    expect((await request.post(`${S}/${closed.id}/close`, { headers: bearer(closed.creator.token), data: {} })).status()).toBe(200);
    await hashTo(page, `/${closed.id}`);
    await page.reload();
    await expect(page.getByTestId('take-box')).toHaveAttribute('data-take-state', 'not_open_closed');
    // an eligible person
    await hashTo(page, `/${(await makeSurvey(request, { open: true })).id}`);
    await page.reload();
    await expect(page.getByTestId('take-box')).toHaveAttribute('data-take-state', 'eligible');
    await expect(page.getByTestId('take-button')).toBeVisible();
  });

  test('@E2E-39 @E2E-40 answers once through a blind-signed token; the respond request carries no bearer token and no cookies; the answer is final', async ({ page, request }) => {
    const made = await makeSurvey(request, { open: true });
    const me = await respondent(request);
    await gotoSurveys(page, `/${made.id}`, { token: me.token });
    await expect(page.getByTestId('take-box')).toHaveAttribute('data-take-state', 'eligible');
    await page.getByTestId('take-button').click();
    await expect(page.getByTestId('take-form')).toBeVisible();
    await expect(page.getByTestId('survey-protection')).toContainText(/10 minutes/);
    await expect(page.getByTestId('take-submit')).toBeDisabled();
    await page.getByTestId('take-option').first().check();
    await page.getByTestId('take-age').selectOption('25-34');
    await page.getByTestId('take-gender').selectOption('NS');
    await page.getByTestId('take-final').check();
    await expect(page.getByTestId('take-submit')).toBeEnabled();
    // a cookie on the origin must not travel with the anonymous request either
    await page.context().addCookies([{ name: 'tracker', value: 'x', url: page.url() }]);
    const respondReq = page.waitForRequest((r) => r.url().endsWith(`/${made.id}/respond`));
    const credReq = page.waitForRequest((r) => r.url().endsWith(`/${made.id}/credential/request`));
    await page.getByTestId('take-submit').click();
    const cred = await credReq;
    expect((await cred.allHeaders()).authorization).toBeTruthy(); // the credential request is authenticated ...
    const rq = await respondReq;
    const headers = await rq.allHeaders();
    expect(headers.authorization, 'respond must carry no Authorization header').toBeUndefined();
    expect(headers.cookie, 'respond must carry no cookies').toBeUndefined();
    const body = rq.postDataJSON();
    expect(Object.keys(body).sort()).toEqual(['answers', 'prefix', 'signature', 'strata', 'token']); // ... and respond has no person identifier
    expect(JSON.stringify(body)).not.toContain(me.personId);
    await expect(page.getByTestId('take-done')).toBeVisible();
    await expect(page.getByTestId('take-done')).toContainText(/no receipt/i);
    // final: the page now says already answered, the server refuses another credential
    await page.goto(`/?state=AP#/surveys/${made.id}`);
    await page.reload();
    await expect(page.getByTestId('take-box')).toHaveAttribute('data-take-state', 'responded');
    const again = await request.post(`${S}/${made.id}/credential/request`, { headers: bearer(me.token), data: { blinded: 'A'.repeat(342), nonce: 'n'.repeat(24), key_class: 'T1' } });
    expect(again.status()).toBe(409);
    expect((await again.json()).error).toBe('already_responded');
  });

  test('@E2E-40 a wrong answer set is refused with a readable message and the token is not used up', async ({ page, request }) => {
    const made = await makeSurvey(request, { open: true });
    const me = await respondent(request);
    await gotoSurveys(page, `/${made.id}/take`, { token: me.token });
    await expect(page.getByTestId('take-form')).toBeVisible();
    await page.route(new RegExp(`/${made.id}/respond$`), (route) => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_response', message: 'bad' }) }));
    await page.getByTestId('take-option').first().check();
    await page.getByTestId('take-age').selectOption('18-24');
    await page.getByTestId('take-gender').selectOption('F');
    await page.getByTestId('take-final').check();
    await page.getByTestId('take-submit').click();
    await expect(page.getByTestId('survey-error')).toContainText(/not used up/i);
  });
});

test.describe('creator console and panel', () => {
  test('@E2E-37 console is gated by the server: signed-out and plain accounts are told why', async ({ page, request }) => {
    await gotoSurveys(page, '/console');
    await expect(page.getByTestId('console-signin')).toBeVisible();
    const plain = await seed(request);
    await gotoSurveys(page, '/console', { token: plain.token });
    await expect(page.getByTestId('console-forbidden')).toBeVisible();
  });

  test('@E2E-37 write a survey with live wording checks, submit it, then the panel approves, creator opens and cancels with a public reason', async ({ page, request }) => {
    const creator = await seed(request, { roles: [{ role: 'journalist' }], label: 'creator' });
    await gotoSurveys(page, '/new', { token: creator.token });
    const title = `Road repair ${uniq()}`;
    await page.getByTestId('bld-title-en').fill(title);
    await page.getByTestId('bld-title-te').fill('రోడ్ల మరమ్మత్తు సర్వే');
    await page.getByTestId('bld-text-en').fill('Obviously the roads are in bad shape, are they not?');
    await page.getByTestId('bld-text-te').fill('మీ గ్రామంలో రోడ్ల పరిస్థితి ఎలా ఉంది?');
    const opts = page.getByTestId('bld-option');
    await opts.nth(0).getByTestId('bld-opt-en').fill('Good'); await opts.nth(0).getByTestId('bld-opt-te').fill('బాగుంది');
    await opts.nth(1).getByTestId('bld-opt-en').fill('Poor'); await opts.nth(1).getByTestId('bld-opt-te').fill('బాగాలేదు');
    // the server's wording check appears without pressing anything
    await expect(page.getByTestId('findings')).toContainText(/obviously/i, { timeout: 15_000 });
    await page.getByTestId('bld-text-en').fill('How would you describe the state of the roads in your village?');
    await expect(page.getByTestId('findings-none')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('bld-submit').click();
    await expect(page.getByTestId('my-survey').first()).toBeVisible();
    const row = page.locator('[data-testid=my-survey][data-status=in_review]').first();
    await expect(row).toContainText(title);
    await expect(row.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('quota-meter')).toContainText('1 of 1');
    const id = (await row.getAttribute('data-survey-id'))!;

    // the panel: one reviewer in the UI, a second through the API
    const a = await panelist(request, 'TDP');
    await gotoSurveys(page, '/panel', { token: a.token });
    const item = page.locator(`[data-testid=queue-item][data-survey-id="${id}"]`);
    await item.getByTestId('queue-open').click();
    await expect(item.getByTestId('review-wording')).toContainText('state of the roads');
    await item.getByTestId('review-approve').click();
    await expect(page.getByTestId('review-done')).toHaveAttribute('data-status', 'in_review');
    expect((await review(request, await panelist(request, 'INC'), id, 'approve')).status()).toBe(200);

    await gotoSurveys(page, '/console', { token: creator.token });
    const approved = page.locator(`[data-testid=my-survey][data-survey-id="${id}"]`);
    await expect(approved).toHaveAttribute('data-status', 'approved');
    await approved.getByTestId('my-open').click();
    await expect(page.locator(`[data-testid=my-survey][data-survey-id="${id}"]`)).toHaveAttribute('data-status', 'open');
    // cancel needs a reason code and text
    const open = page.locator(`[data-testid=my-survey][data-survey-id="${id}"]`);
    await open.getByTestId('my-cancel').click();
    await expect(open.getByTestId('cancel-submit')).toBeDisabled();
    await open.getByTestId('cancel-code').selectOption('creator_withdrew');
    await open.getByTestId('cancel-text').fill('Withdrawn because the repair scheme was already announced');
    await open.getByTestId('cancel-submit').click();
    await expect(page.locator(`[data-testid=my-survey][data-survey-id="${id}"]`)).toHaveAttribute('data-status', 'cancelled');
    await gotoSurveys(page, `/${id}`);
    await expect(page.getByTestId('survey-cancel-reason')).toContainText('repair scheme was already announced');
  });

  test('@E2E-37 a reviewer cannot review their own survey and sees why; a rejection needs notes', async ({ page, request }) => {
    const both = await seed(request, { roles: [{ role: 'journalist' }, { role: 'survey_panel', department: 'media' }], label: 'both' });
    const own = await makeSurvey(request, { approve: false, creator: both });
    await gotoSurveys(page, '/panel', { token: both.token });
    const item = page.locator(`[data-testid=queue-item][data-survey-id="${own.id}"]`);
    await item.getByTestId('queue-open').click();
    await item.getByTestId('review-approve').click();
    await expect(item.getByTestId('survey-error')).toContainText(/cannot review/i);
    const other = await makeSurvey(request, { approve: false });
    const p = await panelist(request, 'TDP');
    await gotoSurveys(page, '/panel', { token: p.token });
    const it2 = page.locator(`[data-testid=queue-item][data-survey-id="${other.id}"]`);
    await it2.getByTestId('queue-open').click();
    await it2.getByTestId('review-reject').click();
    await expect(it2.getByTestId('survey-error')).toBeVisible();
    await it2.getByTestId('review-notes').fill('The second option is leading');
    await it2.getByTestId('review-reject').click();
    await expect(page.getByTestId('review-done')).toHaveAttribute('data-status', 'draft');
  });
});

test.describe('published figures', () => {
  test('@E2E-41 before publication the page says figures come after the survey closes (real server)', async ({ page, request }) => {
    const made = await makeSurvey(request, { open: true });
    await gotoSurveys(page, `/${made.id}/figures`);
    await expect(page.getByTestId('fig-not-published')).toContainText(/after the survey closes/i);
    await expect(page.getByTestId('survey-disclaimer')).toContainText(DISCLAIMER);
    await expect(page.getByTestId('fig-not-random')).toBeVisible();
  });

  test('@E2E-41 @E2E-42 figures show weighted and unweighted side by side, sample sizes, quality parts, suppression notes and one dimension at a time (fixture snapshot)', async ({ page, request }) => {
    const made = await makeSurvey(request, { open: true });
    await mockFigures(page, made.id);
    await gotoSurveys(page, `/${made.id}/figures`);
    const app = page.locator('[data-testid=fig-stratum][data-channel=app]');
    await expect(app).toBeVisible();
    await expect(app.getByTestId('fig-sample-n')).toHaveText('240');
    await expect(app.getByTestId('fig-effective-n')).toHaveText('190');
    await expect(app.getByTestId('fig-quality-score')).toHaveText('71');
    await expect(app.getByTestId('fig-quality-part')).toHaveCount(4);
    await expect(app.getByTestId('fig-weighting')).toContainText(/gender/);
    await expect(app.getByTestId('fig-sampling-note')).toContainText(/not a random sample/i);
    await expect(app.getByTestId('fig-rolled-up')).toContainText('2');
    const row = app.getByTestId('fig-row').first();
    await expect(row.getByTestId('fig-unweighted')).toHaveText('50%');
    await expect(row.getByTestId('fig-weighted')).toHaveText('45.5%');
    // assisted answers are a separate stratum with their own warning
    const assisted = page.locator('[data-testid=fig-stratum][data-channel=assisted]');
    await expect(assisted.getByTestId('fig-assisted-note')).toContainText(/can link/i);
    // exactly one dimension at a time: radios, and each request carries a single ?by
    const urls: string[] = [];
    page.on('request', (r) => { if (/\/results\?/.test(r.url())) urls.push(r.url()); });
    await page.getByTestId('fig-dim-age_band').check();
    await expect(page.locator('[data-testid=fig-cell]').first()).toContainText('18-24');
    expect(urls.some((u) => /by=age_band$/.test(u))).toBe(true);
    expect(urls.every((u) => (new URL(u).searchParams.getAll('by').length === 1))).toBe(true);
    await expect(page.locator('[data-testid=fig-dim] input[type=radio]')).toHaveCount(4);
    await page.getByTestId('fig-method-toggle').click();
    await expect(page.getByTestId('fig-method-weights')).toContainText(/same/i);
    await expect(page.getByTestId('fig-not-random')).toBeVisible();
    await expect(page.getByTestId('fig-method-link')).toBeVisible();
  });
});

for (const lang of ['en', 'te'] as const) {
  test.describe(`accessibility (${lang})`, () => {
    test(`@E2E-37 axe, touch targets and no horizontal scroll on the survey screens (${lang})`, async ({ page, request }) => {
      const made = await makeSurvey(request, { open: true });
      const me = await respondent(request);
      const creator = await seed(request, { roles: [{ role: 'journalist' }], label: 'creator' });
      await gotoSurveys(page, '', { lang, token: me.token });
      await expect(page.getByTestId('survey-card').first()).toBeVisible();
      expect(await axeSurveys(page), 'registry').toEqual([]);
      await assertTouchTargets(page); await noHorizontalScroll(page);
      await hashTo(page, `/${made.id}`);
      await expect(page.getByTestId('take-box')).toHaveAttribute('data-take-state', 'eligible');
      expect(await axeSurveys(page), 'detail').toEqual([]);
      await assertTouchTargets(page); await noHorizontalScroll(page);
      await hashTo(page, `/${made.id}/take`);
      await expect(page.getByTestId('take-form')).toBeVisible();
      expect(await axeSurveys(page), 'take').toEqual([]);
      await assertTouchTargets(page); await noHorizontalScroll(page);
      await hashTo(page, `/${made.id}/figures`);
      await expect(page.getByTestId('fig-not-published')).toBeVisible();
      expect(await axeSurveys(page), 'figures not published').toEqual([]);
      await mockFigures(page, made.id);
      await page.reload();
      await expect(page.getByTestId('fig-stratum').first()).toBeVisible();
      expect(await axeSurveys(page), 'figures').toEqual([]);
      await assertTouchTargets(page); await noHorizontalScroll(page);
      await gotoSurveys(page, '/new', { lang, token: creator.token });
      await expect(page.getByTestId('builder')).toBeVisible();
      expect(await axeSurveys(page), 'builder').toEqual([]);
      await assertTouchTargets(page); await noHorizontalScroll(page);
      await gotoSurveys(page, '/console', { lang, token: creator.token });
      await expect(page.getByTestId('quota-meter')).toBeVisible();
      expect(await axeSurveys(page), 'console').toEqual([]);
      if (lang === 'te') {
        await expect(page.getByTestId('translation-review-note')).toBeVisible();
        await hashTo(page, '');
        await expect(page.getByTestId('survey-disclaimer')).toContainText('అభిప్రాయ సర్వే');
        await expect(page.getByTestId('survey-heading')).toContainText('రిజిస్టర్');
      }
    });
  });
}

test('@E2E-38 the geography used by the specs resolves to a real AP village', async ({ request }) => {
  expect(await apVillage(request)).toBeTruthy();
});
