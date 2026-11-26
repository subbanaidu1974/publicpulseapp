/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from "react";
import { Activity, Menu, X, Moon, Sun, Sparkles, Compass } from "lucide-react";
import { useStateCtx } from "../state/StateContext";
import { isStateCode, STATES } from "../lib/states";
import { useT } from "../i18n";
import { civicIdentityApi, tokenStore } from "../api/civic";

type Theme = "beige" | "dark" | "dark-beige" | "earth-yellow";

interface NavbarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const NEXT_THEME: Record<Theme, Theme> = { beige: "dark", dark: "dark-beige", "dark-beige": "earth-yellow", "earth-yellow": "beige" };
const THEME_ICON = { beige: Moon, dark: Sparkles, "dark-beige": Sun, "earth-yellow": Compass } as const;
const THEME_LABEL: Record<Theme, string> = { beige: "Editorial Beige", dark: "High-Contrast Dark", "dark-beige": "Dark Editorial Beige", "earth-yellow": "Earth Yellow" };

export default function Navbar({ currentTab, setCurrentTab, theme, setTheme }: NavbarProps) {
  const [isOpenInput, setIsOpenInput] = useState(false);
  const { state, config, setState } = useStateCtx();
  const { t, lang, setLang } = useT();
  const [isDesktop, setIsDesktop] = useState<boolean>(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const [signedIn, setSignedIn] = useState<boolean>(() => !!tokenStore.get());
  useEffect(() => {
    const on = () => setSignedIn(!!tokenStore.get());
    window.addEventListener("pp-session", on);
    return () => window.removeEventListener("pp-session", on);
  }, []);
  const logout = async () => { await civicIdentityApi.logout(); tokenStore.clear(); setIsOpenInput(false); };

  const navItems = [
    { id: "home", label: t("nav.home") },
    { id: "map", label: t("nav.map") },
    { id: "analytics", label: t("nav.analytics") },
    { id: "elections", label: t("nav.elections") },
    { id: "civic", label: t("nav.civic") },
    { id: "constituencies", label: `${t("nav.constituencies")} (${config.assemblySeats})` },
    { id: "survey", label: t("nav.survey") },
    { id: "methodology", label: t("nav.methodology") },
    { id: "faq", label: t("nav.faq") },
  ];

  const handleNavClick = (tabId: string) => {
    setCurrentTab(tabId);
    setIsOpenInput(false);
  };
  const testId = (id: string) => (id === "elections" ? "nav-elections" : id === "civic" ? "nav-civic" : undefined);
  const ThemeIcon = THEME_ICON[theme];

  return (
    <nav id="app-navbar" className="sticky top-0 z-50 bg-[#F9F7F2] text-[#121212] border-b border-black shadow-none font-sans">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-20">
          <div className="flex items-center space-x-2 sm:space-x-3 cursor-pointer min-w-0 shrink" onClick={() => handleNavClick("home")}>
            <div className="border border-black p-1.5 sm:p-2 bg-black text-[#F9F7F2] flex items-center justify-center shrink-0">
              <Activity className="w-5 h-5" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-sans font-black text-[10px] sm:text-xs tracking-[0.15em] sm:tracking-[0.25em] uppercase text-black leading-none mb-1 truncate">PEOPLE PULSE</span>
              <span className="font-serif italic text-xs sm:text-sm text-[#121212] tracking-wide leading-none truncate">{lang === "te" ? config.nameTe : config.name}</span>
            </div>
          </div>

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

          <div className="hidden lg:flex items-center space-x-4">
            <button
              type="button"
              onClick={() => setTheme(NEXT_THEME[theme])}
              className="flex items-center space-x-1.5 text-[10px] tracking-[0.15em] font-bold uppercase border border-black px-3 py-1.5 hover:bg-black hover:text-[#F9F7F2] transition-colors bg-transparent text-[#121212]"
              title="Toggle theme"
            >
              <ThemeIcon className="w-3.5 h-3.5" />
              <span>{THEME_LABEL[theme]}</span>
            </button>
            <button
              type="button"
              data-testid={signedIn ? "sign-out" : "sign-in"}
              onClick={signedIn ? () => void logout() : () => handleNavClick("civic")}
              className="text-[10px] tracking-[0.2em] font-bold uppercase border border-black bg-black text-[#F9F7F2] px-4 py-1.5 hover:bg-transparent hover:text-black transition-colors"
            >
              {signedIn ? t("nav.signout") : t("nav.signin")}
            </button>
          </div>

          <div className="flex items-center lg:hidden space-x-1 shrink-0">
            <button
              type="button"
              data-testid={signedIn ? "sign-out-mobile" : "sign-in-mobile"}
              onClick={signedIn ? () => void logout() : () => handleNavClick("civic")}
              className="p-1.5 border border-black bg-black text-[#F9F7F2] text-[10px] font-bold uppercase tracking-wider"
            >
              {signedIn ? t("nav.signout") : t("nav.signin")}
            </button>
            <button
              type="button"
              onClick={() => setTheme(NEXT_THEME[theme])}
              className="p-1.5 border border-black bg-transparent text-black flex items-center justify-center"
              title="Toggle theme"
              aria-label="Toggle theme"
            >
              <ThemeIcon className="w-4 h-4" />
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

      {isDesktop && (
        <div className="bg-transparent border-t border-black/15">
          <div className="max-w-7xl mx-auto px-4">
            <div className="flex flex-wrap py-1">
              {navItems.map((item) => (
                <button
                  key={item.id} data-testid={testId(item.id)}
                  onClick={() => handleNavClick(item.id)}
                  className={`px-3 py-3 text-[10px] sm:text-[11px] tracking-[0.15em] uppercase transition-all relative no-underline ${
                    currentTab === item.id ? "text-black font-black" : "text-[#121212]/60 font-semibold hover:text-black hover:font-black"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {isOpenInput && !isDesktop && (
        <div id="mobile-navigation" className="bg-[#F9F7F2] border-t border-black/30 px-2 pt-2 pb-4 space-y-1">
          {navItems.map((item) => (
            <button
              key={item.id} data-testid={testId(item.id)}
              onClick={() => handleNavClick(item.id)}
              className={`w-full text-left block px-3 py-2.5 text-[11px] font-bold tracking-widest uppercase border-b border-black/5 ${
                currentTab === item.id ? "bg-black text-white" : "text-[#121212] hover:bg-black/5"
              }`}
            >
              {item.label}
            </button>
          ))}
          <div className="pt-3 px-3">
            <button
              type="button"
              onClick={signedIn ? () => void logout() : () => handleNavClick("civic")}
              className="w-full text-center border border-black bg-black text-[#F9F7F2] py-2 text-[10px] font-bold tracking-widest uppercase"
            >
              {signedIn ? t("nav.signout") : t("nav.signin")}
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}
