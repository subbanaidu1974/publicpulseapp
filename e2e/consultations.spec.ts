import { test, expect } from '@playwright/test';
import { C, apVillage, assertTouchTargets, axeCons, bearer, give, gotoCons, makeConsultation, noHorizontalScroll, officerOf, panelist, respondent, seed, uniq } from './consultations-helpers';
import { mockFeedback, mockOverdueReport } from './consultations-fixtures';

// Bill-consultation screens against the REAL server (serial: run with --workers=1; server env in consultations-helpers.ts).
// Stories: E2E-44 registry, clauses, audio, eligibility and feedback; E2E-45 figures, anti-astroturf flags and the closing report; E2E-57 axe.
test.describe.configure({ mode: 'serial' });

test.describe('registry and detail', () => {
  test('@E2E-44 registry lists every department the same way, with source link, groups and filters', async ({ page, request }) => {
    const a = await makeConsultation(request), b = await makeConsultation(request);
    await gotoCons(page);
    await expect(page.getByTestId('cons-disclaimer')).toContainText('signal, not a referendum');
    const card = page.locator(`[data-cons-id="${a.id}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('cons-card-dept')).toHaveText(a.dept);
    await expect(card.getByTestId('cons-card-source')).toHaveAttribute('href', /^https:\/\/prsindia\.gov\.in\//);
    await card.scrollIntoViewIfNeeded(); // groups are fetched only for cards that scroll into view
    await expect(card.getByTestId('cons-card-groups')).toContainText('farmers');
    await page.getByTestId('reg-search').fill(a.title);
    await expect(page.getByTestId('cons-card')).toHaveCount(1);
    await page.getByTestId('reg-search').fill('');
    await page.getByTestId('reg-dept').fill(b.dept);
    await expect(page.locator(`[data-cons-id="${b.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-cons-id="${a.id}"]`)).toHaveCount(0);
    await page.getByTestId('reg-dept').fill('');
    await page.getByTestId('reg-status').selectOption('closed');
    await expect(page.locator(`[data-cons-id="${a.id}"]`)).toHaveCount(0);
    await page.getByTestId('reg-status').selectOption('');
    await page.getByTestId('reg-state').selectOption('TG');
    await expect(page.getByTestId('reg-empty')).toBeVisible();
    await page.getByTestId('reg-state').selectOption('');
    await page.getByTestId('reg-overdue').check();
    await expect(page.getByTestId('reg-empty')).toBeVisible(); // nothing real is overdue
    await page.getByTestId('reg-overdue').uncheck();
    await expect(page.locator(`[data-cons-id="${a.id}"]`)).toBeVisible();
    const classes = await page.getByTestId('cons-card').evaluateAll((els) => [...new Set(els.map((e) => e.className))]);
    expect(classes.length).toBe(1);
    await noHorizontalScroll(page);
    await assertTouchTargets(page);
  });

  test('@E2E-44 the overdue closing report badge is shown on the card and the report page (fixture: nothing real is overdue yet)', async ({ page, request }) => {
    const m = await makeConsultation(request, { stage: 'closed' });
    await mockOverdueReport(page, m.id);
    await gotoCons(page);
    await expect(page.locator(`[data-cons-id="${m.id}"]`).getByTestId('cons-overdue')).toBeVisible();
    await gotoCons(page, `/${m.id}/report`);
    await expect(page.getByTestId('rep-pending')).toHaveAttribute('data-overdue', '1');
    await expect(page.getByTestId('rep-pending')).toContainText('Closing report overdue');
    await gotoCons(page, `/${m.id}/report`, { lang: 'te' });
    await expect(page.getByTestId('rep-pending')).toContainText('గడువు దాటింది');
  });

  test('@E2E-44 detail shows original reference beside EN and TE summaries, groups, hashes and the change log', async ({ page, request }) => {
    const m = await makeConsultation(request);
    await gotoCons(page, `/${m.id}`);
    const cl = page.getByTestId('cons-clause').first();
    await expect(cl.getByTestId('cons-clause-ref')).toContainText('Section 4(2)');
    await expect(cl.getByTestId('cons-summary-en')).toContainText('register their land');
    await expect(cl.getByTestId('cons-summary-te')).toContainText('రైతులు');
    await expect(page.getByTestId('cons-groups')).toContainText('tenants');
    await expect(page.getByTestId('cons-hash')).toHaveText(/^[0-9a-f]{64}$/);
    await expect(page.getByTestId('cons-version')).toHaveCount(1);
    await expect(page.getByTestId('cons-log-entry').first()).toBeVisible();
    const kinds = await page.getByTestId('cons-log-entry').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
    expect(kinds).toEqual(expect.arrayContaining(['registered', 'approved', 'published']));
    await expect(page.getByTestId('cons-source')).toHaveAttribute('target', '_blank');
    await expect(page.getByTestId('cons-panel')).toContainText('2 of 2');
    await gotoCons(page, `/${m.id}`, { lang: 'te' });
    await expect(page.getByTestId('cons-clause').first().getByTestId('cons-summary-te')).toBeVisible();
    await expect(page.getByTestId('translation-review-note')).toBeVisible();
  });

  test('@E2E-44 audio: no player until a person reviews a recording; placeholders say "not available yet"', async ({ page, request }) => {
    const m = await makeConsultation(request, { clauses: [
      { ref: 'Section 1', en: 'Farmers must register their land before selling crops.', te: 'రైతులు పంట అమ్మే ముందు తమ భూమిని నమోదు చేయాలి.', audio: [{ group: 'farmers', file_id: 'aud_' + uniq() }] },
    ] });
    await gotoCons(page, `/${m.id}`);
    await page.getByText('60-second audio summaries by group').first().click();
    await expect(page.locator('[data-group="farmers"]').first()).toHaveAttribute('data-audio-status', 'recorded');
    await expect(page.getByTestId('cons-audio-player')).toHaveCount(0);
    await expect(page.locator('[data-group="farmers"]').first().getByTestId('cons-audio-missing')).toContainText('not available yet');
    await expect(page.locator('[data-group="tenants"]').first().getByTestId('cons-audio-missing')).toBeVisible();
    // a panel member (a person) reviews the recording through the real route
    const p = await panelist(request);
    const r = await request.post(`${C}/${m.id}/audio/review`, { headers: bearer(p.token), data: { clause: 1, group: 'farmers' } });
    expect(r.status(), await r.text()).toBe(200);
    await gotoCons(page, `/${m.id}`);
    await page.getByText('60-second audio summaries by group').first().click();
    await expect(page.getByTestId('cons-audio-player')).toHaveCount(1);
    await expect(page.locator('[data-group="tenants"]').first().getByTestId('cons-audio-player')).toHaveCount(0);
  });

  test('@E2E-44 participate button states: signed out, not eligible with the exact reason, eligible, closed', async ({ page, request }) => {
    const m = await makeConsultation(request);
    await gotoCons(page, `/${m.id}`);
    await expect(page.getByTestId('cons-participate')).toHaveAttribute('data-state', 'signed_out');
    const nobody = await seed(request, { label: 'no village' });
    await gotoCons(page, `/${m.id}`, { token: nobody.token });
    await expect(page.getByTestId('cons-participate')).toHaveAttribute('data-state', 'not_eligible');
    await expect(page.getByTestId('cons-ineligible')).not.toHaveAttribute('data-code', '');
    await expect(page.getByTestId('cons-ineligible')).toContainText(/waiting period|village|PIN/);
    const ok = await respondent(request);
    await gotoCons(page, `/${m.id}`, { token: ok.token });
    await expect(page.getByTestId('cons-participate')).toHaveAttribute('data-state', 'eligible');
    await expect(page.getByTestId('cons-participate-link')).toHaveAttribute('href', `#/consultations/${m.id}/participate`);
    await gotoCons(page, `/${m.id}`, { token: ok.token, lang: 'te' });
    await expect(page.getByTestId('cons-participate-link')).toContainText('అభిప్రాయం ఇవ్వండి');
    const closed = await makeConsultation(request, { stage: 'closed' });
    await gotoCons(page, `/${closed.id}`, { token: ok.token });
    await expect(page.getByTestId('cons-participate')).toHaveAttribute('data-state', 'closed');
  });
});

test.describe('participate', () => {
  test('@E2E-44 stance, comment, public opt-in, edit until close (last edit wins) and my feedback list', async ({ page, request }) => {
    const m = await makeConsultation(request);
    const me = await respondent(request);
    await gotoCons(page, `/${m.id}/participate`, { token: me.token });
    await expect(page.getByTestId('part-honest')).toContainText('attributable to your platform account');
    await expect(page.getByTestId('part-honest')).toContainText('only in aggregate');
    const f1 = page.locator('[data-testid=fb-clause][data-clause="1"]');
    await expect(f1.getByTestId('fb-save')).toBeDisabled();
    await f1.getByTestId('fb-stance-support_changes').check();
    await f1.getByTestId('fb-comment').fill('Registration should be free for small farmers.');
    await expect(f1.getByTestId('fb-counter')).toContainText('/ 1500');
    await f1.getByTestId('fb-public').check();
    await f1.getByTestId('fb-save').click();
    await expect(f1.getByTestId('fb-result')).toContainText('saved');
    await expect(f1.getByTestId('fb-result')).toHaveAttribute('data-public', '1');
    await expect(page.getByTestId('part-mine-item')).toHaveCount(1);
    // edit: last edit wins; server reports edited
    await f1.getByTestId('fb-stance-oppose').check();
    await f1.getByTestId('fb-save').click();
    await expect(f1.getByTestId('fb-result')).toContainText('updated');
    const mine = await (await request.get(`${C}/${m.id}/mine`, { headers: bearer(me.token) })).json();
    expect(mine.feedback).toHaveLength(1);
    expect(mine.feedback[0].stance).toBe('oppose');
    // reload: the saved values come back from the server
    await gotoCons(page, `/${m.id}/participate`, { token: me.token });
    await expect(page.locator('[data-testid=fb-clause][data-clause="1"]').getByTestId('fb-stance-oppose')).toBeChecked();
    await expect(page.locator('[data-testid=fb-clause][data-clause="1"]').getByTestId('fb-comment')).toHaveValue(/free for small farmers/);
    // language hint: another script is refused client-side with an explanation
    const f2 = page.locator('[data-testid=fb-clause][data-clause="2"]');
    await f2.getByTestId('fb-stance-support').check();
    await f2.getByTestId('fb-comment').fill('Привет, это комментарий на другом языке');
    await expect(f2.getByTestId('fb-lang-hint')).toContainText('English or Telugu');
    await expect(f2.getByTestId('fb-save')).toBeDisabled();
    await noHorizontalScroll(page);
    await assertTouchTargets(page);
  });

  test('@E2E-44 closed, rate-limit, held-comment and language errors are worded in English and Telugu (fixtures for the faults)', async ({ page, request }) => {
    const m = await makeConsultation(request);
    const me = await respondent(request);
    await mockFeedback(page, m.id, 429, { error: 'too_many_requests', code: 'too_many_requests', scope: 'person' });
    await gotoCons(page, `/${m.id}/participate`, { token: me.token });
    const f1 = page.locator('[data-testid=fb-clause][data-clause="1"]');
    await f1.getByTestId('fb-stance-support').check();
    await f1.getByTestId('fb-save').click();
    await expect(f1.getByTestId('cons-error')).toContainText('Too many requests');
    await page.unroute(new RegExp(`${C}/${m.id}/feedback$`));
    await mockFeedback(page, m.id, 409, { error: 'consultation_closed', code: 'consultation_closed' });
    await f1.getByTestId('fb-save').click();
    await expect(f1.getByTestId('cons-error')).toContainText('has closed');
    await page.unroute(new RegExp(`${C}/${m.id}/feedback$`));
    await mockFeedback(page, m.id, 201, { clause: 1, stance: 'support', edited: false, comment_status: 'held', comment_public: false });
    await f1.getByTestId('fb-save').click();
    await expect(f1.getByTestId('fb-result')).toHaveAttribute('data-comment-status', 'held');
    await expect(f1.getByTestId('fb-result')).toContainText('held for a moderator');
    await page.unroute(new RegExp(`${C}/${m.id}/feedback$`));
    await mockFeedback(page, m.id, 429, { error: 'too_many_requests', code: 'too_many_requests' });
    await gotoCons(page, `/${m.id}/participate`, { token: me.token, lang: 'te' });
    await page.locator('[data-testid=fb-clause][data-clause="1"]').getByTestId('fb-stance-support').check();
    await page.locator('[data-testid=fb-clause][data-clause="1"]').getByTestId('fb-save').click();
    await expect(page.getByTestId('cons-error').first()).toContainText('అభ్యర్థనలు');
  });

  test('@E2E-44 a person who is not eligible sees the gate, and a closed consultation refuses feedback for real', async ({ page, request }) => {
    const m = await makeConsultation(request, { stage: 'closed' });
    const me = await respondent(request);
    const r = await request.post(`${C}/${m.id}/feedback`, { headers: bearer(me.token), data: { clause: 1, stance: 'support' } });
    expect(r.status()).toBe(409);
    await gotoCons(page, `/${m.id}/participate`, { token: me.token });
    await expect(page.getByTestId('part-gate')).toHaveAttribute('data-state', 'closed');
    const open = await makeConsultation(request);
    const nobody = await seed(request);
    await gotoCons(page, `/${open.id}/participate`, { token: nobody.token });
    await expect(page.getByTestId('part-gate')).toHaveAttribute('data-state', 'not_eligible');
  });
});

test.describe('figures and closing report', () => {
  test('@E2E-45 figures are refused while open, then show unweighted per-clause shares, k-suppression and public comments without names', async ({ page, request }) => {
    const m = await makeConsultation(request);
    const [a, b] = [await respondent(request), await respondent(request)];
    await give(request, a, m.id, 1, 'support', 'Good for farmers, please keep the registration simple.', true);
    await give(request, b, m.id, 1, 'oppose', 'Registration will burden small farmers a great deal.', true);
    await give(request, a, m.id, 2, 'support');
    await gotoCons(page, `/${m.id}/figures`);
    await expect(page.getByTestId('fig-not-published')).toBeVisible();
    await expect(page.getByTestId('fig-not-published')).toContainText('after the consultation closes');
    expect((await request.get(`${C}/${m.id}/figures`)).status()).toBe(403);
    expect((await request.get(`${C}/${m.id}/comments`)).status()).toBe(403);
    expect((await request.post(`${C}/${m.id}/close`, { headers: bearer(m.officer.token), data: {} })).status()).toBe(200);
    await gotoCons(page, `/${m.id}/figures`);
    await expect(page.getByTestId('fig-unweighted')).toContainText('Not weighted');
    await expect(page.getByTestId('fig-participants')).toHaveText('2');
    const c1 = page.getByTestId('fig-clause').first();
    await expect(c1.getByTestId('fig-row')).not.toHaveCount(0);
    // clause 2 has a single respondent: below k, the real server hides it
    await expect(page.getByTestId('fig-clause').nth(1).getByTestId('fig-suppressed')).toContainText('Too few responses to show');
    await expect(page.getByTestId('cm-item')).toHaveCount(2);
    await expect(page.getByTestId('fig-comments')).not.toContainText(a.personId);
    await page.getByTestId('cm-clause').selectOption('2');
    await expect(page.getByTestId('cm-empty')).toBeVisible();
    await gotoCons(page, `/${m.id}/figures`, { lang: 'te' });
    await expect(page.getByTestId('fig-unweighted')).toContainText('బరువు వేయలేదు');
    await noHorizontalScroll(page);
  });

  test('@E2E-45 closing report: pending state, then department responses, themes, flags, review coverage and no-change reasons', async ({ page, request }) => {
    const m = await makeConsultation(request);
    const [a, b] = [await respondent(request), await respondent(request)];
    await give(request, a, m.id, 1, 'support', 'Good for farmers, please keep the registration simple.', true);
    await give(request, b, m.id, 1, 'oppose', 'Registration will burden small farmers a great deal.');
    await give(request, a, m.id, 2, 'support_changes');
    await give(request, b, m.id, 2, 'support');
    const O = { headers: bearer(m.officer.token) };
    await request.post(`${C}/${m.id}/close`, { ...O, data: {} });
    await gotoCons(page, `/${m.id}/report`);
    await expect(page.getByTestId('rep-pending')).toHaveAttribute('data-overdue', '0');
    // the real publish refuses while responses are missing
    const pan = await panelist(request);
    const early = await request.post(`${C}/${m.id}/closing-report/publish`, { headers: bearer(pan.token), data: {} });
    expect(early.status()).toBe(409);
    expect((await early.json()).code).toBe('closing_report_incomplete');
    expect((await request.post(`${C}/${m.id}/complete`, O)).status()).toBe(409);
    expect((await request.post(`${C}/${m.id}/themes`, { ...O, data: { label_en: 'Registration burden for small farmers', clause: 1 } })).status()).toBe(201);
    expect((await request.post(`${C}/${m.id}/closing-report/responses`, { ...O, data: { clause: 1, kind: 'response', text_en: 'We will waive the registration fee for farmers with under two acres.' } })).status()).toBe(200);
    expect((await request.post(`${C}/${m.id}/closing-report/responses`, { ...O, data: { clause: 2, kind: 'no_change', text_en: 'The five year period matches the existing tenancy law, so it stays.', text_te: 'ఐదు సంవత్సరాల కాలం ప్రస్తుత కౌలు చట్టానికి సరిపోతుంది, కాబట్టి మార్పు లేదు.' } })).status()).toBe(200);
    const done = await request.post(`${C}/${m.id}/closing-report/publish`, { headers: bearer(pan.token), data: {} });
    expect(done.status(), await done.text()).toBe(200);
    await gotoCons(page, `/${m.id}/report`);
    await expect(page.getByTestId('rep-published')).toBeVisible();
    await expect(page.getByTestId('rep-response').first()).toContainText('waive the registration fee');
    await expect(page.getByTestId('rep-response').nth(1)).toHaveAttribute('data-kind', 'no_change');
    await expect(page.getByTestId('rep-response').nth(1)).toContainText('No change.');
    await expect(page.getByTestId('rep-coverage-line')).toContainText('2 comments, 0 read by people, 0 machine-summarised');
    await expect(page.getByTestId('rep-coverage-how')).toContainText('No machine summarisation was used');
    await expect(page.getByTestId('rep-flags')).toContainText('No large group of near-identical comments');
    await expect(page.getByTestId('rep-clause-themes')).toContainText('Registration burden');
    await gotoCons(page, `/${m.id}/report`, { lang: 'te' });
    await expect(page.getByTestId('rep-coverage-line')).toContainText('2 వ్యాఖ్యలు');
    await expect(page.getByTestId('rep-response').nth(1)).toContainText('ఐదు సంవత్సరాల');
    // completed only now
    expect((await request.post(`${C}/${m.id}/complete`, O)).status()).toBe(200);
  });
});

test.describe('department and panel console', () => {
  test('@E2E-44 console is gated by the server: signed out, and a person with no role', async ({ page, request }) => {
    await gotoCons(page, '/console');
    await expect(page.getByTestId('console-401')).toBeVisible();
    const p = await seed(request);
    await gotoCons(page, '/console', { token: p.token });
    await expect(page.getByTestId('console-403')).toBeVisible();
  });

  test('@E2E-44 officer drafts in the editor (EN/TE, audio placeholder), submits; panel approves with conflict message; officer publishes', async ({ page, request }) => {
    const dept = `Dept ${uniq()}`;
    const officer = await officerOf(request, dept);
    const title = `Water bill ${uniq()}`;
    await gotoCons(page, '/console', { token: officer.token });
    await page.getByTestId('dept-new').click();
    await page.getByTestId('ed-title-en').fill(title);
    await page.getByTestId('ed-title-te').fill('నీటి బిల్లు సంప్రదింపు');
    await page.getByTestId('ed-bill').fill('Draft Water Bill ' + uniq());
    await page.getByTestId('ed-source').fill('https://prsindia.gov.in/water-bill');
    await page.getByTestId('ed-groups').fill('farmers, fishers');
    await page.getByTestId('ed-ref').fill('Section 3');
    await page.getByTestId('ed-sum-en').fill('Every village gets a clean drinking water plan.');
    await page.getByTestId('ed-sum-te').fill('ప్రతి గ్రామానికి శుభ్రమైన తాగునీటి ప్రణాళిక ఉంటుంది.');
    await page.getByTestId('ed-add-audio').click();
    await expect(page.getByTestId('ed-audio-note')).toContainText('Placeholder');
    await page.getByTestId('ed-save').click();
    await expect(page.getByTestId('ed-note')).toContainText('Draft saved');
    await page.getByTestId('ed-submit').click();
    const item = page.locator('[data-testid=dept-item][data-status="in_review"]').filter({ hasText: title });
    await expect(item).toBeVisible();
    const id = (await item.getAttribute('data-cons-id'))!;
    // a panel member from the same department is refused (conflict of interest), shown with the reason
    const conflicted = await seed(request, { roles: [{ role: 'officer', department: dept }, { role: 'survey_panel', department: dept }] });
    await gotoCons(page, '/console', { token: conflicted.token });
    const pc = page.locator(`[data-testid=panel-item][data-cons-id="${id}"]`);
    await pc.getByTestId('panel-toggle').click();
    await pc.getByTestId('panel-approve').click();
    await expect(pc.getByTestId('cons-error')).toContainText('conflict of interest');
    // two real panel members approve through the console
    for (let i = 0; i < 2; i++) {
      const p = await panelist(request);
      await gotoCons(page, '/console', { token: p.token });
      const card = page.locator(`[data-testid=panel-item][data-cons-id="${id}"]`);
      await card.getByTestId('panel-toggle').click();
      await card.getByTestId('panel-approve').click();
      await expect(card.getByTestId('panel-note')).toContainText('Decision recorded');
    }
    await gotoCons(page, '/console', { token: officer.token });
    await page.locator(`[data-testid=dept-item][data-cons-id="${id}"]`).getByTestId('dept-publish').click();
    await expect(page.locator(`[data-testid=dept-item][data-cons-id="${id}"]`)).toHaveAttribute('data-status', 'open');
    await gotoCons(page, `/${id}`);
    await expect(page.getByTestId('cons-status')).toHaveAttribute('data-status', 'open');
  });

  test('@E2E-44 panel rejection needs notes and returns the draft; a correction is proposed and approved by id', async ({ page, request }) => {
    const m = await makeConsultation(request, { stage: 'in_review' });
    const p = await panelist(request);
    await gotoCons(page, '/console', { token: p.token });
    const card = page.locator(`[data-testid=panel-item][data-cons-id="${m.id}"]`);
    await card.getByTestId('panel-toggle').click();
    await card.getByTestId('panel-reject').click();
    await expect(card.getByTestId('cons-error')).toContainText('at least');
    await card.getByTestId('panel-notes').fill('The Telugu summary of clause 2 is unclear.');
    await card.getByTestId('panel-reject').click();
    await expect(card.getByTestId('panel-note')).toBeVisible();
    await gotoCons(page, '/console', { token: m.officer.token });
    await expect(page.locator(`[data-testid=dept-item][data-cons-id="${m.id}"]`).getByTestId('dept-returned')).toBeVisible();
    // correction on an open consultation
    const o = await makeConsultation(request);
    await gotoCons(page, '/console', { token: o.officer.token });
    const di = page.locator(`[data-testid=dept-item][data-cons-id="${o.id}"]`);
    await di.getByTestId('corr-box').locator('summary').click();
    await di.getByTestId('corr-sum-en').fill('Farmers must register their land free of charge before selling crops to a state buyer.');
    await di.getByTestId('corr-reason-en').fill('The fee was described wrongly in the first summary.');
    await di.getByTestId('corr-send').click();
    const corrId = (await di.getByTestId('corr-id').textContent())!.trim();
    for (let i = 0; i < 2; i++) {
      const pp = await panelist(request);
      const r = await request.post(`${C}/${o.id}/panel/review`, { headers: bearer(pp.token), data: { decision: 'approve', notes: '', correction_id: corrId } });
      expect(r.status(), await r.text()).toBe(200);
    }
    await gotoCons(page, `/${o.id}`);
    await expect(page.getByTestId('cons-version')).toHaveCount(2);
    await expect(page.getByTestId('cons-versions')).toContainText('The fee was described wrongly');
    await expect(page.getByTestId('cons-clause').first()).toContainText('free of charge');
  });

  test('@E2E-45 after closing: analyst cluster is one item with its size, themes, responses, preview, report publish and completion', async ({ page, request }) => {
    const m = await makeConsultation(request);
    const text = 'Please extend the registration deadline for all small farmers in our mandal this year.';
    const people = [await respondent(request), await respondent(request), await respondent(request)];
    for (const p of people) await give(request, p, m.id, 1, 'support_changes', text, true);
    await give(request, people[0], m.id, 2, 'support');
    await give(request, people[1], m.id, 2, 'support');
    const officer = m.officer;
    await gotoCons(page, '/console', { token: officer.token });
    await page.locator(`[data-testid=dept-item][data-cons-id="${m.id}"]`).getByTestId('dept-close').click();
    const di = page.locator(`[data-testid=dept-item][data-cons-id="${m.id}"]`);
    await expect(di).toHaveAttribute('data-status', 'closed');
    await expect(di.getByTestId('an-cluster')).toHaveCount(1);
    await expect(di.getByTestId('an-cluster')).toHaveAttribute('data-size', '3');
    await expect(di.getByTestId('an-cluster')).toContainText('3 near-identical comments');
    await di.getByTestId('an-read').click();
    await expect(di.getByTestId('cls-note')).toContainText('Recorded');
    await di.getByTestId('an-run').click();
    await expect(di.getByTestId('cls-note')).toContainText(/No machine reviewer|Reviewer ran/);
    await di.getByTestId('theme-en').fill('Extend the registration deadline');
    await di.getByTestId('theme-save').click();
    await expect(di.getByTestId('an-themes')).toContainText('Extend the registration deadline');
    await di.getByTestId('prev-load').click();
    await expect(di.getByTestId('prev-missing')).toContainText('clause(s): 1, 2');
    // responses through the forms
    const r1 = di.locator('[data-testid=resp-form][data-clause="1"]');
    await r1.getByTestId('resp-en').fill('Registration will stay open for two more months.');
    await r1.getByTestId('resp-save').click();
    await expect(r1.getByTestId('resp-note')).toBeVisible();
    const r2 = di.locator('[data-testid=resp-form][data-clause="2"]');
    await r2.getByTestId('resp-kind').selectOption('no_change');
    await r2.getByTestId('resp-en').fill('short');
    await r2.getByTestId('resp-save').click();
    await expect(r2.getByTestId('cons-error')).toContainText('at least');
    await r2.getByTestId('resp-en').fill('The tenancy period follows the existing tenancy law, so it stays.');
    await r2.getByTestId('resp-save').click();
    await expect(r2.getByTestId('resp-note')).toBeVisible();
    await di.getByTestId('prev-load').click();
    await expect(di.getByTestId('prev-ready')).toBeVisible();
    // a panel member publishes the report; the officer completes
    const pan = await seed(request, { roles: [{ role: 'survey_panel', department: 'INC' }] });
    await gotoCons(page, '/console', { token: pan.token });
    const pc = page.locator(`[data-testid=panel-item][data-cons-id="${m.id}"]`);
    await pc.getByTestId('panel-toggle').click();
    await pc.getByTestId('panel-publish-report').click();
    await expect(pc.getByTestId('panel-note')).toContainText('published');
    await gotoCons(page, '/console', { token: officer.token });
    await page.locator(`[data-testid=dept-item][data-cons-id="${m.id}"]`).getByTestId('dept-complete').click();
    await expect(page.locator(`[data-testid=dept-item][data-cons-id="${m.id}"]`)).toHaveAttribute('data-status', 'completed');
    await gotoCons(page, `/${m.id}/report`);
    await expect(page.getByTestId('rep-flags')).toContainText(/near-identical/);
    await expect(page.getByTestId('rep-coverage-line')).toContainText('3 comments, 1 read by people');
  });
});

test.describe('accessibility', () => {
  for (const lang of ['en', 'te'] as const) {
    test(`@E2E-57 axe and layout on every consultation screen (${lang})`, async ({ page, request }) => {
      const open = await makeConsultation(request);
      const closed = await makeConsultation(request, { stage: 'closed' });
      const me = await respondent(request);
      const officer = await officerOf(request, `Dept ${uniq()}`);
      const screens: [string, string | undefined][] = [['', undefined], [`/${open.id}`, undefined], [`/${open.id}/participate`, me.token], [`/${closed.id}/figures`, undefined], [`/${closed.id}/report`, undefined], ['/console', officer.token]];
      for (const [path, token] of screens) {
        await gotoCons(page, path, { lang, token });
        await expect(page.getByTestId('cons-heading')).toBeVisible();
        await page.waitForLoadState('networkidle');
        expect(await axeCons(page), `axe ${lang} ${path || 'registry'}`).toEqual([]);
        await noHorizontalScroll(page);
        await assertTouchTargets(page);
      }
      await apVillage(request);
    });
  }
});
