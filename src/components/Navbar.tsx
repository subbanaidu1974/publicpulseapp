/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from "react";
import { Vote, Layers, Users, ShieldAlert, Clock, Menu, X, CheckCircle, Moon, Sun, Sparkles, Compass } from "lucide-react";
import { UserRole } from "../types";

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

  const navItems = [
    { id: "home", label: "Home" },
    { id: "analytics", label: "Analytics Dashboard" },
    { id: "constituencies", label: "Constituencies (175)" },
    { id: "survey", label: "Take Survey" },
    { id: "reports", label: "Research Reports" },
    { id: "methodology", label: "Methodology" },
    { id: "media", label: "Media Center" },
    { id: "faq", label: "FAQ" },
    { id: "contact", label: "Contact Us" }
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
          <div className="flex items-center space-x-3 cursor-pointer" onClick={() => handleNavClick("home")}>
            <div className="border border-black p-2 bg-black text-[#F9F7F2] flex items-center justify-center">
              <Vote className="w-5 h-5" />
            </div>
            <div className="flex flex-col">
              <span className="font-sans font-black text-xs tracking-[0.25em] uppercase text-black leading-none mb-1">
                PEOPLE PULSE
              </span>
              <span className="font-serif italic text-sm text-[#121212] tracking-wide leading-none">
                Andhra Pradesh / Vol. VI
              </span>
            </div>
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
          <div className="flex items-center lg:hidden space-x-2">
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
              onClick={() => setIsOpenInput(!isOpenInput)}
              className="p-1.5 border border-black bg-transparent text-black"
            >
              {isOpenInput ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Navigation Sub-Menu Tab Bar (Desktop Only for clean space) */}
      <div className="hidden lg:block bg-transparent border-t border-black/15">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex space-x-1 py-1">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className={`px-4 py-3 text-[10px] sm:text-[11px] tracking-[0.2em] uppercase transition-all relative no-underline ${
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
                className={`px-4 py-3 text-[10px] sm:text-[11px] tracking-[0.2em] uppercase transition-all no-underline ${
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

      {/* Mobile Menu Panel */}
      {isOpenInput && (
        <div id="mobile-navigation" className="lg:hidden bg-[#F9F7F2] border-t border-black/30 px-2 pt-2 pb-4 space-y-1">
          {navItems.map((item) => (
            <button
              key={item.id}
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
