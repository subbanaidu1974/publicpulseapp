import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CivicApiError, tokenStore } from "../../api/civic";
import { notifyErrCode, type NotifyPolicy } from "../../api/notify";
import { notifyApi } from "../../api/notify";
import { useT } from "../../i18n";
import { TranslationNote } from "../TranslationNote";
import { useNotifyT, type NotifyT } from "./notifyText";

export { Btn, ErrorNote, Field, TextInput, inputCls } from "../civic/ui";

/** WCAG 2.2 AA target size for every control in these screens. */
export const TARGET_CSS = ".notify-root button,.notify-root select,.notify-root textarea,.notify-root input:not([type=checkbox]):not([type=radio]),.notify-root a.nt-btn{min-height:44px;min-width:44px}.notify-root input[type=checkbox],.notify-root input[type=radio]{width:24px;height:24px;flex-shrink:0}.notify-root a.nt-btn{display:inline-flex;align-items:center}";
export const card = "bg-white text-black border border-black/40 p-4 space-y-2";
export const linkCls = "underline font-bold cursor-pointer text-blue-900";
export const btnLink = "nt-btn px-4 py-2 text-sm font-bold border border-black bg-black text-white no-underline";
export const btnLinkSecondary = "nt-btn px-4 py-2 text-sm font-bold border border-black bg-white text-black no-underline";
export const go = (path: string) => { window.location.hash = path; };

export function useHash(): string {
  const [h, setH] = useState(() => window.location.hash);
  useEffect(() => { const on = () => setH(window.location.hash); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  return h;
}

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, [...deps, n]);
  useEffect(() => {
    let live = true;
    run().then((d) => { if (live) { setData(d); setError(null); setLoading(false); } }).catch((e) => { if (live) { setError(e); setLoading(false); } });
    return () => { live = false; };
  }, [run]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}

/** The project has no React type package, so `key` must be declared on the props of components used in lists. */
export interface Keyed { key?: string }
export const signedIn = (): boolean => !!tokenStore.get();
export function usePolicy(): NotifyPolicy | null { return useLoad(() => notifyApi.policy(), []).data; }

/** Standing anti-phishing banner, on every screen that shows or sends messages. */
export function AntiPhishBanner() {
  const t = useNotifyT();
  return <p role="note" data-testid="antiphish-banner" className="border-2 border-black bg-yellow-100 text-black p-3 font-bold text-sm">{t("banner.antiphish")}</p>;
}

export function Shell({ children, title, testid }: { children: ReactNode; title: string; testid: string }) {
  const t = useNotifyT();
  return (
    <div className="notify-root space-y-5" data-testid={testid}>
      <style>{TARGET_CSS}</style>
      <nav aria-label={t("nav.label")} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {([["#/notifications", "nav.home"], ["#/notifications/inbox", "nav.inbox"], ["#/notifications/settings", "nav.settings"], ["#/notifications/log", "nav.log"], ["#/notifications/keys", "nav.keys"], ["#/notifications/send", "nav.send"]] as const).map(([h, k]) => (
          <a key={h} href={h} className={`${linkCls} min-h-[44px] inline-flex items-center`}>{t(k)}</a>
        ))}
      </nav>
      <h2 className="text-2xl font-black" tabIndex={-1}>{title}</h2>
      <TranslationNote status="machine-draft" />
      {children}
    </div>
  );
}

export function NeedSignIn() {
  const t = useNotifyT();
  return (
    <div role="status" data-testid="nt-signin" className={card}>
      <p>{t("signin.need")}</p>
      <button type="button" className="min-h-[44px] px-4 py-2 text-sm font-bold border border-black bg-black text-white" onClick={() => { window.location.hash = ""; window.dispatchEvent(new CustomEvent("pp-nav", { detail: "civic" })); }}>{t("signin.go")}</button>
    </div>
  );
}

/** Plain-language text for a server reason or error code. Unknown codes show the generic message plus the code. */
export function reasonText(t: NotifyT, code: string): string {
  const key = `reason.${code}`;
  const r = t(key);
  if (r !== key) return r;
  if (code.startsWith("webauthn_")) return t("reason.webauthn_generic");
  if (code.startsWith("challenge_")) return t("reason.challenge_generic");
  return `${t("reason.unknown")} (${code || "error"})`;
}
export function errorText(t: NotifyT, e: unknown): string {
  if (e instanceof CivicApiError) {
    if (e.status === 0) return t("err.network");
    if (e.status === 401) return t("err.401");
    const code = notifyErrCode(e);
    if (code && code !== "error") return reasonText(t, code);
    if (e.status === 429) return t("err.rate");
    if (e.status === 403) return t("err.403");
  }
  return t("err.generic");
}

export const categoryLabel = (p: NotifyPolicy | null, c: string, lang: string): string => p?.category_labels[c]?.[lang === "te" ? "te" : "en"] ?? c;
export const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST"; } catch { return iso; }
};
export const useLang = () => useT().lang;
