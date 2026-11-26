import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { civicIdentityApi, tokenStore, type MePerson, type Session } from "../../api/civic";
import Attestation, { VolunteerActivate } from "./Attestation";
import InviteAccept from "./InviteAccept";
import PinRecovery from "./PinRecovery";
import ResidenceFlow from "./ResidenceFlow";
import SessionsPage from "./SessionsPage";
import TierBadge from "./TierBadge";
import { useCivicT, type CivicKey } from "./civicText";
import HouseholdPage from "./HouseholdPage";
import ConsolesHub from "./consoles/ConsolesHub";
import OfficerApply from "./OfficerApply";
import IssueFeed from "./IssueFeed";
import AssistedEntry from "./AssistedEntry";
import AssistedSegment from "./AssistedSegment";
import IssueReport from "./IssueReport";
import MyReports from "./MyReports";
import LoginFlow from "./LoginFlow";
import DemoPersonas from "./DemoPersonas";
import AddPhone from "./AddPhone";
import SignUpFlow from "./SignUpFlow";
import { Btn } from "./ui";
import { SurveysLink, NotifyLink, ConsultationsLink, ScopeLink } from "./CrossLinks";

/** WCAG 2.2 AA target size: every control inside the civic tab (including Agent B components) gets at least 44px. */
const TARGET_CSS = ".civic-root button,.civic-root select,.civic-root input:not([type=checkbox]):not([type=radio]),.civic-root textarea{min-height:44px;min-width:44px}.civic-root input[type=checkbox],.civic-root input[type=radio]{width:24px;height:24px}.civic-root label{min-height:24px}";

