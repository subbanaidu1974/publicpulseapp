import type { Page } from '@playwright/test';
import { S } from './surveys-helpers';

/**
 * FIXTURES (the only place in the survey specs that fakes a response). Used for exactly two things a real server cannot give on demand:
 *  1. a published-figures snapshot: the real publisher needs >= 30 responses and a closed survey past its delay, so the success page is
 *     shown from a response shaped like GET /:id/results (docs/SURVEYS.md). The real 403 not_published path is tested against the server.
 *  2. an election-choice survey: that class is off by default and fails closed on the server (CIVIC_ELECTION_CHOICE_SURVEYS), so the
 *     detail payload of a real survey is rewritten to say election_choice while its figures still refuse for real.
 */
const cell = (id: string, level: string, label: string, n: number, u: [number, number, number], w: [number, number, number], hidden = 0) => ({
  id, level, parent: level === 'all' ? null : 'all', label_en: label, label_te: null, n, hidden_children: hidden,
  unweighted: { options: [{ id: 'o1', count: 1, share: u[0] }, { id: 'o2', count: 1, share: u[1] }, { id: 'o3', count: 1, share: u[2] }] },
  weighted: { options: [{ id: 'o1', share: w[0] }, { id: 'o2', share: w[1] }, { id: 'o3', share: w[2] }] },
});
const question = (cells: Record<string, unknown[]>) => ({
  id: 'q1', kind: 'single', text_en: 'How reliable is the water supply?', text_te: 'నీటి సరఫరా ఎంత నమ్మదగినది?',
  options: [{ id: 'o1', label_en: 'Reliable', label_te: 'నమ్మదగినది' }, { id: 'o2', label_en: 'Sometimes', label_te: 'కొన్నిసార్లు' }, { id: 'o3', label_en: 'Not reliable', label_te: 'నమ్మదగినది కాదు' }], breakdowns: cells,
});
export function figuresBody(id: string, by: string) {
  const geo = [cell('state:AP', 'state', 'AP', 240, [50, 30, 20], [45.5, 33.5, 21], 2)];
  const dims: Record<string, unknown[]> = {
    geo, age_band: [cell('a', 'age_band', '18-24', 60, [40, 40, 20], [41, 38, 21]), cell('b', 'age_band', '25-34', 180, [53.3, 26.7, 20], [49, 29, 22])],
    gender: [cell('g', 'gender', 'F', 120, [48, 32, 20], [47, 31, 22])], tier: [cell('t', 'tier', 'T1', 240, [50, 30, 20], [46, 33, 21])],
  };
  const qs = () => [question({ geo: dims.geo, [by]: dims[by] ?? dims.geo })];
  return {
    schema: 1, kind: 'pulse_survey_figures', survey: { id, title_en: 'Water supply fixture', title_te: null, topic_class: 'issue_service', state: 'AP', scope_level: 'state', closes_at: '2026-01-10T00:00:00Z' },
    published_at: '2026-01-11T00:00:00Z', disclaimer_en: 'Opinion survey, not an election and not a forecast.', disclaimer_te: 'అభిప్రాయ సర్వే మాత్రమే. ఇది ఎన్నిక కాదు, ముందస్తు అంచనా కాదు.',
    method_url: '/methodology#surveys', code_version: 'pulse-survey-method/1.0.0+fixture', partition: { levels: ['state', 'district'], minimum_cell_size: 30, counts_rounded_to: 5 },
    one_dimension: by, has_published_figures: true, snapshot_sha256: 'f'.repeat(64),
    strata: [
      { channel: 'app', published: true, platform_linkable: false, label_en: 'App responses', n: 240,
        sampling: { margin_of_error: null, effective_n: 190, design_effect: 1.26, coverage_warning_en: 'Responses come from verified people who chose to take part.', coverage_warning_te: 'ఈ సర్వేలో ధృవీకరించబడిన, స్వచ్ఛందంగా పాల్గొన్నవారి స్పందనలు మాత్రమే ఉన్నాయి.' },
        weighting: { applied: true, dimensions: ['gender'], cap: 5 },
        quality: { score: 71, partial: true, components: [{ key: 't2_share', weight: 0.35, value: 0.4, available: true }, { key: 'low_risk', weight: 0.2, value: 0.95, available: true }, { key: 'coverage', weight: 0.25, value: null, available: false }, { key: 'skew', weight: 0.2, value: 0.8, available: true }], skew_index: 0.2 },
        questions: qs() },
      { channel: 'assisted', published: true, platform_linkable: true, label_en: 'Assisted', n: 45,
        sampling: { margin_of_error: null, effective_n: 45, design_effect: 1, coverage_warning_en: 'Assisted.', coverage_warning_te: 'సహాయం.' }, weighting: { applied: false, dimensions: [], cap: 5 },
        quality: { score: 60, partial: true, components: [{ key: 't2_share', weight: 0.35, value: 0.2, available: true }], skew_index: null }, questions: qs() },
    ],
  };
}
const re = (tail: string) => new RegExp(S.replace(/\//g, '\\/') + tail);
export async function mockFigures(page: Page, id: string) {
  await page.route(re(`/${id}/results(\\?.*)?$`), (route) => {
    const by = new URL(route.request().url()).searchParams.get('by') ?? 'geo';
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(figuresBody(id, by)) });
  });
  await page.route(re(`/${id}/results/method$`), (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ policy: {}, marginals_file_loaded: false, code_version: 'pulse-survey-method/1.0.0+fixture', strata: [{ channel: 'app', quality: { score: 71, partial: true, components: [] }, weights: { applied: false, dimensions_used: [], dimensions_skipped: [{ dimension: 'age_band', reason: 'no verified reference figures' }], cap: 5 }, suppression: { k: 30 } }] }),
  }));
}
/** Make a real survey's detail say election_choice (the class is switched off on a real server). */
export async function mockElectionChoice(page: Page, id: string) {
  await page.route(re(`/${id}$`), async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    await route.fulfill({ response: res, json: { ...j, election_choice: true, topic_class: 'election_choice' } });
  });
}
