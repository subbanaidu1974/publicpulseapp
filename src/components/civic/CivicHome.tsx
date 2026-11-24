import { useEffect, useState } from "react";
import { civicIdentityApi, tokenStore, type MePerson, type Session } from "../../api/civic";
import Attestation, { VolunteerActivate } from "./Attestation";
import InviteAccept from "./InviteAccept";
import PinRecovery from "./PinRecovery";
import ResidenceFlow from "./ResidenceFlow";
import SessionsPage from "./SessionsPage";
import TierBadge from "./TierBadge";
import { useCivicT } from "./civicText";
import HouseholdPage from "./HouseholdPage";
import ConsolesHub from "./consoles/ConsolesHub";
import OfficerApply from "./OfficerApply";
import IssueFeed from "./IssueFeed";
import IssueReport from "./IssueReport";
import MyReports from "./MyReports";
import LoginFlow from "./LoginFlow";
import SignUpFlow from "./SignUpFlow";
import { Btn } from "./ui";
import { SurveysLink, NotifyLink, ConsultationsLink, ScopeLink } from "./CrossLinks";

/** WCAG 2.2 AA target size: every control inside the civic tab (including Agent B components) gets at least 44px. */
const TARGET_CSS = ".civic-root button,.civic-root select,.civic-root input:not([type=checkbox]):not([type=radio]),.civic-root textarea{min-height:44px;min-width:44px}.civic-root input[type=checkbox],.civic-root input[type=radio]{width:24px;height:24px}.civic-root label{min-height:24px}";

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
  const [link, setLink] = useState(deepLink);
  const [me, setMe] = useState<MePerson | null>(null);
  const refreshMe = () => { civicIdentityApi.me().then(setMe).catch(() => setMe(null)); };
  useEffect(() => { if (session) refreshMe(); else setMe(null); }, [session]);
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
          <div className="flex flex-wrap gap-3">
            <Btn data-testid="civic-signup-btn" onClick={() => setView("signup")}>{c("c.signup")}</Btn>
            <Btn secondary data-testid="civic-login-btn" onClick={() => setView("login")}>{c("c.login")}</Btn>
          </div>
        ) : view === "signup" ? <SignUpFlow onDone={setSession} /> : <LoginFlow onDone={setSession} onForgot={() => setView("recover")} />
      ) : (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <p data-testid="civic-signed-in" role="status">{c("c.welcome")}</p>
            <Btn secondary data-testid="civic-logout" onClick={async () => { await civicIdentityApi.logout(); tokenStore.clear(); setSession(null); setView("choose"); }}>{c("c.logout")}</Btn>
          </div>
          <TierBadge tier={me?.tier ?? session.tier} withHint />
          <ResidenceFlow declared={!!me?.residence_declared} onDeclared={refreshMe} />
          {me?.role === "volunteer" && <Attestation isVolunteer />}
          <SessionsPage />
          <HouseholdPage token={session.token} />
          <IssueReport onSent={() => setTick((n) => n + 1)} />
          <MyReports refreshKey={tick} />
          <IssueFeed refreshKey={tick} />
          <SurveysLink />
          <NotifyLink />
          <ConsultationsLink />
          <ScopeLink />
          <ConsolesHub />
          <OfficerApply />
        </>
      )}
    </div>
  );
}
