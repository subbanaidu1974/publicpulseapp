import { useT } from "../../i18n";
import { EN } from "./consultationsText.en";
import { TE } from "./consultationsText.te";

/**
 * Copy for the bill-consultation screens, kept next to the components so the shared i18n catalogue stays untouched.
 * English is the source; the Telugu is a machine draft that needs native-speaker review (the screens show the translation-review note).
 * Dynamic keys (status, error codes) fall back to the key itself, so callers can detect "no copy" by comparing the result with the key.
 * Wording rule: "consultation", "feedback", "responses", "figures" (scripts/lint-copy.ts).
 */
export type ConsKey = keyof typeof EN;
export type ConsT = (key: ConsKey, vars?: Record<string, string | number>) => string;

export function useConsT(): ConsT {
  const { lang } = useT();
  return (key, vars) => {
    const dict = (lang === "te" ? TE : EN) as Record<string, string>;
    let v = dict[key] ?? (EN as Record<string, string>)[key] ?? key;
    if (vars) for (const [k, x] of Object.entries(vars)) v = v.replace(`{${k}}`, String(x));
    return v;
  };
}
export const CONS_TEXT = { en: EN as Record<ConsKey, string>, te: TE };
