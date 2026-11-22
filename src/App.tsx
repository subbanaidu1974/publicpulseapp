/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from "react";
import { Activity } from "lucide-react";

import Navbar from "./components/Navbar";
import FAQPage from "./components/FAQPage";
import ElectionsPage from "./components/ElectionsPage";
import CivicHome from "./components/civic/CivicHome";
import ConstituencySearch from "./components/ConstituencySearch";
import HomePage from "./components/pages/HomePage";
import AnalyticsPage from "./components/pages/AnalyticsPage";
import MapPage from "./components/maps/MapPage";
import SurveyPage from "./components/pages/SurveyPage";
import MethodologyPage from "./components/pages/MethodologyPage";
import AdminPage from "./components/pages/AdminPage";
import { PrivacyPage, TermsPage, WhoSeesPage } from "./components/pages/LegalPages";
import ConsentBanner from "./components/ConsentBanner";
import { StateProvider, useStateCtx, defaultYear } from "./state/StateContext";
import { LangProvider, useT } from "./i18n";
import ProfilePage from "./components/profiles/ProfilePage";
import PlaceSearch from "./components/profiles/PlaceSearch";
import { parseProfileHash } from "./api/profiles";
import { isSurveysHash } from "./components/surveys/SurveysRoot";
import PeoplePage, { isPeopleHash } from "./components/people/PeoplePage";
import { PEOPLE_TEXT } from "./components/people/peopleText";

type Theme = "beige" | "dark" | "dark-beige" | "earth-yellow";
const THEMES: Theme[] = ["beige", "dark", "dark-beige", "earth-yellow"];
const TABS = ["home", "map", "analytics", "elections", "civic", "constituencies", "survey", "methodology", "faq", "admin", "privacy", "terms", "who", "people"];

