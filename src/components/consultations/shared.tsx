import type { ReactNode } from "react";
import { errBody, errorCode, errStatus, type ClosingState, type ConsSummary } from "../../api/consultations";
import { useT } from "../../i18n";
import { reviewStatus } from "../../i18n/content";
import { TranslationNote } from "../TranslationNote";
import { useConsT, type ConsKey, type ConsT } from "./consultationsText";

export { Btn, ErrorNote, Field, inputCls } from "../civic/ui";
export { card, fmtDate, go, linkCls, pickLang, shortHash, useHash, useLoad, useMe } from "../surveys/shared";
export type { Keyed } from "../surveys/shared";

/** WCAG 2.2 AA target size for every control in the consultation screens. */
export const TARGET_CSS = ".cons-root button,.cons-root select,.cons-root input:not([type=checkbox]):not([type=radio]),.cons-root textarea,.cons-root a.cn-btn{min-height:44px;min-width:44px}.cons-root input[type=checkbox],.cons-root input[type=radio]{width:24px;height:24px;flex-shrink:0}.cons-root a.cn-btn{display:inline-flex;align-items:center}";
export const btnLink = "cn-btn px-4 py-2 text-sm font-bold border border-black bg-black text-white no-underline";
export const btnLinkSecondary = "cn-btn px-4 py-2 text-sm font-bold border border-black bg-white text-black no-underline";
export const chip = "inline-block border border-black bg-white text-black text-xs font-bold px-2 py-1";
export const selCls = "border border-black bg-white text-black px-2 text-base min-h-[44px] w-full";

export const titleOf = (s: { title_en: string; title_te: string | null }, lang: "en" | "te") => (lang === "te" && s.title_te ? s.title_te : s.title_en);

export function StatusBadge({ status }: { status: string }) {
  const c = useConsT();
  return <span data-testid="cons-status" data-status={status} className="inline-block border border-black bg-white text-black text-xs font-bold px-2 py-0.5 uppercase tracking-wide">{c(`st.${status}` as ConsKey)}</span>;
}

/** The "closing report overdue" badge (or its state) for a closed consultation. */
export function ClosingBadge({ cr }: { cr: ClosingState }) {
  const c = useConsT();
  if (cr.overdue) return <span data-testid="cons-overdue" className="inline-block border-2 border-red-800 bg-red-50 text-red-900 text-xs font-bold px-2 py-0.5">{c("cr.overdue")}</span>;
  if (cr.status === "published") return <span data-testid="cons-report-state" data-state="published" className="inline-block border border-black bg-white text-black text-xs font-bold px-2 py-0.5">{c("cr.published")}</span>;
  if (cr.status === "pending") return <span data-testid="cons-report-state" data-state="pending" className="inline-block border border-black bg-white text-black text-xs font-bold px-2 py-0.5">{c("cr.pending")}</span>;
  return null;
}

export function Disclaimer({ en, te }: { en?: string; te?: string }) {
  const c = useConsT();
  const { lang } = useT();
  const text = lang === "te" ? te || c("disclaimer") : en || c("disclaimer");
  return <p data-testid="cons-disclaimer" role="note" className="border-2 border-black bg-amber-100 text-black font-bold text-sm px-3 py-2">{text}</p>;
}

export const ConsTeNote = () => <TranslationNote status={reviewStatus.methodology} />;

export function ErrorLine({ msg }: { msg: string | null }) {
  return msg ? <p role="alert" data-testid="cons-error" className="text-red-900 bg-red-50 border border-red-800 px-3 py-2 text-sm font-bold">{msg}</p> : null;
}

export function Page({ title, children, back }: { title: string; children: ReactNode; back?: { label: string; to: string } }) {
  const c = useConsT();
  const { lang } = useT();
  return (
    <div data-testid="consultations-root" className="cons-root space-y-5 max-w-full overflow-x-hidden" lang={lang}>
      <style>{TARGET_CSS}</style>
      <nav aria-label={c("nav.label")} className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <a className="underline font-bold text-blue-900 min-h-[44px] inline-flex items-center" href="#/consultations" data-testid="cnnav-registry">{c("nav.registry")}</a>
        <a className="underline font-bold text-blue-900 min-h-[44px] inline-flex items-center" href="#/consultations/console" data-testid="cnnav-console">{c("nav.console")}</a>
      </nav>
      {back && <a className="underline font-bold text-blue-900 min-h-[44px] inline-flex items-center" href={back.to} data-testid="cons-back">{back.label}</a>}
      <h1 className="text-2xl font-bold break-words" data-testid="cons-heading">{title}</h1>
      <ConsTeNote />
      {children}
    </div>
  );
}

/** Message for a failed call: a specific line for every known server code (both languages), the status as the fallback. */
export function useErrMsg() {
  const c = useConsT();
  return (e: unknown): string => {
    const code = errorCode(e), status = errStatus(e);
    if (status === 0) return c("err.network");
    const k = `err.${code}` as ConsKey;
    if (c(k) !== k) {
      const b = errBody(e);
      const extra = typeof b.reason === "string" ? ` (${b.reason})` : "";
      return c(k, { min: String(b.min_chars ?? ""), max: String(b.max_chars ?? ""), n: String(b.clause ?? "") }) + extra;
    }
    if (status === 429) return c("err.too_many_requests");
    if (status === 401) return c("err.401");
    if (status === 403) return c("err.403");
    if (status === 400 && code) return `${c("err.invalid")} (${code})`;
    return c("err.generic");
  };
}

/** The reason a person cannot take part, from the server code (exact), with the server's own message as detail. */
export function eligibilityText(c: ConsT, code: string, message: string): string {
  const k = `elig.${code}` as ConsKey;
  return c(k) !== k ? c(k) : message;
}

export const isOpenNow = (s: Pick<ConsSummary, "status" | "opens_at" | "closes_at">, now = Date.now()) => s.status === "open" && now >= Date.parse(s.opens_at) && now < Date.parse(s.closes_at);

export function scopeLabel(c: ConsT, sc: ConsSummary["scope"]): string {
  const parts = Object.entries(sc.units ?? {}).filter(([, v]) => v && v.length).map(([k, v]) => `${c(`unit.${k}` as ConsKey)}: ${v!.join(", ")}`);
  return `${sc.state}${parts.length ? " (" + parts.join("; ") + ")" : ` (${c("scope.whole")})`}`;
}

export const pct = (v: number | undefined | null) => (v === undefined || v === null ? "-" : `${Math.round(v * 10) / 10}%`);
