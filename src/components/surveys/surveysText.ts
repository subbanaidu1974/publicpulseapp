import { useT } from "../../i18n";
import { EN } from "./surveysText.en";
import { TE } from "./surveysText.te";

/**
 * Copy for the Pulse Survey screens, kept next to the components so the shared i18n catalogue stays untouched.
 * English is the source; the Telugu is a machine draft that needs native-speaker review (the screens show the translation-review note).
 * Dynamic keys (status, reason, error codes) fall back to the key itself, so callers can detect "no copy" by comparing the result with the key.
 */
export type SurveyKey = keyof typeof EN;

export function useSurveyT(): (key: SurveyKey, vars?: Record<string, string | number>) => string {
  const { lang } = useT();
  return (key, vars) => {
    const dict = (lang === "te" ? TE : EN) as Record<string, string>;
    let v = dict[key] ?? (EN as Record<string, string>)[key] ?? key;
    if (vars) for (const [k, x] of Object.entries(vars)) v = v.replace(`{${k}}`, String(x));
    return v;
  };
}
export const SURVEY_TEXT = { en: EN as Record<SurveyKey, string>, te: TE };
