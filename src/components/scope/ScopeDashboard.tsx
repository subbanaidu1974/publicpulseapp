import { useEffect, useState } from "react";
import { tokenStore } from "../../api/civic";
import { scopeApi, type ScopeCan, type ScopeMe } from "../../api/scope";
import { useT } from "../../i18n";
import { Btn } from "../civic/ui";
import { TranslationNote } from "../TranslationNote";
import { AuditPanel, ExportPanel, IssuesPanel, ScopeErrorView, SurveysPanel, useScoped } from "./ScopePanels";
import { useScopeT, type ScopeKey } from "./scopeText";

export const isDashboardHash = (h: string) => h === "#/dashboard" || h.startsWith("#/dashboard/");

type Dash = keyof ScopeCan;
const TAB_OF: Record<Dash, string> = { issues_summary: "issues", surveys_summary: "surveys", audit_summary: "audit", export: "export" };
const ORDER: Dash[] = ["issues_summary", "surveys_summary", "audit_summary", "export"];

/** 'What you can see', built only from the server's GET /scope/me. Nothing is inferred on the client. */
function CanPanel({ me }: { me: ScopeMe }) {
  const s = useScopeT();
  const { lang } = useT();
  return (
    <section data-testid="scope-can" aria-labelledby="sc-can-h" className="border border-black p-4 space-y-3 bg-white text-black">
      <h2 id="sc-can-h" className="text-xl font-bold">{s("sc.can.title")}</h2>
      <div><h3 className="font-bold text-sm">{s("sc.can.roles")}</h3>
        <ul className="space-y-1 text-sm" data-testid="scope-roles">{me.roles.map((r, i) => (
          <li key={`${r.role}-${i}`} data-role={r.role} data-scope={r.scope}>
            <strong>{s(`sc.role.${r.role}` as ScopeKey)}</strong>
            {" - "}{r.scope === "unit" && r.unit ? s("sc.can.scope.unit", { unit: `${lang === "te" && r.unit.name_te ? r.unit.name_te : r.unit.name_en} (${r.unit.level})` }) : r.scope === "none" ? s("sc.can.scope.none") : s("sc.can.scope.state")}
            {r.department ? ` | ${s("sc.can.dept", { dept: r.department })}` : ""}
          </li>))}</ul></div>
      <div><h3 className="font-bold text-sm">{s("sc.can.dashboards")}</h3>
        <ul className="text-sm" data-testid="scope-dashboards">{ORDER.map((d) => <li key={d} data-dash={d} data-can={me.can[d] ? "1" : "0"}>{s(`sc.dash.${d}` as ScopeKey)}: {me.can[d] ? s("sc.can.yes") : s("sc.can.no")}</li>)}</ul></div>
      <ul className="text-xs space-y-1 list-disc pl-5" data-testid="scope-guarantees">
        {me.read_only && <li data-testid="can-readonly">{s("sc.can.readOnly")}</li>}
        <li data-testid="can-early">{me.early_access ? s("sc.can.earlyOn") : s("sc.can.early")}</li>
        <li data-testid="can-individual">{me.individual_data ? s("sc.can.indivOn") : s("sc.can.indiv")}</li>
        <li data-testid="can-mincell">{s("sc.can.minCell", { n: me.min_cell })}</li>
      </ul>
      <p className="text-xs" data-testid="scope-notice">{lang === "te" ? me.notice_te : me.notice_en}</p>
    </section>
  );
}

/** Scoped dashboard hub (#/dashboard). Tabs follow the server's `can`; every panel still loads through a route the server authorises. */
export default function ScopeDashboard() {
  const s = useScopeT();
  const { lang } = useT();
  const signedIn = !!tokenStore.get();
  const { load, reload } = useScoped<ScopeMe>(() => scopeApi.me(), []);
  const [tab, setTab] = useState<string | null>(null);
  const me = load.state === "ok" ? load.data : null;
  const tabs = me ? ORDER.filter((d) => me.can[d]) : [];
  useEffect(() => { if (me && !tab && tabs.length) setTab(TAB_OF[tabs[0]]); }, [me, tab, tabs]);
  const goCivic = () => { window.history.replaceState(null, "", window.location.pathname + window.location.search); window.dispatchEvent(new HashChangeEvent("hashchange")); window.dispatchEvent(new CustomEvent("pp-nav", { detail: "civic" })); };

  return (
    <div className="civic-root space-y-5 max-w-full overflow-x-hidden" lang={lang} data-testid="scope-page">
      <style>{".civic-root button,.civic-root select,.civic-root input:not([type=checkbox]):not([type=radio]){min-height:44px;min-width:44px}"}</style>
      <header className="space-y-2">
        <h1 className="text-2xl font-bold break-words">{s("sc.title")}</h1>
        <p className="text-sm">{s("sc.intro")}</p>
        <TranslationNote status="machine-draft" />
        <Btn secondary data-testid="scope-back" onClick={goCivic}>{s("sc.back")}</Btn>
      </header>
      {load.state === "loading" && <p role="status" data-testid="scope-loading" className="text-sm">{s("sc.loading")}</p>}
      {load.state === "error" && (
        <div className="space-y-3">
          <ScopeErrorView error={load.error} onRetry={reload} />
          {(load.error.code === "unauthenticated" || !signedIn) && <div className="space-y-2"><p className="text-sm" data-testid="scope-signin">{s("sc.signin")}</p><Btn data-testid="scope-goto-civic" onClick={goCivic}>{s("sc.gotoCivic")}</Btn></div>}
        </div>
      )}
      {me && me.roles.length === 0 && <p role="status" data-testid="scope-norole" className="text-sm border border-black p-3">{s("sc.norole")}</p>}
      {me && me.roles.length > 0 && (<>
        <CanPanel me={me} />
        <div role="group" aria-label={s("sc.tabs")} className="flex flex-wrap gap-2">
          {tabs.map((d) => <Btn key={d} secondary={tab !== TAB_OF[d]} data-testid={`scope-tab-${TAB_OF[d]}`} aria-pressed={tab === TAB_OF[d]} onClick={() => setTab(TAB_OF[d])}>{s(`sc.dash.${d}` as ScopeKey)}</Btn>)}
        </div>
        {tab === "issues" && me.can.issues_summary && <IssuesPanel me={me} />}
        {tab === "surveys" && me.can.surveys_summary && <SurveysPanel />}
        {tab === "audit" && me.can.audit_summary && <AuditPanel />}
        {tab === "export" && me.can.export && <ExportPanel />}
      </>)}
    </div>
  );
}

/** Link on the signed-in Civic page; renders only when the server says the caller holds a dashboard role. */
export function ScopeLink() {
  const s = useScopeT();
  const [show, setShow] = useState(false);
  useEffect(() => {
    let live = true;
    if (tokenStore.get()) scopeApi.me().then((m) => { if (live) setShow(m.roles.length > 0); }).catch(() => { /* signed out or no role: show nothing */ });
    return () => { live = false; };
  }, []);
  if (!show) return null;
  return <a href="#/dashboard" data-testid="scope-link" className="underline font-bold text-blue-900 inline-flex items-center min-h-[44px]">{s("sc.link")}</a>;
}
