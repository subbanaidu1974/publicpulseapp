/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, FormEvent, useEffect, useMemo } from "react";
import { Vote, CheckCircle2, ChevronLeft, ChevronRight, ShieldCheck, Landmark, AlertCircle, HelpCircle } from "lucide-react";
import { SurveyResponse, SurveyCategory } from "../types";
import { DISTRICTS, CONSTITUENCIES, LEADERS, PARTIES } from "../data/staticData";

interface SurveyFormProps {
  onSubmitResponse: (response: SurveyResponse) => void;
  selectedDistrictId: string;
  onSelectDistrict: (id: string) => void;
}

// Custom CSS-rendered party flags helper
function PartyFlag({ code, size = "md" }: { code: string; size?: "sm" | "md" | "lg" }) {
  const sizeClasses = {
    sm: "w-10 h-6 text-[8px]",
    md: "w-24 h-14 text-[10px]",
    lg: "w-36 h-22 text-[12px]"
  };

  const containerStyle = "relative overflow-hidden shadow-sm border border-black/15 rounded-none flex flex-col justify-between select-none shrink-0";

  if (code === "TDP") {
    return (
      <div className={`${containerStyle} ${sizeClasses[size]} bg-[#FFD700] p-1`}>
        {/* Yellow flag with a green stripe at the bottom */}
        <div className="absolute inset-x-0 bottom-0 h-1/5 bg-[#008000]"></div>
        {/* Simplified bicycle wheel or emblem */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-5 h-5 rounded-full border border-dashed border-red-650 flex items-center justify-center">
            <div className="w-1 h-1 rounded-full bg-red-650"></div>
          </div>
        </div>
      </div>
    );
  }

  if (code === "YSRCP") {
    return (
      <div className={`${containerStyle} ${sizeClasses[size]} flex flex-row`}>
        <div className="w-1/3 h-full bg-[#1A365D]"></div>
        <div className="w-1/3 h-full bg-[#FFFFFF] flex items-center justify-center relative">
          <div className="w-4 h-4 rounded-full bg-[#D4AF37] border border-blue-900 flex items-center justify-center text-[5px] font-sans text-blue-950 font-bold shadow-xs">
            YSR
          </div>
        </div>
        <div className="w-1/3 h-full bg-[#2E7D32]"></div>
      </div>
    );
  }

  if (code === "JSP") {
    return (
      <div className={`${containerStyle} ${sizeClasses[size]} bg-[#C62828] p-1 flex items-center justify-center`}>
        <div className="w-6 h-6 rounded-full bg-[#FFFFFF] flex items-center justify-center relative shadow-sm">
          {/* Red Star */}
          <span className="text-red-600 font-sans font-black text-xs leading-none">&#9733;</span>
        </div>
      </div>
    );
  }

  if (code === "INC") {
    return (
      <div className={`${containerStyle} ${sizeClasses[size]} flex flex-col`}>
        <div className="h-1/3 bg-[#FF9933]"></div>
        <div className="h-1/3 bg-[#FFFFFF] flex items-center justify-center relative">
          <span className="text-[#000080] font-sans font-bold leading-none select-none text-[8px]">&#9995;</span>
        </div>
        <div className="h-1/3 bg-[#138808]"></div>
      </div>
    );
  }

  if (code === "BJP") {
    return (
      <div className={`${containerStyle} ${sizeClasses[size]} flex flex-row`}>
        <div className="w-2/3 h-full bg-[#FF9933]"></div>
        <div className="w-1/3 h-full bg-[#138808] flex items-center justify-center relative">
          <span className="text-pink-650 text-[10px] absolute select-none">&#127800;</span>
        </div>
      </div>
    );
  }

  // OTH
  return (
    <div className={`${containerStyle} ${sizeClasses[size]} bg-gradient-to-br from-slate-200 to-slate-400 p-1 flex items-center justify-center`}>
      <span className="text-slate-800 font-mono font-bold text-[8px] tracking-widest uppercase">OTH</span>
    </div>
  );
}

export default function SurveyForm({ onSubmitResponse, selectedDistrictId, onSelectDistrict }: SurveyFormProps) {
  // Survey responses form states
  const [districtId, setDistrictId] = useState<string>(selectedDistrictId || "AP-12");
  const [constituencyId, setConstituencyId] = useState<string>("AC-091"); // default Mangalagiri
  const [ageGroup, setAgeGroup] = useState<string>("26-35");
  const [gender, setGender] = useState<string>("Male");
  const [occupation, setOccupation] = useState<string>("Agriculture");
  const [primaryIssue, setPrimaryIssue] = useState<string>("Drinking Water Grid");
  const [favLeader, setFavLeader] = useState<string>(LEADERS[0]);
  const [votePreference, setVotePreference] = useState<string>("TDP");
  const [govtRating, setGovtRating] = useState<number>(4);
  const [mlaRating, setMlaRating] = useState<number>(3);
  const [customFeedback, setCustomFeedback] = useState<string>("");
  
  // Separation Workflow states
  const [hasCastBallot, setHasCastBallot] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"demographics" | "ratings" | "verification">("demographics");

  // Scoring for all 12 requested categories
  const [categoryScores, setCategoryScores] = useState<Record<string, number>>(
    Object.values(SurveyCategory).reduce((acc, cat) => ({ ...acc, [cat]: 3 }), {})
  );

  const [submitted, setSubmitted] = useState<boolean>(false);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [verificationCodes, setVerificationCodes] = useState<string>("");
  const [needsOtp, setNeedsOtp] = useState<boolean>(false);
  const [phone, setPhone] = useState<string>("");
  const [mobileError, setMobileError] = useState<string>("");

  const [constituencySearch, setConstituencySearch] = useState<string>("");
  const [sessionSubmissions, setSessionSubmissions] = useState<SurveyResponse[]>([]);

  const filteredConstituencies = CONSTITUENCIES.filter(
    ac => ac.districtId === districtId &&
    (ac.name.toLowerCase().includes(constituencySearch.toLowerCase()) || ac.id.toLowerCase().includes(constituencySearch.toLowerCase()))
  );

  useEffect(() => {
    const matching = CONSTITUENCIES.filter(
      ac => ac.districtId === districtId &&
      (ac.name.toLowerCase().includes(constituencySearch.toLowerCase()) || ac.id.toLowerCase().includes(constituencySearch.toLowerCase()))
    );
    if (matching.length > 0) {
      if (!matching.some(ac => ac.id === constituencyId)) {
        setConstituencyId(matching[0].id);
      }
    }
  }, [districtId, constituencySearch, constituencyId]);

  // Handle category ratings
  const handleCategoryRatingChange = (category: string, value: number) => {
    setCategoryScores(prev => ({
      ...prev,
      [category]: value
    }));
  };

  const currentDist = DISTRICTS.find(d => d.id === districtId);

  const requestOTP = (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!phone || phone.length < 10) {
      setMobileError("Please enter a valid 10-digit mobile number for secure validation.");
      return;
    }
    setMobileError("");
    setIsVerifying(true);
    setTimeout(() => {
      setIsVerifying(false);
      setNeedsOtp(true);
    }, 1200);
  };

  const verifyAndSubmit = (e?: FormEvent) => {
    if (e) e.preventDefault();
    setIsVerifying(true);
    setTimeout(() => {
      setIsVerifying(false);
      const newResponse: SurveyResponse = {
        id: `SR-${(Math.floor(Math.random() * 50000) + 12000).toString()}`,
        timestamp: new Date().toISOString().slice(0, 16).replace("T", " "),
        districtId,
        constituencyId,
        ageGroup,
        gender,
        occupation,
        primaryIssue,
        govtRating,
        mlaRating,
        favLeader,
        votePreference,
        customFeedback: customFeedback || "Everything is satisfactory, direct benefit transfer payouts are smooth. We need stronger municipal roads.",
        status: "Approved",
        verifiedByVolunteer: "OTP Verified Self-Submission",
        categoryScores
      };

      onSubmitResponse(newResponse);
      setSessionSubmissions(prev => [newResponse, ...prev]);
      setSubmitted(true);
    }, 1500);
  };

  const handleReset = () => {
    setSubmitted(false);
    setNeedsOtp(false);
    setPhone("");
    setVerificationCodes("");
    setCustomFeedback("");
    setHasCastBallot(false);
    setActiveTab("demographics");
  };

  const renderSessionLedger = () => {
    return (
      <div className="mt-12 bg-white border border-black/15 p-6 sm:p-8">
        <div className="border-b border-black/10 pb-3 mb-6 flex justify-between items-center">
          <div>
            <span className="text-[9px] text-slate-550 font-sans font-black uppercase tracking-widest">PERSONAL TELEMETRY LOG</span>
            <h3 className="text-lg font-serif italic text-black">Your Session Submissions</h3>
          </div>
          <span className="text-[10px] font-mono bg-black text-white px-2 py-0.5 font-bold uppercase">
            Active: {sessionSubmissions.length} Registered
          </span>
        </div>

        {sessionSubmissions.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center text-center space-y-4">
            <svg className="w-16 h-16 text-slate-300 mx-auto" stroke="currentColor" fill="none" viewBox="0 0 24 24">
              <path strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              <circle cx="12" cy="12" r="7" strokeDasharray="1.5 1.5" strokeWidth="0.8" className="text-red-750" />
            </svg>
            <div>
              <h4 className="text-xs font-sans font-black uppercase tracking-wider text-black">No Dynamic Session Submissions Recorded</h4>
              <p className="text-slate-500 text-[11px] mt-1.5 max-w-sm mx-auto font-serif leading-relaxed">
                You have not committed any direct digital surveys or telemetry opinions during this browser session. Populate the registration form above to authorize an entry.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {sessionSubmissions.map((sub, idx) => (
              <div key={idx} className="bg-[#FAF8F5] p-4 border border-black/10 font-sans text-xs space-y-2 relative overflow-hidden">
                <div className="flex justify-between font-mono text-[9px] text-slate-500">
                  <span>ID: {sub.id}</span>
                  <span>{sub.timestamp}</span>
                </div>
                <div className="flex justify-between font-serif italic text-sm text-black">
                  <span>{sub.votePreference} Preference</span>
                  <span>{sub.ageGroup} / {sub.gender}</span>
                </div>
                <div className="text-[11px] text-slate-700 font-serif border-t border-black/5 pt-2 italic">
                  "{sub.customFeedback}"
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  if (submitted) {
    return (
      <div className="space-y-12 max-w-4xl mx-auto">
        <div id="survey-success-card" className="max-w-xl mx-auto bg-white p-8 border border-black/15 text-center space-y-6 font-serif">
          <div className="w-16 h-16 bg-black text-[#F9F7F2] rounded-full flex items-center justify-center mx-auto text-2xl">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          
          <div>
            <h2 className="text-2xl font-serif italic text-black">Your Survey Response has been logged</h2>
            <p className="text-slate-600 text-xs mt-2 max-w-lg mx-auto leading-relaxed">
              Thank you for participating in the ongoing public assessment index. Your telemetry weights are active and factored into the live dashboard below.
            </p>
          </div>

          <div className="bg-[#FAF8F5] p-5 border border-black/10 text-xs text-left grid grid-cols-2 gap-4 max-w-md mx-auto font-sans">
            <div>
              <span className="text-slate-500 text-[9px] font-bold uppercase tracking-wider block">Verified District</span>
              <div className="text-black font-serif italic text-sm mt-0.5">{currentDist?.name}</div>
            </div>
            <div>
              <span className="text-slate-500 text-[9px] font-bold uppercase tracking-wider block">Record ID</span>
              <div className="text-black font-mono font-bold mt-0.5">PULSE-REG-{Math.floor(Math.random() * 90000) + 10000}</div>
            </div>
            <div>
              <span className="text-slate-500 text-[9px] font-bold uppercase tracking-wider block">Timestamp</span>
              <div className="text-slate-700 font-mono mt-0.5">Andhra UTC-Live</div>
            </div>
            <div>
              <span className="text-slate-500 text-[9px] font-bold uppercase tracking-wider block">Vote Align</span>
              <div className="text-black font-semibold mt-0.5 font-serif italic">{votePreference} Target</div>
            </div>
          </div>

          <div className="pt-2">
            <button
              onClick={handleReset}
              className="bg-[#121212] hover:bg-black text-[#FAF8F5] py-2 px-6 text-xs font-sans tracking-widest font-black uppercase cursor-pointer"
            >
              Submit Another State Opinion
            </button>
          </div>
        </div>
        {renderSessionLedger()}
      </div>
    );
  }

  // TABS configurations for the secondary flow
  const registryTabs = [
    { id: "demographics", label: "1. Territory & Profile", icon: "👥" },
    { id: "ratings", label: "2. Sector Ratings & Issues", icon: "📊" },
    { id: "verification", label: "3. Dual-Factor Gate", icon: "🔒" },
  ] as const;

  const activePartyDetails = PARTIES.find(p => p.code === votePreference);

  return (
    <div className="max-w-4xl mx-auto font-serif">
      
      {/* 1. INDIVIDUAL BALLOT PAGE */}
      {!hasCastBallot ? (
        <div className="bg-white border border-black/15 p-6 sm:p-10 space-y-8">
          <div className="text-center space-y-2 border-b border-black/10 pb-6">
            <span className="text-[10px] text-[#2F528F] font-sans font-black uppercase tracking-[0.25em] flex items-center justify-center space-x-1.5">
              <Vote className="w-4 h-4" />
              <span>OFFICIAL DIGITAL BALLOT BOX</span>
            </span>
            <h2 className="text-3xl font-serif italic text-black">Cast Your Ballot Preference</h2>
            <p className="text-slate-600 text-xs max-w-lg mx-auto leading-relaxed">
              Select one political party from the official pool registered in the Andhra Pradesh public index. Your selection will lock as the voting preference for your survey profile.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {PARTIES.map((party) => {
              const isSelected = votePreference === party.code;
              return (
                <button
                  type="button"
                  key={party.code}
                  onClick={() => setVotePreference(party.code)}
                  className={`group relative p-5 bg-white border text-left flex flex-col justify-between h-44 transition duration-200 cursor-pointer ${
                    isSelected 
                      ? `border-2 ${party.border} ring-2 ${party.border}/10 bg-[#FAF8F5]` 
                      : 'border-black/15 hover:border-black/40 hover:bg-slate-50'
                  }`}
                >
                  {/* Flag and selection indicator */}
                  <div className="flex justify-between items-start w-full">
                    <PartyFlag code={party.code} size="md" />
                    <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-all ${
                      isSelected 
                        ? `${party.color} text-white border-transparent` 
                        : 'border-black/15 bg-white group-hover:border-black/30'
                    }`}>
                      {isSelected && <span className="text-[9px] font-black font-sans">&#10003;</span>}
                    </div>
                  </div>

                  {/* Party text info */}
                  <div className="mt-4">
                    <span className="text-[9px] text-slate-400 font-mono block font-black">{party.code}</span>
                    <span className="text-xs font-serif font-bold text-black block leading-tight mt-0.5">{party.name}</span>
                    <span className="text-[10px] text-slate-500 font-serif italic block mt-1">
                      Leader: {party.code === "TDP" ? "Nara Chandrababu Naidu" : 
                              party.code === "YSRCP" ? "Y.S. Jagan Mohan Reddy" : 
                              party.code === "JSP" ? "Pawan Kalyan" : 
                              party.code === "BJP" ? "State Leadership" :
                              party.code === "INC" ? "Y.S. Sharmila" : "State Representative"}
                    </span>
                  </div>

                  {isSelected && (
                    <div className={`absolute bottom-2 right-2 text-[8px] font-sans font-black uppercase tracking-wider px-1.5 py-0.5 rounded-none ${party.color} text-white shadow-xs`}>
                      Selected
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="bg-[#FAF8F5] border border-black/10 p-5 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="flex items-start space-x-3 text-left">
              <span className="text-xl shrink-0 mt-0.5">🗳️</span>
              <div className="text-xs font-serif leading-relaxed text-slate-700">
                <span className="font-bold text-black block">Active Ballot Status:</span>
                You have designated your digital preference to <strong className="text-black">
                  {activePartyDetails?.name} ({votePreference})
                </strong>. Lock this vote to unlock the rest of your analytical profile telemetry.
              </div>
            </div>

            <button
              type="button"
              onClick={() => setHasCastBallot(true)}
              className="w-full sm:w-auto shrink-0 bg-black hover:bg-slate-900 text-[#FAF8F5] text-xs font-sans font-black uppercase tracking-widest py-3 px-8 rounded-none flex items-center justify-center space-x-2 cursor-pointer transition"
            >
              <span>Lock Vote & Proceed</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        /* 2. PROFILE & DETAILS REGISTRY FLOW */
        <div className="space-y-6 animate-fadeIn">
          
          {/* Active Locked Vote Summary Banner */}
          <div className="bg-[#FAF8F5] border border-black/15 p-4 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="flex items-center space-x-4">
              <span className="text-[10px] text-slate-500 font-sans font-bold uppercase tracking-widest block">LOCKED BALLOT</span>
              <div className="flex items-center space-x-2">
                <PartyFlag code={votePreference} size="sm" />
                <span className="text-xs font-serif font-bold text-black">
                  {activePartyDetails?.name} ({votePreference})
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setHasCastBallot(false);
              }}
              className="text-[10px] font-sans font-bold uppercase tracking-widest text-red-750 hover:underline cursor-pointer flex items-center space-x-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Change Ballot</span>
            </button>
          </div>

          {/* Tab Navigation header */}
          <div className="grid grid-cols-3 gap-1.5 mb-2 font-sans text-xs">
            {registryTabs.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  type="button"
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`py-3 px-2 border transition text-center flex items-center justify-center space-x-1.5 cursor-pointer uppercase tracking-tight font-bold ${
                    isActive 
                      ? "bg-black text-white border-black" 
                      : "bg-white text-slate-500 border-black/10 hover:bg-slate-50 hover:text-black"
                  }`}
                >
                  <span>{tab.icon}</span>
                  <span className="truncate">{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Main Form content columns */}
          <div className="bg-white border border-black/15 p-6 sm:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
            
            {/* Left instructions bar (span 4) */}
            <div className="lg:col-span-4 space-y-6 lg:border-r lg:border-black/10 lg:pr-6 font-serif">
              <div className="bg-[#FAF8F5] p-5 border border-black/10">
                <span className="text-[9px] text-slate-550 font-sans font-black uppercase tracking-widest mb-3 block">Methodology Principles</span>
                <ul className="text-xs text-slate-700 space-y-3.5 list-none">
                  <li className="relative pl-4"><span className="absolute left-0 top-1 text-[8px]">&bull;</span> Limit of <strong className="text-black">one active entry</strong> per quarter per handset.</li>
                  <li className="relative pl-4"><span className="absolute left-0 top-1 text-[8px]">&bull;</span> Dual validation uses active verification loop simulation to avoid bot clusters.</li>
                  <li className="relative pl-4"><span className="absolute left-0 top-1 text-[8px]">&bull;</span> Responses are permanently stripped of personal identification trackers.</li>
                  <li className="relative pl-4"><span className="absolute left-0 top-1 text-[8px]">&bull;</span> Instantly computes local weights across target mandals upon successful submit actions.</li>
                </ul>
              </div>

              <div className="border-l-2 border-[#D99B26] pl-4 py-1.5 text-xs text-slate-650 bg-[#FAF8F5]">
                <span className="text-black font-sans font-black uppercase text-[8px] tracking-wider block mb-1">Telemetry Active</span>
                <p className="font-serif leading-relaxed">
                  Our index pipeline parses write-in grievances instantly to map infrastructure complaints directly to target constituencies.
                </p>
              </div>
            </div>

            {/* Right Tab Content Block (span 8) */}
            <div className="lg:col-span-8">
              
              {/* SUB-FLOW TAB 1: REGION & DEMOGRAPHICS */}
              {activeTab === "demographics" && (
                <div className="space-y-6">
                  <div className="bg-[#FAF8F5] p-5 border border-black/10 space-y-4">
                    <span className="text-[10px] text-slate-550 uppercase tracking-widest font-sans font-black block">1. Territorial & Demographics Profile</span>
                    <p className="text-xs text-slate-600 font-serif leading-relaxed">
                      Specify your region, constituency, and census details. This maps your survey input to the correct voter segment and spatial coordinates.
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[10px] text-slate-500 uppercase font-sans font-bold mb-1">Primary District</label>
                        <select
                          value={districtId}
                          onChange={(e) => {
                            setDistrictId(e.target.value);
                            onSelectDistrict(e.target.value);
                          }}
                          className="w-full bg-white border border-black/20 text-xs text-black p-2.5 rounded-none focus:outline-none focus:border-black font-sans"
                        >
                          {DISTRICTS.map((d) => (
                            <option key={d.id} value={d.id}>{d.name} ({d.region})</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-500 uppercase font-sans font-bold mb-1">Assembly Constituency</label>
                        <div className="space-y-2">
                          <input
                            type="text"
                            placeholder="Filter assembly seats..."
                            value={constituencySearch}
                            onChange={(e) => setConstituencySearch(e.target.value)}
                            className="w-full bg-white border border-black/20 text-xs text-black p-2.5 focus:outline-none focus:border-black font-sans"
                          />
                          {filteredConstituencies.length > 0 ? (
                            <select
                              value={constituencyId}
                              onChange={(e) => setConstituencyId(e.target.value)}
                              className="w-full bg-white border border-black/20 text-xs text-black p-2.5 rounded-none focus:outline-none focus:border-black font-sans"
                            >
                              {filteredConstituencies.map((ac) => (
                                <option key={ac.id} value={ac.id}>{ac.name} ({ac.id})</option>
                              ))}
                            </select>
                          ) : (
                            <div className="border border-black/10 bg-white p-4 text-center space-y-2">
                              <div className="space-y-0.5">
                                <span className="font-sans font-black uppercase tracking-wider text-[8px] text-black block">No Assembly Seats Found</span>
                                <button
                                  type="button"
                                  onClick={() => setConstituencySearch("")}
                                  className="text-[8px] font-sans font-bold uppercase tracking-widest text-red-750 hover:underline pt-1 cursor-pointer block mx-auto font-black"
                                >
                                  Reset Search
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                      <div>
                        <label className="block text-[10px] text-slate-500 uppercase font-sans font-bold mb-1">Age Segment</label>
                        <select
                          value={ageGroup}
                          onChange={(e) => setAgeGroup(e.target.value)}
                          className="w-full bg-white border border-black/20 text-xs text-black p-2.5 rounded-none focus:outline-none font-sans"
                        >
                          <option value="18-25">18-25 (First-Timer)</option>
                          <option value="26-35">26-35 (Professional)</option>
                          <option value="36-50">36-50 (Household Lead)</option>
                          <option value="50+">50+ (Presidium Senior)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-500 uppercase font-sans font-bold mb-1">Gender Identifier</label>
                        <select
                          value={gender}
                          onChange={(e) => setGender(e.target.value)}
                          className="w-full bg-white border border-black/20 text-xs text-black p-2.5 rounded-none focus:outline-none font-sans"
                        >
                          <option value="Male">Male</option>
                          <option value="Female">Female</option>
                          <option value="Others">Others</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-500 uppercase font-sans font-bold mb-1">Sector Livelihood</label>
                        <select
                          value={occupation}
                          onChange={(e) => setOccupation(e.target.value)}
                          className="w-full bg-white border border-black/20 text-xs text-black p-2.5 rounded-none focus:outline-none font-sans"
                        >
                          <option value="Agriculture">Agriculture & Allied</option>
                          <option value="Business/Self-Employed">Retail Trader</option>
                          <option value="Private Job">Private Sector Employee</option>
                          <option value="Government Job">Government Employee</option>
                          <option value="Student">Student / Learner</option>
                          <option value="Homemaker">Homemaker</option>
                          <option value="Unemployed">Other / Unemployed</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Navigation buttons */}
                  <div className="flex justify-between pt-2">
                    <button
                      type="button"
                      onClick={() => setHasCastBallot(false)}
                      className="border border-black hover:bg-slate-50 text-black text-xs font-sans font-bold uppercase tracking-widest py-3 px-5 rounded-none flex items-center space-x-1 cursor-pointer transition"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      <span>Back to Ballot Page</span>
                    </button>
                    
                    <button
                      type="button"
                      onClick={() => setActiveTab("ratings")}
                      className="bg-black hover:bg-slate-900 text-[#FAF8F5] text-xs font-sans font-black uppercase tracking-widest py-3 px-6 rounded-none flex items-center space-x-1 cursor-pointer transition"
                    >
                      <span>Next: Sector Ratings & Issues</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* SUB-FLOW TAB 2: RATINGS & ISSUES */}
              {activeTab === "ratings" && (
                <div className="space-y-6">
                  {/* The Twelve Required Survey Categories */}
                  <div className="bg-[#FAF8F5] p-5 border border-black/10 space-y-4">
                    <span className="text-[10px] text-slate-550 uppercase tracking-widest font-sans font-black block">2. Broad-Sector Performance Indexes (Rating 1 to 5)</span>
                    <p className="text-xs text-slate-600 font-serif leading-relaxed mb-2">
                      Please rate governmental and governance metrics across key parameters. 1 represents highly unsatisfactory and 5 represents exemplary.
                    </p>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                      {Object.values(SurveyCategory).map((category) => (
                        <div key={category} className="flex items-center justify-between p-3 bg-white border border-black/10">
                          <span className="text-slate-800 font-bold font-serif">{category}</span>
                          <div className="flex space-x-1 font-sans">
                            {[1, 2, 3, 4, 5].map((star) => (
                              <button
                                type="button"
                                key={star}
                                onClick={() => handleCategoryRatingChange(category, star)}
                                className={`w-5 h-5 text-[10px] font-black rounded-none flex items-center justify-center transition border cursor-pointer ${
                                  categoryScores[category] >= star
                                    ? "bg-black text-[#F9F7F2] border-black"
                                    : "bg-white text-slate-400 border-black/10 hover:bg-slate-50"
                                }`}
                              >
                                {star}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Extra details & preference registers */}
                  <div className="bg-[#FAF8F5] p-5 border border-black/10 space-y-4 font-serif">
                    <span className="text-[10px] text-slate-550 uppercase tracking-widest font-sans font-black block">3. Preference Registers</span>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[10px] text-slate-500 uppercase font-sans font-bold mb-1">Local Infrastructure Demand</label>
                        <select
                          value={primaryIssue}
                          onChange={(e) => setPrimaryIssue(e.target.value)}
                          className="w-full bg-white border border-black/20 text-xs text-black p-2.5 rounded-none focus:outline-none font-sans"
                        >
                          <option value="Drinking Water Grid">Drinking Water Grid</option>
                          <option value="Youth Unemployment">Youth Local Unemployment</option>
                          <option value="Agricultural Input Costs">Agriculture Support Prices</option>
                          <option value="Road Infrastructure">Roads & Highway Extensions</option>
                          <option value="Healthcare Access">Rural PHC Healthcare Access</option>
                          <option value="Welfare Scheme Speed">Welfare Scheme Dispatch</option>
                          <option value="Women Self-Help Grants">Women Self-Help Micro Grants</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-500 uppercase font-sans font-bold mb-1">Preferred CM Candidate</label>
                        <select
                          value={favLeader}
                          onChange={(e) => setFavLeader(e.target.value)}
                          className="w-full bg-white border border-black/20 text-xs text-black p-2.5 rounded-none focus:outline-none font-sans"
                        >
                          {LEADERS.map((l) => (
                            <option key={l} value={l}>{l}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-500 uppercase font-sans font-bold mb-1">Sitting local MLA Rating</label>
                        <div className="flex items-center space-x-1 bg-white p-2 border border-black/15 text-xs font-sans">
                          {[1, 2, 3, 4, 5].map((val) => (
                            <button
                              type="button"
                              key={val}
                              onClick={() => setMlaRating(val)}
                              className={`w-6 h-6 font-black border cursor-pointer ${
                                mlaRating >= val ? "bg-black text-[#F9F7F2] border-black" : "bg-white text-slate-400 border-black/10"
                              }`}
                            >
                              {val}
                            </button>
                          ))}
                          <span className="text-[10px] font-bold text-slate-500 ml-3">({mlaRating}/5 Stars)</span>
                        </div>
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-500 uppercase font-sans font-bold mb-1">Sitting State Govt Rating</label>
                        <div className="flex items-center space-x-1 bg-white p-2 border border-black/15 text-xs font-sans">
                          {[1, 2, 3, 4, 5].map((val) => (
                            <button
                              type="button"
                              key={val}
                              onClick={() => setGovtRating(val)}
                              className={`w-6 h-6 font-black border cursor-pointer ${
                                govtRating >= val ? "bg-black text-[#F9F7F2] border-black" : "bg-white text-slate-400 border-black/10"
                              }`}
                            >
                              {val}
                            </button>
                          ))}
                          <span className="text-[10px] font-bold text-slate-500 ml-3">({govtRating}/5 Stars)</span>
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[10px] text-slate-500 uppercase font-sans font-bold mb-1">Custom grievance details on MLA (Optional)</label>
                      <textarea
                        value={customFeedback}
                        onChange={(e) => setCustomFeedback(e.target.value)}
                        placeholder="We require immediate grain silos structures for storage. Benefit disbursements are prompt but roads are extremely worn."
                        rows={3}
                        className="w-full bg-white border border-black/20 text-xs text-black p-2.5 rounded-none focus:outline-none focus:border-black font-serif italic"
                      ></textarea>
                    </div>
                  </div>

                  {/* Navigation buttons */}
                  <div className="flex justify-between pt-2">
                    <button
                      type="button"
                      onClick={() => setActiveTab("demographics")}
                      className="border border-black hover:bg-slate-50 text-black text-xs font-sans font-bold uppercase tracking-widest py-3 px-5 rounded-none flex items-center space-x-1 cursor-pointer transition"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      <span>Back to Profile</span>
                    </button>
                    
                    <button
                      type="button"
                      onClick={() => setActiveTab("verification")}
                      className="bg-black hover:bg-slate-900 text-[#FAF8F5] text-xs font-sans font-black uppercase tracking-widest py-3 px-6 rounded-none flex items-center space-x-1 cursor-pointer transition"
                    >
                      <span>Proceed to Dual-Factor Gate</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* SUB-FLOW TAB 3: SECURE VERIFICATION & OTP */}
              {activeTab === "verification" && (
                <div className="space-y-6">
                  {!needsOtp ? (
                    <div className="bg-[#FAF8F5] p-5 border-l-2 border-slate-500 space-y-4">
                      <span className="text-[10px] text-slate-550 uppercase tracking-widest font-sans font-black block">4. Safe Submission Gate (Dual-Factor verification check)</span>
                      <p className="text-xs text-slate-600 font-serif leading-relaxed">
                        Finalize your submission using a simulated dual-factor verification loop. This guarantees your vote counts accurately in the spatial registry.
                      </p>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
                        <div>
                          <label className="text-[10px] text-slate-500 uppercase font-sans font-bold block">Mobile Phone Number (India Standard)</label>
                          <input
                            type="tel"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            placeholder="e.g. 98480 33882"
                            className="w-full bg-white border border-black/20 text-xs text-black p-2.5 rounded-none focus:outline-none font-mono mt-1"
                          />
                          {mobileError && <span className="text-[10px] text-[#8C3E3E] font-bold block mt-1">{mobileError}</span>}
                        </div>

                        <div className="pt-3">
                          <button
                            type="button"
                            onClick={() => requestOTP()}
                            disabled={isVerifying}
                            className="w-full bg-black hover:bg-slate-900 disabled:bg-slate-400 text-[#FAF8F5] font-sans font-black uppercase text-[10px] tracking-widest py-3.5 px-4 rounded-none transition cursor-pointer flex items-center justify-center"
                          >
                            <span>{isVerifying ? "Sending Verification OTP..." : "Get OTP Verification Code"}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-6 text-center max-w-sm mx-auto py-8">
                      <div className="w-12 h-12 bg-black text-[#F9F7F2] rounded-full flex items-center justify-center text-xl mx-auto mb-2 font-black font-mono animate-bounce">
                        💬
                      </div>
                      <div>
                        <h3 className="text-xl font-serif italic text-black font-bold">Verify SMS OTP</h3>
                        <p className="text-xs text-slate-600 mt-2 font-serif leading-relaxed">
                          Enter the numerical sequence dispatched to phone <strong className="text-black">{phone}</strong>. Use simulation override <strong className="text-black">1234</strong> to commit.
                        </p>
                      </div>

                      <div className="space-y-3">
                        <input
                          type="text"
                          maxLength={4}
                          value={verificationCodes}
                          onChange={(e) => setVerificationCodes(e.target.value)}
                          placeholder="e.g. 1234"
                          className="bg-white border-2 border-black text-center text-2xl tracking-widest font-black text-black p-3 rounded-none focus:outline-none w-36 font-mono"
                        />

                        <div className="flex justify-center space-x-3 pt-3">
                          <button
                            type="button"
                            onClick={() => setNeedsOtp(false)}
                            className="bg-transparent hover:bg-slate-100 text-slate-500 text-xs font-sans font-bold uppercase tracking-wider py-2 px-3 cursor-pointer transition"
                          >
                            Go Back
                          </button>
                          <button
                            type="button"
                            onClick={() => verifyAndSubmit()}
                            disabled={verificationCodes.length < 4 || isVerifying}
                            className="bg-black hover:bg-slate-900 disabled:bg-slate-400 text-white text-xs font-sans font-black uppercase tracking-widest py-2 px-4 transition cursor-pointer"
                          >
                            {isVerifying ? "Verifying..." : "Confirm & Submit Poll"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Back navigation */}
                  {!needsOtp && (
                    <div className="flex justify-start pt-2">
                      <button
                        type="button"
                        onClick={() => setActiveTab("ratings")}
                        className="border border-black hover:bg-slate-50 text-black text-xs font-sans font-bold uppercase tracking-widest py-3 px-5 rounded-none flex items-center space-x-1 cursor-pointer transition"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                        <span>Back to Ratings</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

            </div>

          </div>
        </div>
      )}

      {renderSessionLedger()}
    </div>
  );
}
