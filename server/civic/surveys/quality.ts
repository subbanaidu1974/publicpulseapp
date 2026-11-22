/**
 * Verified-quality score and sample-quality language for a survey (S-33). PURE.
 *
 * This is a self-selected, verified panel, NOT a probability sample: no classical margin of error is reported. Instead the payload
 * carries the effective sample size, the design effect and an explicit coverage warning.
 *
 * Score (0-100) = 100 * sum(weight_i * component_i) / sum(weight_i of the components that could be computed). Components, each 0..1:
 *   t2_share      share of responses from tier-T2 (highest trust) people                      weight 0.35
 *   low_risk      share of responses whose number-intelligence risk is not "high"           weight 0.20 (unavailable if no risk data)
 *   coverage      share of the marginal population mass sitting in categories that have
 *                 at least `minCategoryN` respondents                                       weight 0.25 (unavailable without marginals)
 *   skew          1 - skew index, skew index = largest total-variation distance between the
 *                 sample's and the marginal's category shares across weighted dimensions     weight 0.20 (unavailable without marginals)
 * A component that cannot be computed is shown with available:false and the others are re-scaled; `partial` is then true.
 */
import type { UsedDimension } from "./weights";

export const QUALITY_WEIGHTS = { t2_share: 0.35, low_risk: 0.2, coverage: 0.25, skew: 0.2 } as const;
export type QualityKey = keyof typeof QUALITY_WEIGHTS;

export interface QualityInput {
  n: number;
  tiers: (string | null | undefined)[];
  risks?: (string | null | undefined)[];
  /** One entry per respondent: category on each used dimension (null when unknown). */
  cats: Record<string, string | null>[];
  used: UsedDimension[];
  minCategoryN?: number;
}
export interface QualityComponent { key: QualityKey; weight: number; value: number | null; available: boolean; note: string }
export interface QualityResult {
  score: number | null;
  partial: boolean;
  components: QualityComponent[];
  skew_index: number | null;
  formula: string;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function qualityScore(inp: QualityInput): QualityResult {
  const n = inp.n;
  const minN = inp.minCategoryN ?? Math.max(1, Number(process.env.SURVEY_QUALITY_MIN_CATEGORY_N) || 10);
  const comps: QualityComponent[] = [];
  const add = (key: QualityKey, value: number | null, note: string) => comps.push({ key, weight: QUALITY_WEIGHTS[key], value: value === null ? null : r3(Math.max(0, Math.min(1, value))), available: value !== null, note });

  add("t2_share", n > 0 ? inp.tiers.filter((t) => t === "T2").length / n : null, "Share of responses from tier T2 (highest identity trust).");

  const risks = inp.risks ?? [];
  const known = risks.filter((r) => r !== null && r !== undefined && r !== "");
  add("low_risk", known.length > 0 && risks.length === n ? known.filter((r) => r !== "high").length / n : null, known.length ? "Share of responses without a high number-intelligence risk flag." : "No number-intelligence risk data is attached to responses; not scored.");

  let cov: number | null = null, skew: number | null = null;
  if (inp.used.length && n > 0) {
    const covs: number[] = [], tvds: number[] = [];
    for (const d of inp.used) {
      const cnt: Record<string, number> = {};
      let known = 0;
      for (const c of inp.cats) { const v = c[d.dimension]; if (typeof v === "string" && v in d.shares) { cnt[v] = (cnt[v] ?? 0) + 1; known++; } }
      let covered = 0;
      for (const [c, s] of Object.entries(d.shares)) if ((cnt[c] ?? 0) >= minN) covered += s;
      covs.push(covered);
      let tvd = 1;
      if (known > 0) { tvd = 0; for (const [c, s] of Object.entries(d.shares)) tvd += Math.abs((cnt[c] ?? 0) / known - s); tvd /= 2; }
      tvds.push(tvd);
    }
    cov = covs.reduce((a, b) => a + b, 0) / covs.length;
    skew = Math.max(...tvds);
  }
  add("coverage", cov, cov === null ? "No verified marginals for this area; coverage is not scored." : `Share of the reference population in categories with at least ${minN} responses.`);
  add("skew", skew === null ? null : 1 - skew, skew === null ? "No verified marginals for this area; skew is not scored." : "One minus the largest total-variation distance between the sample and the reference shares.");

  const avail = comps.filter((c) => c.available);
  const wsum = avail.reduce((s, c) => s + c.weight, 0);
  const score = avail.length && wsum > 0 ? Math.round((100 * avail.reduce((s, c) => s + c.weight * (c.value as number), 0)) / wsum) : null;
  return {
    score, partial: avail.length < comps.length, components: comps, skew_index: skew === null ? null : r3(skew),
    formula: "score = 100 * sum(weight * value) / sum(weight of available components); weights t2_share 0.35, low_risk 0.20, coverage 0.25, skew 0.20",
  };
}

export interface SampleQualityText { en: string; te: string }
/** The sampling language every payload carries: a self-selected panel, effective n instead of a margin of error. */
export function samplingNote(nUnweighted: number, nEff: number, deff: number, weighted: boolean): { type: "self_selected_verified_panel"; margin_of_error: null; effective_n: number; design_effect: number; coverage_warning_en: string; coverage_warning_te: string; note_en: string; note_te: string } {
  const eff = Math.round(nEff * 10) / 10, d = Math.round(deff * 100) / 100;
  return {
    type: "self_selected_verified_panel",
    margin_of_error: null,
    effective_n: eff,
    design_effect: d,
    coverage_warning_en: "Responses come from verified people who chose to take part. People without phones, with little internet access or less interest are under-represented, and weighting can only partly correct this.",
    coverage_warning_te: "ఈ సర్వేలో ధృవీకరించబడిన, స్వచ్ఛందంగా పాల్గొన్నవారి స్పందనలు మాత్రమే ఉన్నాయి. ఫోన్ లేనివారు, ఇంటర్నెట్ తక్కువగా వాడేవారు తక్కువగా ప్రతిబింబిస్తారు; వెయిటింగ్ దీనిని పూర్తిగా సరిచేయలేదు.",
    note_en: `Not a random sample, so a classical margin of error does not apply. ${nUnweighted} responses, effective sample size about ${eff} (design effect ${d})${weighted ? "" : "; no weighting was possible, so the weighted and unweighted figures are the same"}.`,
    note_te: `ఇది యాదృచ్ఛిక నమూనా కాదు, కాబట్టి సాధారణ దోష పరిమితి వర్తించదు. ${nUnweighted} స్పందనలు, ప్రభావిత నమూనా పరిమాణం సుమారు ${eff} (డిజైన్ ఎఫెక్ట్ ${d}).`,
  };
}
