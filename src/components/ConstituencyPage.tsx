/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useEffect } from "react";
import { Search, MapPin, Grid, BarChart3, FileText, CheckCircle, RotateCcw, Edit3 } from "lucide-react";
import { DISTRICTS, CONSTITUENCIES } from "../data/staticData";

interface ConstituencyPageProps {
  registeredUsersCount?: number;
  loggedPollsCount?: number;
}

export default function ConstituencyPage({ registeredUsersCount, loggedPollsCount }: ConstituencyPageProps = {}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDistrictFilter, setSelectedDistrictFilter] = useState("all");
  const [selectedACId, setSelectedACId] = useState("AC-091"); // default Mangalagiri

  const globalVotersCount = useMemo(() => {
    if (registeredUsersCount !== undefined) return registeredUsersCount;
    const saved = localStorage.getItem("registered-users-count-live-v1");
    return saved ? parseInt(saved, 10) : 0;
  }, [registeredUsersCount]);

  const globalPollsCount = useMemo(() => {
    if (loggedPollsCount !== undefined) return loggedPollsCount;
    const saved = localStorage.getItem("logged-polls-count-live-v1");
    return saved ? parseInt(saved, 10) : 0;
  }, [loggedPollsCount]);

  const [customVoters, setCustomVoters] = useState<Record<string, number>>(() => {
    const saved = localStorage.getItem("constituency-voters-override-v1");
    const parsed = saved ? JSON.parse(saved) : {};
    
    // Auto-apply saved overrides to the in-memory array on component load!
    Object.entries(parsed).forEach(([acId, val]) => {
      const target = CONSTITUENCIES.find((ac) => ac.id === acId);
      if (target) {
        target.voters = val as number;
      }
    });
    return parsed;
  });

  const [customPulseVoters, setCustomPulseVoters] = useState<Record<string, number>>(() => {
    const saved = localStorage.getItem("constituency-pulse-voters-override-live-v1");
    return saved ? JSON.parse(saved) : {};
  });

  const [isEditingVoters, setIsEditingVoters] = useState(false);
  const [editVotersValue, setEditVotersValue] = useState("");

  const [isEditingPulseVoters, setIsEditingPulseVoters] = useState(false);
  const [editPulseVotersValue, setEditPulseVotersValue] = useState("");

  const [confirmGeneralReset, setConfirmGeneralReset] = useState(false);

  // Filter constituencies
  const filteredACList = useMemo(() => {
    return CONSTITUENCIES.filter((ac) => {
      const matchesSearch = ac.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                            ac.id.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesDistrict = selectedDistrictFilter === "all" || ac.districtId === selectedDistrictFilter;
      return matchesSearch && matchesDistrict;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [searchQuery, selectedDistrictFilter]);

  // Current loaded constituency
  const acData = useMemo(() => {
    return CONSTITUENCIES.find((ac) => ac.id === selectedACId) || CONSTITUENCIES[0];
  }, [selectedACId, customVoters]);

  const currentPulseVoters = useMemo(() => {
    return customPulseVoters[acData.id] !== undefined ? customPulseVoters[acData.id] : 0;
  }, [acData.id, customPulseVoters]);

  useEffect(() => {
    setIsEditingVoters(false);
    setEditVotersValue(acData.voters.toString());
  }, [selectedACId, acData.voters]);

  useEffect(() => {
    setIsEditingPulseVoters(false);
    setEditPulseVotersValue(currentPulseVoters.toString());
  }, [selectedACId, acData.id, currentPulseVoters]);

  const handleUpdateVoters = (acId: string, count: number) => {
    const updated = { ...customVoters, [acId]: count };
    setCustomVoters(updated);
    localStorage.setItem("constituency-voters-override-v1", JSON.stringify(updated));
    
    const target = CONSTITUENCIES.find((ac) => ac.id === acId);
    if (target) {
      target.voters = count;
    }
  };

  const handleUpdatePulseVoters = (acId: string, count: number) => {
    const updated = { ...customPulseVoters, [acId]: count };
    setCustomPulseVoters(updated);
    localStorage.setItem("constituency-pulse-voters-override-live-v1", JSON.stringify(updated));
  };

  const handleResetAllToZero = () => {
    const freshOverrides: Record<string, number> = {};
    const freshPulseOverrides: Record<string, number> = {};
    CONSTITUENCIES.forEach((ac) => {
      ac.voters = 0;
      freshOverrides[ac.id] = 0;
      freshPulseOverrides[ac.id] = 0;
    });
    setCustomVoters(freshOverrides);
    setCustomPulseVoters(freshPulseOverrides);
    localStorage.setItem("constituency-voters-override-v1", JSON.stringify(freshOverrides));
    localStorage.setItem("constituency-pulse-voters-override-live-v1", JSON.stringify(freshPulseOverrides));
    
    setIsEditingVoters(false);
    setEditVotersValue("0");
    setIsEditingPulseVoters(false);
    setEditPulseVotersValue("0");
  };

  // Sitting MLA's party badge color formatting
  const getPartyBadge = (mlaString: string) => {
    if (mlaString.includes("TDP")) return "text-[#D99B26] bg-[#D99B26]/5 border-[#D99B26]/30";
    if (mlaString.includes("YSRCP")) return "text-[#2F528F] bg-[#2F528F]/5 border-[#2F528F]/30";
    if (mlaString.includes("JSP")) return "text-[#A63A3A] bg-[#A63A3A]/5 border-[#A63A3A]/30";
    return "text-slate-600 bg-slate-50 border-slate-200";
  };

  const getSwingLabelClass = (status: string) => {
    switch (status) {
      case "Safe": return "bg-[#2E4A3F] text-white";
      case "Leans": return "bg-[#3F5B73] text-white";
      case "Swing": return "bg-[#9E6F40] text-white";
      default: return "bg-[#8C3E3E] text-white";
    }
  };

  return (
    <div className="space-y-8 font-serif">
      
      {/* Title */}
      <div className="border-b border-black pb-4">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <span className="text-[9px] text-[#2F528F] font-sans font-black uppercase tracking-[0.25em] flex items-center space-x-1">
              <Grid className="w-3.5 h-3.5" />
              <span>Regional Focus</span>
            </span>
            <h2 className="text-3xl font-serif italic text-black mt-2">Constituency Profiler (175 Assembly Seats)</h2>
            <p className="text-xs text-slate-600 font-serif mt-1 max-w-2xl leading-relaxed">
              Detailed metrics for MLAs, citizen priority indexes, and sample voting statistics. Fully cataloged across Andhra Pradesh's assembly regions.
            </p>
          </div>
          
          {/* People Pulse Platform Registered Voters and Verified Polls HUD */}
          <div className="flex items-center space-x-6 bg-[#FAF8F5] px-4 py-2 border border-black/10">
            <div className="text-right animate-pulse">
              <span className="text-[8px] text-slate-500 uppercase font-sans tracking-wider block font-bold">People Pulse Registered Voters</span>
              <span className="text-sm font-sans font-black text-[#A01D24] block mt-0.5">{globalVotersCount.toLocaleString()}+</span>
            </div>
            <div className="w-[1px] h-6 bg-black/10 text-slate-400"></div>
            <div className="text-right">
              <span className="text-[8px] text-slate-500 uppercase font-sans tracking-wider block font-bold">Total Logged Polls</span>
              <span className="text-sm font-sans font-black text-black block mt-0.5">{globalPollsCount.toLocaleString()}+</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Grid: Selector left (span 4), detailed profile right (span 8) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left selector sidebar */}
        <div className="lg:col-span-4 bg-[#FAF8F5] p-6 border border-black/15 flex flex-col h-[670px] font-serif">
          <span className="text-[9px] text-slate-550 uppercase tracking-widest font-sans font-black mb-3 block">Filter Constituencies</span>
          
          <div className="space-y-4 mb-5">
            {/* Search Input */}
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-4 w-4 text-slate-400" />
              </span>
              <input
                type="text"
                placeholder="Search Kuppam, Guntur..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-white border border-black/20 text-xs text-black rounded-none focus:outline-none focus:border-black font-sans"
              />
            </div>

            {/* District dropdown */}
            <div>
              <label className="block text-[8px] text-slate-500 uppercase tracking-wider font-sans font-bold mb-1">Filter by District</label>
              <select
                aria-label="Filter by district"
                value={selectedDistrictFilter}
                onChange={(e) => setSelectedDistrictFilter(e.target.value)}
                className="w-full bg-white border border-black/20 text-xs text-black p-2 rounded-none focus:outline-none focus:border-black font-sans"
              >
                <option value="all">All 26 Districts ({CONSTITUENCIES.length} Assembly seats)</option>
                {DISTRICTS.map((d) => (
                  <option key={d.id} value={d.id}>{d.name} ({d.seatsCount} Seats)</option>
                ))}
              </select>
            </div>
            
            {/* Live Production Reset Controls */}
            <div className="pt-2 border-t border-black/5 mt-1.5 pb-1">
              {!confirmGeneralReset ? (
                <button
                  type="button"
                  onClick={() => setConfirmGeneralReset(true)}
                  className="w-full flex items-center justify-center space-x-1.5 py-1.5 px-2 bg-neutral-950 hover:bg-[#A01D24] text-white text-[9px] font-sans font-bold tracking-widest uppercase transition-colors duration-150 rounded-none cursor-pointer"
                  title="Click to reset all voter counters to 0"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Production Live Reset</span>
                </button>
              ) : (
                <div className="bg-[#FFF4F4] border border-red-200 p-2 text-[10px] space-y-1.5">
                  <div className="font-sans text-red-800 font-bold leading-normal text-[9px]">
                    Reset ALL 175 constituency registered voter counters to 0?
                  </div>
                  <div className="flex space-x-2">
                    <button
                      type="button"
                      onClick={() => {
                        handleResetAllToZero();
                        setConfirmGeneralReset(false);
                      }}
                      className="bg-red-700 text-white hover:bg-red-800 font-sans text-[8px] px-1.5 py-0.5 font-bold uppercase cursor-pointer"
                    >
                      Yes, Reset All
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmGeneralReset(false)}
                      className="bg-neutral-200 text-neutral-800 hover:bg-neutral-300 font-sans text-[8px] px-1.5 py-0.5 font-bold uppercase cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Scrolled list of constituencies */}
          <div className="flex-1 overflow-y-auto pr-1 space-y-1 bg-white border border-black/10 p-2 rounded-none custom-scrollbar font-sans">
            {filteredACList.length > 0 ? (
              filteredACList.map((ac) => {
                const isSelected = ac.id === selectedACId;
                return (
                  <button
                    key={ac.id}
                    onClick={() => setSelectedACId(ac.id)}
                    className={`w-full text-left p-2.5 rounded-none text-xs transition duration-150 flex items-center justify-between border-b ${
                      isSelected 
                        ? "bg-black text-[#FAF8F5] border-black" 
                        : "text-slate-800 bg-transparent border-black/[0.05] hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex flex-col">
                      <span className={`font-semibold ${isSelected ? "text-[#FAF8F5]" : "text-black"}`}>{ac.name}</span>
                      <span className={`text-[10px] ${isSelected ? "text-slate-300" : "text-slate-500"}`}>{ac.districtName}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-[9px] font-mono px-1 border border-black/10 bg-[#FAF8F5] text-slate-600 rounded">{ac.id}</span>
                      <span className={`text-[10px] font-black ${isSelected ? "text-[#FAF8F5]" : "text-black"}`}>
                        {ac.partyPreference[0]?.party}
                      </span>
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="text-center py-12 text-slate-400 text-xs font-serif italic">
                No matching constituencies.
              </div>
            )}
          </div>
        </div>

        {/* Right profile detail panel */}
        <div id="constituency-info-container" className="lg:col-span-8 bg-white p-6 sm:p-8 border border-black/15 flex flex-col justify-between font-serif">
          
          {/* Header block with Name, MLA, Swing stats */}
          <div>
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 border-b border-black/10 pb-6">
              <div>
                <div className="flex items-center space-x-2 mb-2">
                  <span className="text-[9px] px-2.5 py-0.5 bg-black text-[#F9F7F2] font-sans font-black uppercase tracking-wider">{acData.id} Assembly Unit</span>
                  <span className="text-[10px] text-slate-500 font-sans tracking-wide uppercase font-bold">({acData.districtName} District)</span>
                </div>
                <h2 className="text-3xl font-serif italic text-black mt-2 flex items-center space-x-2">
                  <MapPin className="w-6 h-6 text-black" />
                  <span>{acData.name} Segment</span>
                </h2>
                <p className="text-xs text-slate-500 mt-2 font-sans font-medium tracking-wide uppercase">
                  {acData.mandalCount} MANDALS &bull; {acData.villageCount} VILLAGE CHIEFTAINCY UNITS
                </p>
              </div>

              <div className="flex items-center space-x-2">
                <span className="text-[10px] font-sans font-bold text-slate-550 uppercase">Mandal Lean:</span>
                <span className={`text-[10px] font-sans tracking-widest uppercase font-black px-3 py-1.5 ${getSwingLabelClass(acData.swingStatus)}`}>
                  {acData.swingStatus}
                </span>
              </div>
            </div>

            {/* Core statistics cards */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mt-6">
              
              <div className="bg-[#FAF8F5] p-4 border border-black/10">
                <span className="text-[9px] text-slate-550 font-sans uppercase tracking-wider block font-bold">Approx Population</span>
                <span className="text-lg font-serif italic text-black mt-1 block">{(acData.voters * 4.2).toLocaleString()}</span>
              </div>

              <div className="bg-[#FAF8F5] p-4 border border-black/10 relative group min-h-[96px] flex flex-col justify-between">
                <span className="text-[9px] text-slate-550 font-sans uppercase tracking-wider block font-bold">Registered Voters</span>
                
                {isEditingVoters ? (
                  <form 
                    onSubmit={(e) => {
                      e.preventDefault();
                      const val = parseInt(editVotersValue, 10);
                      if (!isNaN(val) && val >= 0) {
                        handleUpdateVoters(acData.id, val);
                        setIsEditingVoters(false);
                      }
                    }}
                    className="mt-1 flex flex-col space-y-1"
                  >
                    <input
                      type="number"
                      min="0"
                      value={editVotersValue}
                      onChange={(e) => setEditVotersValue(e.target.value)}
                      className="w-full px-1.5 py-0.5 text-xs font-sans bg-white border border-black/20 focus:outline-none focus:border-black text-black rounded-none"
                      placeholder="Live count"
                      autoFocus
                    />
                    <div className="flex space-x-1">
                      <button
                        type="submit"
                        className="bg-black text-[#FAF8F5] hover:bg-neutral-800 text-[8px] font-sans px-1.5 py-0.5 uppercase font-bold cursor-pointer"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsEditingVoters(false);
                          setEditVotersValue(acData.voters.toString());
                        }}
                        className="bg-neutral-200 text-black hover:bg-neutral-300 text-[8px] font-sans px-1.5 py-0.5 uppercase font-bold cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="mt-1 flex flex-col justify-between h-full">
                    <span className="text-lg font-serif italic text-black block">{acData.voters.toLocaleString()}</span>
                    
                    <div className="mt-1 flex items-center space-x-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => {
                          setIsEditingVoters(true);
                          setEditVotersValue(acData.voters.toString());
                        }}
                        className="text-[8px] font-sans uppercase tracking-wider font-bold underline text-slate-600 hover:text-black cursor-pointer inline-flex items-center space-x-0.5"
                      >
                        <Edit3 className="w-2.5 h-2.5" />
                        <span>Edit</span>
                      </button>
                      <span className="text-slate-300 text-[8px]">&bull;</span>
                      <button
                        type="button"
                        onClick={() => {
                          handleUpdateVoters(acData.id, 0);
                        }}
                        className="text-[8px] font-sans uppercase tracking-wider font-bold underline text-[#A01D24] hover:text-[#D12C36] cursor-pointer"
                      >
                        Reset to 0
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* People Pulse Registers Card */}
              <div className="bg-[#FAF8F5] p-4 border border-black/10 relative group min-h-[96px] flex flex-col justify-between">
                <span className="text-[9px] text-[#A01D24] font-sans uppercase tracking-wider block font-bold">People Pulse Registers</span>
                
                {isEditingPulseVoters ? (
                  <form 
                    onSubmit={(e) => {
                      e.preventDefault();
                      const val = parseInt(editPulseVotersValue, 10);
                      if (!isNaN(val) && val >= 0) {
                        handleUpdatePulseVoters(acData.id, val);
                        setIsEditingPulseVoters(false);
                      }
                    }}
                    className="mt-1 flex flex-col space-y-1"
                  >
                    <input
                      type="number"
                      min="0"
                      value={editPulseVotersValue}
                      onChange={(e) => setEditPulseVotersValue(e.target.value)}
                      className="w-full px-1.5 py-0.5 text-xs font-sans bg-white border border-[#A01D24]/30 focus:outline-none focus:border-[#A01D24] text-black rounded-none"
                      placeholder="Pulse count"
                      autoFocus
                    />
                    <div className="flex space-x-1">
                      <button
                        type="submit"
                        className="bg-[#A01D24] text-white hover:bg-red-800 text-[8px] font-sans px-1.5 py-0.5 uppercase font-[#FAF8F5] cursor-pointer font-bold"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsEditingPulseVoters(false);
                          setEditPulseVotersValue(currentPulseVoters.toString());
                        }}
                        className="bg-neutral-200 text-black hover:bg-neutral-300 text-[8px] font-sans px-1.5 py-0.5 uppercase font-bold cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="mt-1 flex flex-col justify-between h-full">
                    <span className="text-lg font-serif italic text-[#A01D24] block font-bold">{currentPulseVoters.toLocaleString()}+</span>
                    
                    <div className="mt-1 flex items-center space-x-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => {
                          setIsEditingPulseVoters(true);
                          setEditPulseVotersValue(currentPulseVoters.toString());
                        }}
                        className="text-[8px] font-sans uppercase tracking-wider font-bold underline text-slate-600 hover:text-black cursor-pointer inline-flex items-center space-x-0.5"
                      >
                        <Edit3 className="w-2.5 h-2.5" />
                        <span>Edit</span>
                      </button>
                      <span className="text-slate-300 text-[8px]">&bull;</span>
                      <button
                        type="button"
                        onClick={() => {
                          handleUpdatePulseVoters(acData.id, 0);
                        }}
                        className="text-[8px] font-sans uppercase tracking-wider font-bold underline text-[#A01D24] hover:text-[#D12C36] cursor-pointer"
                      >
                        Reset to 0
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="bg-[#FAF8F5] p-4 border border-black/10">
                <span className="text-[9px] text-slate-550 font-sans uppercase tracking-wider block font-bold">Opinion Sample</span>
                <span className="text-lg font-serif italic text-black mt-1 block">{acData.surveyResponses} Responses</span>
              </div>

              <div className="bg-[#FAF8F5] p-4 border border-black/10">
                <span className="text-[9px] text-slate-550 font-sans uppercase tracking-wider block font-bold">MLA Approval</span>
                <span className="text-lg font-serif italic text-[#2E4A3F] mt-1 block">{acData.approvalRating}%</span>
              </div>

            </div>

            {/* MLA details and reviews */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-8 mt-8">
              
              {/* MLA segment */}
              <div className="md:col-span-5 bg-[#FAF8F5] p-5 border border-black/10 flex flex-col justify-between">
                <div>
                  <span className="text-[9px] font-sans font-black text-slate-500 uppercase tracking-widest block mb-1">Sitting Incumbent</span>
                  <div className="text-xl font-serif italic text-black font-semibold">{acData.sittingMLA.split(" (")[0]}</div>
                  
                  <div className={`mt-3 text-[10px] font-sans font-black tracking-widest uppercase border px-2 py-1 inline-block ${getPartyBadge(acData.sittingMLA)}`}>
                    {acData.sittingMLA.includes("TDP") ? "Telugu Desam Party (TDP)" : acData.sittingMLA.includes("YSRCP") ? "YSR Congress Party" : "Jana Sena Party (JSP)"}
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-black/10">
                  <span className="text-[9px] text-slate-500 font-sans font-bold block uppercase mb-1">Electorate Core Feedback:</span>
                  <p className="text-xs text-slate-700 leading-relaxed font-serif italic bg-white p-3 border border-black/5">
                    "{acData.MLAFeedback}"
                  </p>
                </div>
              </div>

              {/* Dynamic Party Preference segmented bar charts */}
              <div className="md:col-span-7 bg-white p-5 border border-black/10 flex flex-col justify-between">
                <div>
                  <span className="text-[9px] font-sans font-black text-slate-500 uppercase tracking-widest block mb-4">Electoral Preference Matrix</span>

                  <div className="space-y-4 my-2">
                    {acData.partyPreference.map((p, idx) => {
                      const colMap: Record<string, string> = {
                        TDP: "bg-[#D99B26]",
                        YSRCP: "bg-[#2F528F]",
                        JSP: "bg-[#A63A3A]",
                        INC: "bg-green-600",
                        OTH: "bg-[#121212]"
                      };
                      return (
                        <div key={idx} className="space-y-1">
                          <div className="flex justify-between text-xs font-sans text-slate-755 font-bold">
                            <span>{p.party} Intentions</span>
                            <span className="font-mono">{p.percentage}%</span>
                          </div>
                          <div className="w-full bg-slate-100 h-1.5 rounded-none overflow-hidden">
                            <div className={`h-full ${colMap[p.party] || "bg-slate-500"}`} style={{ width: `${p.percentage}%` }}></div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

            </div>

            {/* Demographics / Historical Trend History */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-8">
              
              {/* Top Issues panel */}
              <div className="bg-[#FAF8F5] p-5 border border-black/10">
                <h4 className="text-[9px] font-sans font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center space-x-1">
                  <FileText className="w-3.5 h-3.5 text-black" />
                  <span>Public Infrastructure Priorities</span>
                </h4>
                
                <div className="space-y-4">
                  {acData.topIssues.map((issue, idx) => (
                    <div key={idx} className="bg-white p-3 border border-black/5">
                      <div className="flex justify-between items-center mb-1.5 text-xs font-serif text-[#121212]">
                        <span className="font-bold">{issue.issue}</span>
                        <span className="text-black font-mono font-bold">{issue.percentage}% Priority</span>
                      </div>
                      <div className="w-full bg-slate-100 h-1 rounded-none overflow-hidden">
                        <div className="bg-black h-full" style={{ width: `${issue.percentage}%` }}></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Historical Lead trend table */}
              <div className="bg-white p-5 border border-black/10 flex flex-col justify-between font-serif">
                <div>
                  <h4 className="text-[9px] font-sans font-black text-slate-500 uppercase tracking-widest mb-4">Historical Projection Shifts (2026)</h4>
                  <div className="min-w-full overflow-hidden text-xs">
                    <table className="min-w-full">
                      <thead>
                        <tr className="border-b border-black/10 text-slate-550 font-sans uppercase tracking-widest text-[9px] text-left font-bold">
                          <th className="pb-2">Month</th>
                          <th className="pb-2">Local Leader Lean</th>
                          <th className="pb-2 text-right">Polling Gap</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-black/[0.05] text-slate-800 font-sans text-xs">
                        {acData.trendHistory.map((item, idx) => (
                          <tr key={idx}>
                            <td className="py-2.5">{item.month}</td>
                            <td className="py-2.5 font-bold text-black">{item.leadParty} Leading</td>
                            <td className="py-2.5 text-right font-mono font-bold text-black font-semibold">+{item.gap}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="bg-[#FAF8F5] p-3 border border-black/5 text-[9.5px] text-slate-550 flex items-center space-x-2 mt-4 font-sans tracking-wide">
                  <CheckCircle className="w-3.5 h-3.5 text-[#2E4A3F] flex-shrink-0" />
                  <span>Anonymized sample telemetry processing in full compliance with state rules.</span>
                </div>
              </div>

            </div>

          </div>

        </div>

      </div>
    </div>
  );
}