const TABS = ["report", "mine", "household", "account", "explore", "roles"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY = "pp-civic-tab";
const readTab = (): Tab => { try { const v = sessionStorage.getItem(TAB_KEY); return TABS.find((x) => x === v) ?? "report"; } catch { return "report"; } };

/** A tab panel. Inactive panels stay mounted (so their data and drafts survive a tab switch) but are hidden. */
function Panel({ id, tab, children }: { id: Tab; tab: Tab; children: ReactNode }) {
  return <section role="tabpanel" id={`civic-panel-${id}`} aria-labelledby={`civic-tab-${id}`} data-testid={`civic-panel-${id}`} hidden={tab !== id} className="space-y-6">{children}</section>;
}

type View = "choose" | "signup" | "login" | "recover";

/** Deep links: ?invite=<code> (household invitation) and ?activate=<code> (volunteer-enrolled adult). */
function deepLink(): { invite?: string; activate?: string } {
  try { const p = new URLSearchParams(window.location.search); return { invite: p.get("invite") ?? undefined, activate: p.get("activate") ?? undefined }; } catch { return {}; }
}

/** Civic tab root. Lite by design: no map, no images; registers the PWA-lite service worker and manifest. */
export default function CivicHome() {
  const c = useCivicT();
  const [session, setSession] = useState<Session | null>(() => { const t = tokenStore.get(); return t ? { token: t } : null; });
  const [view, setView] = useState<View>("choose");
  const [tick, setTick] = useState(0);
  const [tab, setTab] = useState<Tab>(readTab);
  const pickTab = (t: Tab) => { setTab(t); try { sessionStorage.setItem(TAB_KEY, t); } catch { /* ignore */ } };
  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const next = e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length] : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : null;
    if (!next) return;
    e.preventDefault(); pickTab(next);
    requestAnimationFrame(() => document.getElementById(`civic-tab-${next}`)?.focus());
  };
  const [link, setLink] = useState(deepLink);
  const [me, setMe] = useState<MePerson | null>(null);
  const refreshMe = () => { civicIdentityApi.me().then(setMe).catch(() => setMe(null)); };
  useEffect(() => { if (session) refreshMe(); else setMe(null); }, [session]);
  // The Log out button lives in the top bar; when the token is cleared there, return to the sign-in choices.
  useEffect(() => {
    // Only when someone was signed in here: a PIN reset also clears the token while its own screen must stay up.
    const on = () => { if (!tokenStore.get()) setSession((prev) => { if (prev) setView("choose"); return null; }); };
    window.addEventListener("pp-session", on);
    return () => window.removeEventListener("pp-session", on);
  }, []);
  const closeLink = () => { try { window.history.replaceState(null, "", window.location.pathname + window.location.hash); } catch { /* ignore */ } setLink({}); };

  useEffect(() => {
    try {
      if (!document.querySelector('link[rel="manifest"][href="/civic.webmanifest"]')) {
        const l = document.createElement("link"); l.rel = "manifest"; l.href = "/civic.webmanifest"; document.head.appendChild(l);
      }
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/civic-sw.js").catch(() => { /* optional */ });
    } catch { /* optional */ }
  }, []);

  return (
    <div data-testid="civic-home" className="civic-root space-y-6 max-w-full overflow-x-hidden">
      <style>{TARGET_CSS}</style>
      <header className="space-y-2">
        <h1 className="text-2xl font-bold break-words">{c("c.title")}</h1>
        <p className="text-sm">{c("c.intro")}</p>
        <p className="text-xs">{c("c.lite")}</p>
      </header>
      {link.invite ? (
        <InviteAccept inviteId={link.invite} session={session} onSession={setSession} onFinish={() => { closeLink(); if (!tokenStore.get()) setSession(null); }} />
      ) : link.activate && !session ? (
        <VolunteerActivate code={link.activate} onDone={(s) => { setSession(s); closeLink(); }} />
      ) : !session ? (
        view === "recover" ? <PinRecovery onBack={() => setView("login")} /> :
        view === "choose" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <Btn data-testid="civic-signup-btn" onClick={() => setView("signup")}>{c("c.signup")}</Btn>
              <Btn secondary data-testid="civic-login-btn" onClick={() => setView("login")}>{c("c.login")}</Btn>
            </div>
            <DemoPersonas onDone={setSession} />
          </div>
        ) : view === "signup" ? <SignUpFlow onDone={setSession} /> : <LoginFlow onDone={setSession} onForgot={() => setView("recover")} />
      ) : (
        <>
          <p data-testid="civic-signed-in" role="status" className="text-sm">{c("c.welcome")}</p>
          <TierBadge tier={me?.tier ?? session.tier} withHint />
          <div role="tablist" aria-label={c("c.tabs.label")} data-testid="civic-tabs" className="flex flex-wrap gap-1 border-b border-black" onKeyDown={onTabKey}>
            {TABS.map((id) => (
              <button key={id} type="button" role="tab" id={`civic-tab-${id}`} aria-selected={tab === id} aria-controls={`civic-panel-${id}`} tabIndex={tab === id ? 0 : -1}
                data-testid={`civic-tab-${id}`} onClick={() => pickTab(id)}
                className={`min-h-[44px] px-4 py-2 text-sm font-bold border border-black border-b-0 -mb-px ${tab === id ? "bg-black text-white" : "bg-white text-black"}`}>
                {c(`c.tab.${id}` as CivicKey)}
              </button>
            ))}
          </div>
          <Panel id="report" tab={tab}>
            <IssueReport onSent={() => setTick((n) => n + 1)} />
            <AssistedSegment refreshKey={tick} />
            {me?.role === "volunteer" && <AssistedEntry />}
          </Panel>
          <Panel id="mine" tab={tab}>
            <MyReports refreshKey={tick} />
            <IssueFeed refreshKey={tick} />
          </Panel>
          <Panel id="household" tab={tab}>
            <HouseholdPage token={session.token} />
          </Panel>
          <Panel id="account" tab={tab}>
            {me?.flags?.includes("email_only") && <AddPhone onAdded={refreshMe} />}
            <ResidenceFlow declared={!!me?.residence_declared} onDeclared={refreshMe} />
            {me?.role === "volunteer" && <Attestation isVolunteer />}
            <SessionsPage />
          </Panel>
          <Panel id="explore" tab={tab}>
            <SurveysLink />
            <NotifyLink />
            <ConsultationsLink />
            <ScopeLink />
          </Panel>
          <Panel id="roles" tab={tab}>
            <ConsolesHub />
            <OfficerApply />
          </Panel>
        </>
      )}
    </div>
  );
}