function initialTab(): string {
  try { if (window.location.pathname.replace(/\/+$/, "") === "/admin") return "admin"; } catch { /* ignore */ }
  try { if (/^#\/map(\/|$)/.test(window.location.hash)) return "map"; } catch { /* ignore */ }
  try { if (parseProfileHash(window.location.hash)) return "constituencies"; } catch { /* ignore */ }
  try { if (isPeopleHash(window.location.hash)) return "people"; } catch { /* ignore */ }
  try { if (isSurveysHash(window.location.hash)) return "survey"; } catch { /* ignore */ }
  try { const q = new URLSearchParams(window.location.search); if (q.get("invite") || q.get("activate")) return "civic"; } catch { /* ignore */ }
  return "home";
}

function AppInner() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("app-theme");
      if (THEMES.includes(saved as Theme)) return saved as Theme;
    } catch { /* ignore */ }
    return "beige";
  });
  useEffect(() => { try { localStorage.setItem("app-theme", theme); } catch { /* ignore */ } }, [theme]);

  const [currentTab, setCurrentTabRaw] = useState<string>(initialTab);
  // Profile pages (#/constituency/<ST>/<n>, #/place/<ST>/<level>/<code>) take over the main area until a tab is chosen or Back is pressed.
  const [profileRoute, setProfileRoute] = useState(() => { try { return parseProfileHash(window.location.hash); } catch { return null; } });
  useEffect(() => {
    const on = () => setProfileRoute(parseProfileHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const closeProfile = () => {
    if (parseProfileHash(window.location.hash)) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setProfileRoute(null);
  };
  // People pages (#/people/...) live in the "people" tab; choosing another tab clears that hash.
  useEffect(() => {
    const on = () => { if (isPeopleHash(window.location.hash)) setCurrentTabRaw("people"); else if (isSurveysHash(window.location.hash)) { closeProfile(); setCurrentTabRaw("survey"); } };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const setCurrentTab = (tab: string) => {
    closeProfile();
    if (tab !== "people" && isPeopleHash(window.location.hash)) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (tab !== "survey" && isSurveysHash(window.location.hash)) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setCurrentTabRaw(tab);
  };
  const [reopenConsent, setReopenConsent] = useState(false);
  const { state: stateCode, config: stateCfg } = useStateCtx();
  const { t, lang } = useT();

  useEffect(() => {
    const on = (e: Event) => {
      const tab = String((e as CustomEvent).detail);
      setCurrentTab(TABS.includes(tab) ? tab : "home");
    };
    window.addEventListener("pp-nav", on);
    return () => window.removeEventListener("pp-nav", on);
  }, []);

  const stateName = lang === "te" ? stateCfg.nameTe : stateCfg.name;
  const bg = theme === "dark" ? "bg-[#0B0B0A] text-[#FAF8F5]" : theme === "dark-beige" ? "bg-[#1E1C18] text-[#EADCC6]" : theme === "earth-yellow" ? "bg-[#F4EBD0] text-[#3E2723]" : "bg-[#F9F7F2] text-[#121212]";

  return (
    <div className={`min-h-screen flex flex-col justify-between font-sans selection:bg-black selection:text-[#F9F7F2] transition-colors duration-300 ${theme} ${bg}`}>
      <ConsentBanner forceOpen={reopenConsent} onClose={() => setReopenConsent(false)} />
      <Navbar currentTab={currentTab} setCurrentTab={setCurrentTab} theme={theme} setTheme={setTheme} />

      <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {profileRoute ? (
          <ProfilePage route={profileRoute} onBack={() => { if (window.history.length > 1) window.history.back(); else closeProfile(); }} />
        ) : (<>
        {currentTab === "home" && <HomePage theme={theme} />}
        {currentTab === "map" && <MapPage theme={theme} />}
        {currentTab === "analytics" && <AnalyticsPage />}
        {currentTab === "elections" && <ElectionsPage />}
        {currentTab === "civic" && <CivicHome />}
        {currentTab === "constituencies" && <><ConstituencySearch year={defaultYear(stateCode, "assembly")} type="assembly" /><PlaceSearch /></>}
        {currentTab === "survey" && <SurveyPage />}
        {currentTab === "methodology" && <MethodologyPage />}
        {currentTab === "faq" && <FAQPage />}
        {currentTab === "admin" && <AdminPage />}
        {currentTab === "privacy" && <PrivacyPage />}
        {currentTab === "terms" && <TermsPage />}
        {currentTab === "who" && <WhoSeesPage />}
        {currentTab === "people" && <PeoplePage />}
        </>)}
      </main>

      <footer className="bg-[#FAF8F5] text-[#121212] border-t border-black grid grid-cols-1 md:grid-cols-12 gap-8 px-8 sm:px-12 py-10 text-xs font-serif">
        <div className="md:col-span-7 space-y-3">
          <div className="flex items-center space-x-2">
            <div className="border border-black bg-black text-[#FAF8F5] p-2 flex items-center justify-center"><Activity className="w-4 h-4" /></div>
            <strong className="font-sans text-xs tracking-[0.25em] uppercase font-black">PEOPLE PULSE {stateName}</strong>
          </div>
          <p className="leading-relaxed text-[11px] max-w-md">{t("footer.about")}</p>
        </div>
        <div className="md:col-span-5 space-y-2 font-sans text-[10px]">
          <strong className="block uppercase tracking-[0.2em] font-black pb-2 border-b border-black/10">{t("footer.links")}</strong>
          {(["elections", "constituencies", "methodology", "civic", "privacy", "terms", "who", "people"] as const).map((tab) => (
            <button key={tab} data-testid={`footer-link-${tab}`} type="button" onClick={() => { setCurrentTab(tab); window.scrollTo?.(0, 0); }} className="block hover:underline text-left cursor-pointer">
              {tab === "people" ? PEOPLE_TEXT[lang]["ppl.tab"] : tab === "constituencies" ? t("nav.constituencies") : tab === "elections" ? t("nav.elections") : tab === "civic" ? t("nav.civic") : tab === "privacy" ? t("nav.privacy") : tab === "terms" ? t("nav.terms") : tab === "who" ? t("nav.who") : t("nav.methodology")}
            </button>
          ))}
          <button data-testid="footer-consent" type="button" onClick={() => { setReopenConsent(true); window.scrollTo?.(0, 0); }} className="block hover:underline text-left cursor-pointer">{t("consent.change")}</button>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <LangProvider>
      <StateProvider>
        <AppInner />
      </StateProvider>
    </LangProvider>
  );
}
