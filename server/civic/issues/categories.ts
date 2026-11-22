/**
 * Canonical issue categories (S-148): the single source for the web app, the IVR menu and the issue workflow.
 * Pure data, no imports with side effects, so channels and the UI-facing endpoint can both use it.
 * `ivrDigit` is the key a caller presses; `icon` is a lucide icon name for the UI.
 */
export interface CategoryDef {
  id: string;
  label_en: string;
  label_te: string;
  icon: string;
  ivrDigit: string;
  department: string;
  slaHours: number;
}

export const CATEGORY_LIST: readonly CategoryDef[] = [
  { id: "water", label_en: "Drinking water", label_te: "తాగునీరు", icon: "droplets", ivrDigit: "1", department: "Rural Water Supply", slaHours: 72 },
  { id: "roads", label_en: "Roads", label_te: "రోడ్లు", icon: "route", ivrDigit: "2", department: "Roads and Buildings", slaHours: 168 },
  { id: "electricity", label_en: "Electricity", label_te: "విద్యుత్", icon: "zap", ivrDigit: "3", department: "Energy", slaHours: 48 },
  { id: "health", label_en: "Health", label_te: "ఆరోగ్యం", icon: "heart-pulse", ivrDigit: "4", department: "Health", slaHours: 48 },
  { id: "education", label_en: "Schools and education", label_te: "పాఠశాల, విద్య", icon: "graduation-cap", ivrDigit: "5", department: "School Education", slaHours: 168 },
  { id: "agriculture", label_en: "Agriculture and irrigation", label_te: "వ్యవసాయం, సాగునీరు", icon: "sprout", ivrDigit: "6", department: "Agriculture and Irrigation", slaHours: 120 },
  { id: "welfare", label_en: "Welfare schemes", label_te: "సంక్షేమ పథకాలు", icon: "hand-heart", ivrDigit: "7", department: "Social Welfare", slaHours: 168 },
  { id: "law_order", label_en: "Law and order", label_te: "శాంతిభద్రతలు", icon: "shield-alert", ivrDigit: "8", department: "Police", slaHours: 24 },
  { id: "other", label_en: "Other", label_te: "ఇతరం", icon: "ellipsis", ivrDigit: "9", department: "General Administration", slaHours: 168 },
];

/** id -> { department, slaHours } (kept for the workflow code). */
export const CATEGORY_MAP: Record<string, { department: string; slaHours: number }> =
  Object.fromEntries(CATEGORY_LIST.map(c => [c.id, { department: c.department, slaHours: c.slaHours }]));

/** IVR key -> category id ("1".."9"). */
export const IVR_CATEGORY_DIGITS: Record<string, string> = Object.fromEntries(CATEGORY_LIST.map(c => [c.ivrDigit, c.id]));

/** Spoken IVR menu built from the list, so it can never drift from the web categories. */
export const ivrCategoryPrompt = () => ({
  textTe: "సమస్య రకం: " + CATEGORY_LIST.map(c => `${c.label_te} ${c.ivrDigit}`).join(", ") + ".",
  textEn: "Issue type: " + CATEGORY_LIST.map(c => `${c.label_en.toLowerCase()} ${c.ivrDigit}`).join(", ") + ".",
});

export interface TrustTierDef { tier: "T0" | "T1" | "T2"; label_en: string; label_te: string; description_en: string; description_te: string; icon: string }
/** Trust-tier badge labels (DESIGN_2028 3.1): simple badges, never jargon. T2 never changes weights. */
export const TRUST_TIERS: readonly TrustTierDef[] = [
  { tier: "T0", label_en: "Phone verified", label_te: "ఫోన్ ధృవీకరణ", description_en: "The phone number was verified by a one-time code.", description_te: "ఫోన్ నంబర్ వన్-టైమ్ కోడ్ ద్వారా ధృవీకరించబడింది.", icon: "phone" },
  { tier: "T1", label_en: "Village declared", label_te: "ఊరు ప్రకటించారు", description_en: "The person declared the village they live in.", description_te: "వారు నివసించే ఊరును ప్రకటించారు.", icon: "map-pin" },
  { tier: "T2", label_en: "Village confirmed", label_te: "ఊరు నిర్ధారణ", description_en: "Two independent local attestors confirmed the residence.", description_te: "ఇద్దరు స్థానిక సాక్షులు నివాసాన్ని నిర్ధారించారు.", icon: "badge-check" },
];
