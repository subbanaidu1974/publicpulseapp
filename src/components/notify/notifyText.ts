import { useT } from "../../i18n";
import { EN } from "./notifyText.en";
import { TE } from "./notifyText.te";

/**
 * Copy for the government-notification screens, kept next to the components so the shared catalogue stays untouched.
 * English is the source. The Telugu is a machine draft that needs native-speaker review (every screen shows the translation-review note).
 * Dynamic keys (reason codes, lint rules, statuses) fall back to the key itself, so callers can detect "no copy" by comparing the result with the key.
 */
export type NotifyKey = keyof typeof EN;
export type NotifyT = (key: NotifyKey | (string & {}), vars?: Record<string, string | number>) => string;

export function useNotifyT(): NotifyT {
  const { lang } = useT();
  return (key, vars) => {
    const dict = (lang === "te" ? TE : EN) as Record<string, string>;
    let v = dict[key] ?? (EN as Record<string, string>)[key] ?? key;
    if (vars) for (const [k, x] of Object.entries(vars)) v = v.replace(`{${k}}`, String(x));
    return v;
  };
}
export const NOTIFY_TEXT = { en: EN as Record<NotifyKey, string>, te: TE };
