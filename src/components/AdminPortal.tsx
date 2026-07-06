/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, FormEvent } from "react";
import { ShieldCheck, Flag, Users, FileLock, CheckCircle2, FileDown, AlertTriangle, Mail, Key, Server, Database, Save, Loader2, Eye, EyeOff } from "lucide-react";
import { UserRole, SurveyResponse } from "../types";
import { CONSTITUENCIES } from "../data/staticData";

interface AdminPortalProps {
  currentUserRole: UserRole;
  setCurrentUserRole: (role: UserRole) => void;
  surveyResponses: SurveyResponse[];
  onApproveResponse: (id: string) => void;
  onFlagResponse: (id: string) => void;
}

export default function AdminPortal({
  currentUserRole,
  setCurrentUserRole,
  surveyResponses,
  onApproveResponse,
  onFlagResponse
}: AdminPortalProps) {
  const [activeTab, setActiveTab ] = useState<"surveys" | "compliance" | "export" | "otpConfig">("surveys");
  const [successExport, setSuccessExport] = useState(false);

  // Core configuration states for OTP delivery
  const [config, setConfig] = useState({
    WEB3FORMS_ACCESS_KEY: "",
    SMTP_HOST: "",
    SMTP_PORT: "587",
    SMTP_USER: "",
    SMTP_PASS: "",
    SMTP_FROM: "",
    SMTP_SECURE: "false",
  });
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configSuccess, setConfigSuccess] = useState("");
  const [configError, setConfigError] = useState("");

  const [testEmail, setTestEmail] = useState("");
  const [testingDelivery, setTestingDelivery] = useState(false);
  const [testSuccess, setTestSuccess] = useState("");
  const [testError, setTestError] = useState("");
  const [showSmtpPass, setShowSmtpPass] = useState(false);

  const fetchConfig = async () => {
    setLoadingConfig(true);
    setConfigError("");
    setConfigSuccess("");
    try {
      const resp = await fetch(`/api/admin/config?role=${encodeURIComponent(currentUserRole)}`, {
        headers: {
          "x-user-role": currentUserRole
        }
      });
      const data = await resp.json();
      if (data.success) {
        setConfig(data.config);
      } else {
        setConfigError(data.error || "Failed to load dynamic configurations.");
      }
    } catch (err: any) {
      setConfigError("API offline or network error while fetching configurations.");
    } finally {
      setLoadingConfig(false);
    }
  };

  useEffect(() => {
    if (currentUserRole === UserRole.SuperAdmin) {
      fetchConfig();
    }
  }, [activeTab, currentUserRole]);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingConfig(true);
    setConfigError("");
    setConfigSuccess("");
    try {
      const resp = await fetch(`/api/admin/config?role=${encodeURIComponent(currentUserRole)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-role": currentUserRole
        },
        body: JSON.stringify(config)
      });
      const data = await resp.json();
      if (data.success) {
        setConfigSuccess(data.message || "Configurations persisted and activated successfully worldwide!");
        fetchConfig(); // Reload to sync
      } else {
        setConfigError(data.error || "Failed to save configuration.");
      }
    } catch (err: any) {
      setConfigError("Failed to save due to a network or server endpoint failure.");
    } finally {
      setSavingConfig(false);
    }
  };

  const handleSendTestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testEmail) return;
    setTestingDelivery(true);
    setTestSuccess("");
    setTestError("");

    const mockOtp = Math.floor(100000 + Math.random() * 900000).toString();

    try {
      const resp = await fetch("/api/send-otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: testEmail,
          otp: mockOtp,
          method: "email"
        })
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        if (data.simulated) {
          setTestSuccess(`Sandbox simulation successful! OTP Code ${mockOtp} printed to server console logs.`);
        } else {
          setTestSuccess(`Live message successfully dispatched via ${data.service.toUpperCase()} service! Check inbox of ${testEmail}.`);
        }
      } else {
        setTestError(data.error || "Mail transmission rejected. Check your SMTP / Resend credential parameters.");
      }
    } catch (err: any) {
      setTestError("Network delivery breakdown. Verify network status.");
    } finally {
      setTestingDelivery(false);
    }
  };

  const handleExport = () => {
    setSuccessExport(true);
    setTimeout(() => {
      setSuccessExport(false);
    }, 2500);
  };

  const redactPhone = (val?: string) => {
    if (!val) return "Redacted";
    return val.length > 5 ? val.slice(0, 3) + "****" + val.slice(-3) : "****";
  };

  // Roles permission levels
  const canApprove = currentUserRole !== UserRole.Citizen;

  return (
    <div className="space-y-8 font-serif">
      
      {/* Upper header */}
      <div className="bg-[#FAF8F5] p-6 border-l-4 border-black font-serif">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-1">
            <span className="text-[9px] bg-black text-[#FAF8F5] font-sans font-black px-2.5 py-0.5 rounded-none tracking-widest uppercase">Admin Operations Portal</span>
            <h2 className="text-2xl font-serif italic text-black mt-2 flex items-center space-x-2">
              <ShieldCheck className="w-5 h-5 text-black" />
              <span>Role-Based Console &bull; {currentUserRole}</span>
            </h2>
            <p className="text-xs text-slate-650 max-w-xl leading-relaxed">
              Your simulated workspace is configured based on RBAC authentication headers. Only verified state coordinators can validate incoming citizen logs.
            </p>
          </div>

          {/* Quick role-switch for simulation testing */}
          <div className="bg-white p-4 border border-black/10 text-xs font-sans max-w-sm">
            <span className="text-[8px] text-slate-500 uppercase block font-bold tracking-wider mb-2">Interactive Sandbox: Switch Roles for Verification testing</span>
            <div className="flex flex-wrap gap-1.5">
              {[UserRole.SurveyVolunteer, UserRole.FieldCoordinator, UserRole.ResearchAnalyst, UserRole.SuperAdmin].map((role) => (
                <button
                  key={role}
                  onClick={() => setCurrentUserRole(role)}
                  className={`px-2.5 py-1 text-[9px] font-black uppercase tracking-wider transition ${
                    currentUserRole === role ? "bg-black text-[#FAF8F5]" : "bg-[#FAF8F5] text-slate-700 hover:bg-slate-100 border border-black/5"
                  }`}
                >
                  {role.split(" ")[0]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Admin sub-tab headers */}
      <div className="flex flex-wrap gap-2 border-b border-black pb-1.5 text-xs">
        <button
          onClick={() => setActiveTab("surveys")}
          className={`px-4 py-2 font-sans font-black text-[9px] uppercase tracking-wider transition ${
            activeTab === "surveys" ? "bg-black text-[#FAF8F5]" : "bg-[#FAF8F5] text-slate-800 hover:bg-slate-100"
          }`}
        >
          Manage Survey Approvals ({surveyResponses.length} Logs)
        </button>
        <button
          onClick={() => setActiveTab("compliance")}
          className={`px-4 py-2 font-sans font-black text-[9px] uppercase tracking-wider transition ${
            activeTab === "compliance" ? "bg-black text-[#FAF8F5]" : "bg-[#FAF8F5] text-slate-800 hover:bg-slate-100"
          }`}
        >
          Ground Security Compliance
        </button>
        <button
          onClick={() => setActiveTab("export")}
          className={`px-4 py-2 font-sans font-black text-[9px] uppercase tracking-wider transition ${
            activeTab === "export" ? "bg-black text-[#FAF8F5]" : "bg-[#FAF8F5] text-slate-800 hover:bg-slate-100"
          }`}
        >
          Bulk Polls Export (CSV)
        </button>
        {currentUserRole === UserRole.SuperAdmin && (
          <button
            onClick={() => setActiveTab("otpConfig")}
            className={`px-4 py-2 font-sans font-black text-[9px] uppercase tracking-wider transition md:ml-auto border border-red-800/20 ${
              activeTab === "otpConfig" ? "bg-[#A01D24] text-[#FAF8F5]" : "bg-[#FAF8F5] text-[#A01D24] hover:bg-red-50/50"
            }`}
          >
            🔑 Global OTP Gateway Settings
          </button>
        )}
      </div>

      {/* Main Tab Screens */}
      {activeTab === "surveys" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-[10px] font-sans font-bold text-slate-500 uppercase tracking-widest">Incoming Feedback Feed Log</h4>
            <span className="text-[10px] text-slate-500 font-mono italic">Simulating active queue...</span>
          </div>

          <div className="overflow-x-auto border border-black/15 bg-white">
            <table className="min-w-full divide-y divide-black/10 text-xs">
              <thead className="bg-[#FAF8F5] text-black font-sans uppercase text-[9px] tracking-wider text-left font-black">
                <tr>
                  <th className="p-3.5">&bull; ID / Time</th>
                  <th className="p-3.5">Segment Region</th>
                  <th className="p-3.5">Respondent Demographics</th>
                  <th className="p-3.5 text-center">Scorecard Indication</th>
                  <th className="p-3.5">Narrative feedback comment</th>
                  <th className="p-3.5">Status Check</th>
                  <th className="p-3.5 text-right">Moderator Decisions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[0.05] text-slate-800 font-sans">
                {surveyResponses.map((sr) => {
                  const ac = CONSTITUENCIES.find(item => item.id === sr.constituencyId);
                  return (
                    <tr key={sr.id} className="hover:bg-slate-50/50 transition">
                      <td className="p-3.5 text-left font-mono text-[11px]">
                        <div className="text-black font-bold">{sr.id}</div>
                        <div className="text-[9.5px] text-slate-500 mt-0.5">{sr.timestamp}</div>
                      </td>
                      <td className="p-3.5">
                        <div className="font-serif italic text-[#121212] font-semibold text-xs">{ac?.name || "Constituency"}</div>
                        <div className="text-[10px] text-slate-550">{ac?.districtName} District</div>
                      </td>
                      <td className="p-3.5">
                        <div className="text-slate-850 font-medium">{sr.ageGroup} / {sr.gender}</div>
                        <div className="text-[10px] text-slate-500 truncate max-w-[124px] uppercase tracking-tight">{sr.occupation}</div>
                      </td>
                      <td className="p-3.5 text-center">
                        <div className="flex flex-col space-y-0.5 font-mono text-[10px] items-center">
                          <span className="bg-slate-100 text-slate-800 font-bold px-1.5 py-0.5 rounded-none" title="Government Performance Rating">Govt: {sr.govtRating}/5</span>
                          <span className="bg-slate-100 text-slate-805 font-bold px-1.5 py-0.5 rounded-none" title="Local MLA Rating">MLA: {sr.mlaRating}/5</span>
                        </div>
                      </td>
                      <td className="p-3.5 max-w-[280px] font-serif italic text-slate-700">
                        <p className="line-clamp-2 leading-relaxed text-xs">
                          "{sr.customFeedback}"
                        </p>
                      </td>
                      <td className="p-3.5">
                        <span className={`px-2 py-0.5 font-bold font-sans text-[8px] uppercase tracking-wider ${
                          sr.status === "Approved" 
                            ? "bg-[#2E4A3F] text-white" 
                            : sr.status === "Pending"
                            ? "bg-[#9E6F40] text-white"
                            : "bg-[#8C3E3E] text-white"
                        }`}>
                          {sr.status}
                        </span>
                      </td>
                      <td className="p-3.5 text-right">
                        {canApprove ? (
                          <div className="flex items-center justify-end gap-1.5 font-sans">
                            {sr.status !== "Approved" && (
                              <button
                                onClick={() => onApproveResponse(sr.id)}
                                className="bg-black hover:bg-slate-900 text-white font-black uppercase text-[8px] tracking-widest px-2.5 py-1.5"
                                title="Approve Entry"
                              >
                                Approve
                              </button>
                            )}
                            {sr.status !== "Flagged" && (
                              <button
                                onClick={() => onFlagResponse(sr.id)}
                                className="bg-transparent hover:bg-slate-100 text-[#8C3E3E] border border-[#8C3E3E]/20 font-black uppercase text-[8px] tracking-widest px-2.5 py-1.5"
                                title="Flag Entry"
                              >
                                Flag
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-[10px] text-slate-500 italic block font-serif">ReadOnly</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Verification compliance metadata screen */}
      {activeTab === "compliance" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          
          <div className="bg-[#FAF8F5] p-6 border border-black/10 space-y-4">
            <span className="text-[9px] text-slate-500 font-sans font-black block uppercase tracking-widest mb-1">Standard Verification and Curing Rules</span>
            <p className="text-xs text-slate-700 leading-relaxed text-justify">
              We compile strict duplicates check algorithms to audit active submission logs. Our statewide filters check weights across three independent categories:
            </p>

            <div className="space-y-4 pt-2">
              <div className="flex items-start space-x-3 bg-white p-4 border border-black/5 font-serif">
                <ShieldCheck className="w-5 h-5 text-black flex-shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold text-black uppercase font-sans">OTP Authentication simulation matching</div>
                  <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">Telemetry links are hashed inside client sessions to stop rapid multiple submissions from single devices.</p>
                </div>
              </div>

              <div className="flex items-start space-x-3 bg-white p-4 border border-black/5 font-serif">
                <Flag className="w-5 h-5 text-black flex-shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold text-black uppercase font-sans">Device-Fingerprint Duplicate Curing</div>
                  <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">Each voter unit gets locked to a single submit event block per assembly seat per cycle.</p>
                </div>
              </div>

              <div className="flex items-start space-x-3 bg-white p-4 border border-black/5 font-serif">
                <Users className="w-5 h-5 text-black flex-shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold text-black uppercase font-sans">Coordinator Double Audits</div>
                  <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">Entries with highly anomalous ratings are automatically routed to the pending queue for verification clearance.</p>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 border border-black/10 space-y-4 flex flex-col justify-between font-serif">
            <div>
              <span className="text-[9px] text-slate-500 font-sans font-black block uppercase tracking-widest mb-4">Interactive System Status indices</span>
              
              <div className="space-y-2.5 text-xs font-mono">
                <div className="flex justify-between p-3 bg-[#FAF8F5] border border-black/[0.05] rounded-none">
                  <span className="text-slate-600">STATE VOLUNTEERS ON FIELD:</span>
                  <span className="text-black font-bold">14,240 active</span>
                </div>
                <div className="flex justify-between p-3 bg-[#FAF8F5] border border-black/[0.05] rounded-none">
                  <span className="text-slate-600">DESKTOP DATA SECURITY:</span>
                  <span className="text-black font-bold">SHA-256 JWT COMPLIANT</span>
                </div>
                <div className="flex justify-between p-3 bg-[#FAF8F5] border border-black/[0.05] rounded-none">
                  <span className="text-slate-600">AVERAGE PROCESSING DELAY:</span>
                  <span className="text-black font-bold">12.4 SECONDS / UNIT</span>
                </div>
                <div className="flex justify-between p-3 bg-[#FAF8F5] border border-black/[0.05] rounded-none">
                  <span className="text-slate-600">SMS GATEWAY SIMULATION:</span>
                  <span className="text-[#2E4A3F] font-bold font-black">99.98% ONLINE</span>
                </div>
              </div>
            </div>

            <div className="p-3 bg-[#FAF8F5] border border-black/5 text-[10.5px] text-slate-650 flex items-start space-x-2">
              <AlertTriangle className="w-4 h-4 text-[#9E6F40] flex-shrink-0 mt-0.5" />
              <span className="leading-relaxed font-serif text-slate-600">We are routing live surveys from Kuppam, Mangalagiri and Pulivendula fields. Dual-key volunteer authorization checks remain active.</span>
            </div>
          </div>

        </div>
      )}

      {/* CSV Exporter block */}
      {activeTab === "export" && (
        <div className="bg-white p-8 border border-black/10 text-center max-w-xl mx-auto space-y-4">
          <div className="w-12 h-12 bg-black text-[#F9F7F2] rounded-full flex items-center justify-center mx-auto text-xl animate-pulse">
            <FileLock className="w-6 h-6" />
          </div>

          <div>
            <h4 className="text-xl font-serif italic text-black font-bold">Export Compiled Survey datasets</h4>
            <p className="text-xs text-slate-600 mt-2 max-w-md mx-auto leading-relaxed">
              Compile and extract anonymized state microdata parameters for academic analysis or regional model study. Includes exact demographic distributions.
            </p>
          </div>

          {successExport ? (
            <div className="bg-[#FAF8F5] text-slate-800 text-xs py-3 px-5 border border-black/10 font-mono inline-block">
              ✓ "people_pulse_ap_export_6_2026.csv" (52,180 records) downloaded successfully. (Simulation completed)
            </div>
          ) : (
            <button
              onClick={handleExport}
              className="bg-black hover:bg-slate-900 text-white font-sans font-black uppercase text-[10px] tracking-widest py-3 px-6 transition inline-flex items-center space-x-2"
            >
              <FileDown className="w-4 h-4" />
              <span>Compile & Download CSV Block</span>
            </button>
          )}

          <p className="text-[9.5px] text-slate-500 font-sans tracking-wide block pt-2 uppercase">
            This action is fully tracked under authorization registry credentials.
          </p>
        </div>
      )}

      {/* Global OTP Gateway Sub-Tab View (Super Admin only can configure these) */}
      {activeTab === "otpConfig" && currentUserRole === UserRole.SuperAdmin && (
        <div className="space-y-6 animate-fade-in">
          <div className="bg-[#FAF8F5] border border-black/15 p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="space-y-1">
              <span className="text-[8px] bg-[#A01D24] text-white font-sans font-bold px-2 py-0.5 tracking-wider uppercase">System Security Clearance Restricted</span>
              <h4 className="text-sm font-sans font-black uppercase tracking-wider text-black mt-1">
                Global Secure OTP Gateway Configurations
              </h4>
              <p className="text-xs text-slate-600 font-serif leading-relaxed max-w-2xl">
                Configure, save, and dynamically activate global email delivery services. These fields reflect back to the active observer login system in real-time, completely overriding default simulation limits.
              </p>
            </div>
            <div>
              <button
                type="button"
                onClick={fetchConfig}
                disabled={loadingConfig}
                className="px-3.5 py-2 bg-white hover:bg-slate-50 text-black border border-black/20 font-sans font-bold text-[9px] uppercase tracking-wider disabled:opacity-50 flex items-center justify-center space-x-1.5 transition cursor-pointer"
              >
                {loadingConfig ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>Syncing...</span>
                  </>
                ) : (
                  <>
                    <span>Sync Environment ↻</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {configSuccess && (
            <div className="bg-[#2E4A3F] text-[#FAF8F5] p-3 text-xs font-mono border-l-4 border-emerald-500 rounded-none leading-relaxed">
              ✓ {configSuccess}
            </div>
          )}

          {configError && (
            <div className="bg-rose-50 text-rose-900 p-3 text-xs font-mono border border-rose-500/20 rounded-none leading-relaxed">
              ⚠ {configError}
            </div>
          )}

          {/* Google SMTP Setup Guidance Panel */}
          <div className="bg-amber-50 border border-amber-500/20 p-4 font-sans space-y-2">
            <div className="flex items-center space-x-2 text-amber-950 font-bold text-xs uppercase tracking-wide">
              <span>💡</span>
              <span>Google Mail SMTP Setup Instructions</span>
            </div>
            <p className="text-[11px] text-amber-900 font-serif leading-relaxed">
              To send real-time codes successfully using Google SMTP, satisfy these secure requirements:
            </p>
            <ul className="list-disc list-inside text-[10.5px] text-amber-950 font-serif space-y-1 pl-1">
              <li>
                <strong>SMTP Server Host:</strong> <code className="bg-amber-100 px-1 font-mono text-[10px]">smtp.gmail.com</code>
              </li>
              <li>
                <strong>SMTP Active Port:</strong> <code className="bg-amber-100 px-1 font-mono text-[10px]">587</code>
              </li>
              <li>
                <strong>Secure TLS Layer Option:</strong> Select <strong className="font-semibold text-amber-900">"No / STARTTLS Mode"</strong> (STARTTLS is the standard secure protocol for Port 587; Direct SSL is only for Port 465).
              </li>
              <li>
                <strong>SMTP Username / Email:</strong> Your complete Gmail account address (e.g. <span className="font-mono bg-amber-100 px-1 text-[10px]">subbanaiduk@gmail.com</span>).
              </li>
              <li>
                <strong>SMTP Password:</strong> You <strong className="text-amber-900">MUST</strong> use a 16-character <strong className="text-[#A01D24]">Google App Password</strong>. Google blocks standard login passwords for security. Generate one via your Google Account Settings &gt; <em>Security</em> &gt; <em>2-Step Verification</em> &gt; <em>App Passwords</em> (at the bottom).
              </li>
            </ul>
          </div>

          <form onSubmit={handleSaveConfig} className="grid grid-cols-1 lg:grid-cols-12 gap-6 text-xs font-serif">
            {/* Left Hand Column: SMTP configuration */}
            <div className="lg:col-span-7 bg-white border border-black/15 p-6 space-y-4">
              <div className="flex items-center space-x-2 border-b border-black/10 pb-2.5 mb-2">
                <Server className="w-4 h-4 text-black flex-shrink-0" />
                <span className="font-sans font-black uppercase text-[10px] tracking-wider text-black">A: Dedicated SMTP Host Server (Universal Routing)</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[9px] font-sans uppercase tracking-widest text-slate-500 font-black mb-1.5">
                    SMTP Server Host (IP or Name)
                  </label>
                  <input
                    type="text"
                    required={!!config.SMTP_USER}
                    placeholder="e.g. smtp.gmail.com, mail.smtp2go.com"
                    value={config.SMTP_HOST}
                    onChange={(e) => setConfig({ ...config, SMTP_HOST: e.target.value })}
                    className="w-full bg-[#FAF8F5] border border-black/15 focus:border-[#A01D24] p-2.5 focus:outline-none text-xs font-mono rounded-none text-black transition"
                  />
                </div>

                <div>
                  <label className="block text-[9px] font-sans uppercase tracking-widest text-slate-500 font-black mb-1.5">
                    SMTP Active Port
                  </label>
                  <input
                    type="text"
                    required={!!config.SMTP_HOST}
                    placeholder="e.g. 587 (TLS/STARTTLS) or 465 (SSL)"
                    value={config.SMTP_PORT}
                    onChange={(e) => setConfig({ ...config, SMTP_PORT: e.target.value })}
                    className="w-full bg-[#FAF8F5] border border-black/15 focus:border-[#A01D24] p-2.5 focus:outline-none text-xs font-mono rounded-none text-black transition"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[9px] font-sans uppercase tracking-widest text-slate-500 font-black mb-1.5">
                    SMTP Username / Email
                  </label>
                  <input
                    type="text"
                    required={!!config.SMTP_HOST}
                    placeholder="username/email credentials"
                    value={config.SMTP_USER}
                    onChange={(e) => setConfig({ ...config, SMTP_USER: e.target.value })}
                    className="w-full bg-[#FAF8F5] border border-black/15 focus:border-[#A01D24] p-2.5 focus:outline-none text-xs font-mono rounded-none text-black transition"
                  />
                </div>

                <div>
                  <label className="block text-[9px] font-sans uppercase tracking-widest text-slate-500 font-black mb-1.5">
                    SMTP Passwords / App Token
                  </label>
                  <div className="relative">
                    <input
                      type={showSmtpPass ? "text" : "password"}
                      required={!!config.SMTP_HOST}
                      placeholder="App-specific mail passcode"
                      value={config.SMTP_PASS}
                      onChange={(e) => setConfig({ ...config, SMTP_PASS: e.target.value })}
                      className="w-full bg-[#FAF8F5] border border-black/15 focus:border-[#A01D24] p-2.5 pr-10 focus:outline-none text-xs font-mono rounded-none text-black transition"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSmtpPass(!showSmtpPass)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-black focus:outline-none cursor-pointer"
                    >
                      {showSmtpPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[9px] font-sans uppercase tracking-widest text-slate-500 font-black mb-1.5">
                    Sender Headers display (From)
                  </label>
                  <input
                    type="text"
                    placeholder='"People Pulse Andhra Pradesh" <otp@yourdomain.com>'
                    value={config.SMTP_FROM}
                    onChange={(e) => setConfig({ ...config, SMTP_FROM: e.target.value })}
                    className="w-full bg-[#FAF8F5] border border-black/15 focus:border-[#A01D24] p-2.5 focus:outline-none text-xs font-mono rounded-none text-black transition"
                  />
                  <span className="text-[9.5px] text-slate-400 mt-1.5 block">Configuring matched details ensures emails bypass security spam gates.</span>
                </div>

                <div>
                  <label className="block text-[9px] font-sans uppercase tracking-widest text-slate-500 font-black mb-1.5">
                    Secure TLS Layer Option
                  </label>
                  <select
                    value={config.SMTP_SECURE}
                    onChange={(e) => setConfig({ ...config, SMTP_SECURE: e.target.value })}
                    className="w-full bg-[#FAF8F5] border border-black/15 focus:border-[#A01D24] p-2.5 focus:outline-none text-xs font-mono rounded-none text-black transition cursor-pointer"
                  >
                    <option value="false">No / STARTTLS Mode (Recommended for Port 587)</option>
                    <option value="true">Yes / Direct SSL Mode (Recommended for Port 465)</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Right Hand Column: API & Controls */}
            <div className="lg:col-span-5 space-y-4">
              <div className="bg-white border border-black/15 p-6 space-y-4">
                <div className="flex items-center space-x-2 border-b border-black/10 pb-2.5 mb-2">
                  <Database className="w-4 h-4 text-black flex-shrink-0" />
                  <span className="font-sans font-black uppercase text-[10px] tracking-wider text-black">B: Web3Forms API Integration</span>
                </div>

                <div className="border border-amber-800/10 bg-amber-50/20 p-2.5 text-[10.5px] leading-relaxed text-amber-900 font-sans space-y-0.5">
                  <strong className="font-black">💡 Deployment Guide</strong>
                  <p>Web3Forms access keys take immediate effect for routing OTP requests globally. Fill fields to replace localhost logs.</p>
                </div>

                <div>
                  <label className="block text-[9px] font-sans uppercase tracking-widest text-slate-500 font-black mb-1.5">
                    Web3Forms Free Access Key
                  </label>
                  <input
                    type="text"
                    placeholder="Static HTML dispatch token"
                    value={config.WEB3FORMS_ACCESS_KEY}
                    onChange={(e) => setConfig({ ...config, WEB3FORMS_ACCESS_KEY: e.target.value })}
                    className="w-full bg-[#FAF8F5] border border-black/15 focus:border-[#A01D24] p-2.5 focus:outline-none text-xs font-mono rounded-none text-black transition"
                  />
                  <span className="text-[9.5px] font-serif text-slate-400 mt-1 block">Web3Forms is an awesome tool for fast client prototyping that forwards OTP codes instantly.</span>
                </div>
              </div>

              <div className="bg-white border border-black/15 p-4">
                <button
                  type="submit"
                  disabled={savingConfig}
                  className="w-full bg-black hover:bg-neutral-900 disabled:bg-neutral-500 text-white font-sans text-[10px] tracking-widest uppercase font-black py-4 transition flex items-center justify-center space-x-2 cursor-pointer"
                >
                  {savingConfig ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Saving Parameters...</span>
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4" />
                      <span>Activate & Save Configurations</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </form>

          {/* Diagnostic Console */}
          <div className="bg-white border border-black/15 p-6 font-serif">
            <div className="flex items-center space-x-2 border-b border-black/10 pb-2.5 mb-4">
              <Mail className="w-5 h-5 text-black flex-shrink-0" />
              <h4 className="font-sans font-black text-[11px] uppercase tracking-wider text-black">
                Diagnostic Gateway Validation Testing
              </h4>
            </div>

            <p className="text-xs text-slate-650 max-w-xl leading-relaxed mb-4 text-justify">
              Input your email address to fire off a secure validation payload. This simulates the actual OTP observer clearance routing so you can confirm SMTP, Resend, or Web3Forms delivery.
            </p>

            {testSuccess && (
              <div className="bg-[#2E4A3F] text-white p-3.5 text-xs font-mono mb-4 border-l-4 border-emerald-500 leading-relaxed">
                🎉 {testSuccess}
              </div>
            )}

            {testError && (
              <div className="bg-rose-50 text-rose-950 p-3.5 text-xs font-mono mb-4 border border-rose-500/25 leading-relaxed">
                ⚠ Transmission Warning: {testError}
              </div>
            )}

            <form onSubmit={handleSendTestOtp} className="grid grid-cols-1 sm:grid-cols-12 gap-3 max-w-2xl text-xs">
              <div className="sm:col-span-8">
                <input
                  type="email"
                  required
                  placeholder="name@example.com"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  className="w-full bg-[#FAF8F5] border border-black/15 focus:border-[#A01D24] p-3 focus:outline-none text-xs rounded-none text-[#121212]"
                />
              </div>
              <div className="sm:col-span-4">
                <button
                  type="submit"
                  disabled={testingDelivery || !testEmail}
                  className="w-full h-full bg-black hover:bg-neutral-900 disabled:bg-neutral-300 text-white font-sans text-[10px] tracking-widest uppercase font-black py-3.5 px-4 transition flex items-center justify-center space-x-2 cursor-pointer"
                >
                  {testingDelivery ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Dispatching Mail...</span>
                    </>
                  ) : (
                    <span>Send Diagnostic PIN</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
