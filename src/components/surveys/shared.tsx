import { useCallback, useEffect, useState, type ReactNode } from "react";
import { civicIdentityApi, tokenStore, type MePerson } from "../../api/civic";
import { useT } from "../../i18n";
import { reviewStatus } from "../../i18n/content";
import { TranslationNote } from "../TranslationNote";
import { useSurveyT, type SurveyKey } from "./surveysText";

export { Btn, ErrorNote, Field, inputCls } from "../civic/ui";

/** WCAG 2.2 AA target size for every control in the survey screens. */
export const TARGET_CSS = ".survey-root button,.survey-root select,.survey-root input:not([type=checkbox]):not([type=radio]),.survey-root textarea,.survey-root a.sv-btn{min-height:44px;min-width:44px}.survey-root input[type=checkbox],.survey-root input[type=radio]{width:24px;height:24px;flex-shrink:0}.survey-root a.sv-btn{display:inline-flex;align-items:center}";

export const card = "bg-white text-black border border-black/40 p-4 space-y-2";
export const linkCls = "underline font-bold cursor-pointer text-blue-900";
export const btnLink = "sv-btn px-4 py-2 text-sm font-bold border border-black bg-black text-white no-underline";
export const btnLinkSecondary = "sv-btn px-4 py-2 text-sm font-bold border border-black bg-white text-black no-underline";

export const go = (path: string) => { window.location.hash = path; };

/** Current location.hash, kept in state (the survey area is hash-routed: #/surveys, #/surveys/<id>, ...). */
export function useHash(): string {
  const [h, setH] = useState(() => window.location.hash);
  useEffect(() => { const on = () => setH(window.location.hash); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  return h;
}

export interface MeState { loading: boolean; signedIn: boolean; roles: string[]; me: MePerson | null }
/** Who is signed in. Role gating in the UI is a convenience only: every route is enforced by the server. */
export function useMe(): MeState {
  const [st, setSt] = useState<MeState>(() => ({ loading: !!tokenStore.get(), signedIn: !!tokenStore.get(), roles: [], me: null }));
  useEffect(() => {
    let live = true;
    if (!tokenStore.get()) { setSt({ loading: false, signedIn: false, roles: [], me: null }); return; }
    civicIdentityApi.me().then((me) => { if (live) setSt({ loading: false, signedIn: true, roles: [...(me.roles ?? []), ...(me.role ? [me.role] : [])], me }); })
      .catch(() => { if (live) setSt({ loading: false, signedIn: false, roles: [], me: null }); });
    return () => { live = false; };
  }, []);
  return st;
}

/** Load something once and on demand. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, [...deps, n]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    run().then((d) => { if (live) { setData(d); setError(null); setLoading(false); } }).catch((e) => { if (live) { setError(e); setLoading(false); } });
    return () => { live = false; };
  }, [run]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}

/** The project has no React type package, so `key` must be declared on the props of components used in lists. */
export interface Keyed { key?: string }

export const shortHash = (h: string) => h.slice(0, 10);

export function fmtDate(iso: string | null | undefined, lang: "en" | "te", withTime = false): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === "te" ? "te-IN" : "en-IN", withTime ? { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" } : { dateStyle: "medium", timeZone: "Asia/Kolkata" });
}

/** Survey title in the reader's language, falling back to English. */
export const titleOf = (s: { title_en: string; title_te: string | null }, lang: "en" | "te") => (lang === "te" && s.title_te ? s.title_te : s.title_en);
export const pickLang = (en: string | null | undefined, te: string | null | undefined, lang: "en" | "te") => (lang === "te" && te ? te : en ?? "");

export function StatusBadge({ status }: { status: string }) {
  const s = useSurveyT();
  return <span data-testid="survey-status" data-status={status} className="inline-block border border-black bg-white text-black text-xs font-bold px-2 py-0.5 uppercase tracking-wide">{s(`st.${status}` as SurveyKey)}</span>;
}

/** The page-level disclaimer every survey screen carries (server wording when the payload has it). */
export function Disclaimer({ en, te }: { en?: string; te?: string }) {
  const s = useSurveyT();
  const { lang } = useT();
  const text = lang === "te" ? te || s("disclaimer") : en || s("disclaimer");
  return <p data-testid="survey-disclaimer" role="note" className="border-2 border-black bg-amber-100 text-black font-bold text-sm px-3 py-2">{text}</p>;
}

/** Plain-language, per-channel secrecy statement. Shown on every survey page. */
export function ProtectionBox({ compact = false }: { compact?: boolean }) {
  const s = useSurveyT();
  return (
    <details open={!compact} data-testid="survey-protection" className="bg-white text-black border border-black/40 p-4">
      <summary className="font-bold cursor-pointer min-h-[44px] flex items-center">{s("prot.title")}</summary>
      <ul className="list-disc pl-5 space-y-1.5 text-sm mt-2">
        <li data-testid="prot-app">{s("prot.app")}</li>
        <li data-testid="prot-assisted">{s("prot.assisted")}</li>
        <li data-testid="prot-once">{s("prot.once")}</li>
        <li data-testid="prot-lost">{s("prot.lost")}</li>
        <li data-testid="prot-nofollow">{s("prot.noReceipt")}</li>
      </ul>
    </details>
  );
}

/** Review-status note for the Telugu draft text. */
export const SurveyTeNote = () => <TranslationNote status={reviewStatus.methodology} />;

export function Page({ title, children, back }: { title: string; children: ReactNode; back?: { label: string; to: string } }) {
  const s = useSurveyT();
  const { lang } = useT();
  return (
    <div data-testid="surveys-root" className="survey-root space-y-5 max-w-full overflow-x-hidden" lang={lang}>
      <style>{TARGET_CSS}</style>
      <nav aria-label={s("nav.label")} className="flex flex-wrap gap-2 text-sm">
        <a className={linkCls} href="#/surveys" data-testid="svnav-registry">{s("nav.registry")}</a>
        <a className={linkCls} href="#/surveys/log" data-testid="svnav-log">{s("nav.log")}</a>
        <a className={linkCls} href="#/surveys/console" data-testid="svnav-console">{s("nav.console")}</a>
      </nav>
      {back && <a className={linkCls} href={back.to} data-testid="survey-back">{back.label}</a>}
      <h1 className="text-2xl font-bold break-words" data-testid="survey-heading">{title}</h1>
      <SurveyTeNote />
      {children}
    </div>
  );
}

export function ErrorLine({ msg }: { msg: string | null }) {
  return msg ? <p role="alert" data-testid="survey-error" className="text-red-900 bg-red-50 border border-red-800 px-3 py-2 text-sm font-bold">{msg}</p> : null;
}
