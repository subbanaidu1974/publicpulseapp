/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from "react";
import { Vote, Layers, Users, ShieldAlert, Clock, Menu, X, CheckCircle, Moon, Sun, Sparkles, Compass } from "lucide-react";
import { UserRole } from "../types";
import { useStateCtx } from "../state/StateContext";
import { isStateCode, STATES } from "../lib/states";
import { useT } from "../i18n";

interface NavbarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  currentUserRole: UserRole;
  setCurrentUserRole: (role: UserRole) => void;
  currentUserEmail?: string;
  setCurrentUserEmail?: (email: string) => void;
  isLoggedIn: boolean;
  setIsLoggedIn: (val: boolean) => void;
  theme: "beige" | "dark" | "dark-beige" | "earth-yellow";
  setTheme: (theme: "beige" | "dark" | "dark-beige" | "earth-yellow") => void;
}

export default function Navbar({
  currentTab,
  setCurrentTab,
  currentUserRole,
  setCurrentUserRole,
  currentUserEmail = "",
  setCurrentUserEmail,
  isLoggedIn,
  setIsLoggedIn,
  theme,
  setTheme
}: NavbarProps) {
  const [isOpenInput, setIsOpenInput] = useState(false);
  const [showRoleMenu, setShowRoleMenu] = useState(false);
  const { state, config, setState } = useStateCtx();
  const { t, lang, setLang } = useT();
  const [isDesktop, setIsDesktop] = useState<boolean>(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const navItems = [
    { id: "home", label: t("nav.home") },
    { id: "analytics", label: t("nav.analytics") },
    { id: "elections", label: t("nav.elections") },
    { id: "civic", label: lang === "te" ? "పౌర" : "Civic" },
    { id: "constituencies", label: `${t("nav.constituencies")} (${config.assemblySeats})` },
    { id: "survey", label: t("nav.survey") },
    { id: "reports", label: t("nav.reports") },
    { id: "methodology", label: t("nav.methodology") },
    { id: "media", label: t("nav.media") },
    { id: "faq", label: t("nav.faq") },
    { id: "contact", label: t("nav.contact") }
  ];

  const handleNavClick = (tabId: string) => {
    setCurrentTab(tabId);
    setIsOpenInput(false);
  };

  const handleRoleChange = (role: UserRole) => {
    setCurrentUserRole(role);
    setShowRoleMenu(false);
    // Auto redirect to relevant tab for administrators
    if (role !== UserRole.Citizen) {
      setIsLoggedIn(true);
    }
  };

  return (
    <nav id="app-navbar" className="sticky top-0 z-50 bg-[#F9F7F2] text-[#121212] border-b border-black shadow-none font-sans">
      {/* Upper bar: Logo and State switcher */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-20">
          {/* Logo Brand */}
          <div className="flex items-center space-x-2 sm:space-x-3 cursor-pointer min-w-0 shrink" onClick={() => handleNavClick("home")}>
            <div className="border border-black p-1.5 sm:p-2 bg-black text-[#F9F7F2] flex items-center justify-center shrink-0">
              <Vote className="w-5 h-5" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-sans font-black text-[10px] sm:text-xs tracking-[0.15em] sm:tracking-[0.25em] uppercase text-black leading-none mb-1 truncate">
                PEOPLE PULSE
              </span>
              <span className="font-serif italic text-xs sm:text-sm text-[#121212] tracking-wide leading-none truncate">
                {lang === "te" ? config.nameTe : config.name} / Vol. VI
              </span>
            </div>
          </div>

          {/* State switcher + language toggle (all viewports) */}
          <div className="flex items-center gap-1 sm:gap-1.5 ml-auto mr-1 sm:mr-2 lg:mr-4 shrink-0">
            <select
              data-testid="state-switcher"
              aria-label={t("state.label")}
              value={state}
              onChange={(e) => { if (isStateCode(e.target.value)) setState(e.target.value); }}
              className="border border-black bg-transparent text-[10px] font-bold uppercase tracking-wider p-1.5 max-w-[6.5rem] sm:max-w-[9rem]"
            >
              {Object.values(STATES).map((s) => (
                <option key={s.code} value={s.code}>{lang === "te" ? s.nameTe : s.name}</option>
              ))}
            </select>
            <button
              type="button"
              data-testid="lang-toggle"
              onClick={() => setLang(lang === "en" ? "te" : "en")}
              className="border border-black px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-transparent hover:bg-black hover:text-[#F9F7F2] cursor-pointer"
            >
              {t("lang.toggle")}
            </button>
          </div>

          {/* Time & Role Switcher (Desktop) */}
          <div className="hidden lg:flex items-center space-x-4">
            <button
              onClick={() => {
                if (theme === "beige") setTheme("dark");
                else if (theme === "dark") setTheme("dark-beige");
                else if (theme === "dark-beige") setTheme("earth-yellow");
                else setTheme("beige");
              }}
              className="flex items-center space-x-1.5 text-[10px] tracking-[0.15em] font-bold uppercase border border-black px-3 py-1.5 hover:bg-black hover:text-[#F9F7F2] transition-colors bg-transparent text-[#121212]"
              title="Toggle Theme (Editorial Beige -> Dark -> Dark Beige -> Earth Yellow)"
            >
              {theme === "beige" ? (
                <>
                  <Moon className="w-3.5 h-3.5" />
                  <span>Editorial Beige</span>
                </>
              ) : theme === "dark" ? (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>High-Contrast Dark</span>
                </>
              ) : theme === "dark-beige" ? (
                <>
                  <Sun className="w-3.5 h-3.5" />
                  <span>Dark Editorial Beige</span>
                </>
              ) : (
                <>
                  <Compass className="w-3.5 h-3.5" />
                  <span>Earth Yellow</span>
                </>
              )}
            </button>

            <div className="flex items-center space-x-1.5 text-[10px] text-slate-600 bg-[#E5E2D9]/40 px-3 py-1.5 border border-black/10 font-mono">
              <Clock className="w-3 h-3 text-black" />
              <span>AP SEC LOG: 2026-06-17 21:30</span>
            </div>

            {/* Login control */}
            {isLoggedIn ? (
              <button
                onClick={() => {
                  setIsLoggedIn(false);
                  setCurrentUserRole(UserRole.Citizen);
                  if (setCurrentUserEmail) setCurrentUserEmail("");
                }}
                className="text-[10px] tracking-[0.2em] font-bold uppercase border border-red-800/40 text-red-700 hover:bg-red-700 hover:text-white px-4 py-1.5 transition-colors bg-transparent"
              >
                Sign Out
              </button>
            ) : (
              <button
                onClick={() => handleNavClick("login")}
                className="text-[10px] tracking-[0.2em] font-bold uppercase border border-black bg-black text-[#F9F7F2] px-4 py-1.5 hover:bg-transparent hover:text-black transition-colors"
              >
                Sign In
              </button>
            )}
          </div>

          {/* Mobile menu button */}
          <div className="flex items-center lg:hidden space-x-1 shrink-0">
            <button
              onClick={() => {
                if (theme === "beige") setTheme("dark");
                else if (theme === "dark") setTheme("dark-beige");
                else if (theme === "dark-beige") setTheme("earth-yellow");
                else setTheme("beige");
              }}
              className="p-1.5 border border-black bg-transparent text-black flex items-center justify-center"
              title="Toggle Theme"
            >
              {theme === "beige" ? (
                <Moon className="w-4 h-4" />
              ) : theme === "dark" ? (
                <Sparkles className="w-4 h-4" />
              ) : theme === "dark-beige" ? (
                <Sun className="w-4 h-4" />
              ) : (
                <Compass className="w-4 h-4" />
              )}
            </button>



            <button
              id="mobile-menu-toggle"
              aria-label="Toggle navigation menu"
              aria-expanded={isOpenInput}
              onClick={() => setIsOpenInput(!isOpenInput)}
              className="p-1.5 border border-black bg-transparent text-black"
            >
              {isOpenInput ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Navigation Sub-Menu Tab Bar (Desktop Only for clean space) */}
      {isDesktop && (
      <div className="bg-transparent border-t border-black/15">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex flex-wrap py-1">
            {navItems.map((item) => (
              <button
                key={item.id} data-testid={item.id === "elections" ? "nav-elections" : item.id === "civic" ? "nav-civic" : undefined}
                onClick={() => handleNavClick(item.id)}
                className={`px-3 py-3 text-[10px] sm:text-[11px] tracking-[0.15em] uppercase transition-all relative no-underline ${
                  currentTab === item.id
                    ? "text-black font-black"
                    : "text-[#121212]/60 font-semibold hover:text-black hover:font-black"
                }`}
              >
                {item.label}
              </button>
            ))}

            {isLoggedIn && currentUserEmail.toLowerCase().trim() === "admin@peoplepulse.ap" && (
              <button
                onClick={() => handleNavClick("admin")}
                className={`px-3 py-3 text-[10px] sm:text-[11px] tracking-[0.15em] uppercase transition-all no-underline ${
                  currentTab === "admin"
                    ? "text-red-700 font-black"
                    : "text-red-700/60 font-semibold hover:text-red-700 hover:font-black"
                }`}
              >
                <span>Admin Console</span>
              </button>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Mobile Menu Panel */}
      {isOpenInput && !isDesktop && (
        <div id="mobile-navigation" className="bg-[#F9F7F2] border-t border-black/30 px-2 pt-2 pb-4 space-y-1">
          {navItems.map((item) => (
            <button
              key={item.id} data-testid={item.id === "elections" ? "nav-elections" : item.id === "civic" ? "nav-civic" : undefined}
              onClick={() => handleNavClick(item.id)}
              className={`w-full text-left block px-3 py-2.5 text-[11px] font-bold tracking-widest uppercase border-b border-black/5 ${
                currentTab === item.id
                  ? "bg-black text-white"
                  : "text-[#121212] hover:bg-black/5"
              }`}
            >
              {item.label}
            </button>
          ))}

          {isLoggedIn && currentUserEmail.toLowerCase().trim() === "admin@peoplepulse.ap" && (
            <button
              onClick={() => handleNavClick("admin")}
              className={`w-full text-left flex items-center space-x-2 block px-3 py-2.5 text-[11px] font-bold tracking-widest uppercase ${
                currentTab === "admin"
                  ? "bg-red-700 text-white"
                  : "text-red-700 bg-red-50 hover:bg-red-100"
              }`}
            >
              <ShieldAlert className="w-4 h-4" />
              <span>Admin Control</span>
            </button>
          )}

          <div className="pt-3 flex flex-col space-y-2 px-3">
            <span className="text-[10px] text-slate-500 font-mono">Time: 2026-06-17 21:30</span>
            {isLoggedIn ? (
              <button
                onClick={() => {
                  setIsLoggedIn(false);
                  setCurrentUserRole(UserRole.Citizen);
                  if (setCurrentUserEmail) setCurrentUserEmail("");
                  handleNavClick("home");
                }}
                className="w-full text-center border border-red-700/40 text-red-705 py-2 text-[10px] font-bold tracking-widest uppercase bg-transparent"
              >
                Log Out
              </button>
            ) : (
              <button
                onClick={() => handleNavClick("login")}
                className="w-full text-center border border-black bg-black text-[#F9F7F2] py-2 text-[10px] font-bold tracking-widest uppercase"
              >
                Sign In
              </button>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
