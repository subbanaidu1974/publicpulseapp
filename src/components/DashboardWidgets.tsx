/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from "react";
import { BarChart3, TrendingUp, UserCheck, Users, CheckCircle2 } from "lucide-react";
import { District, Constituency, SurveyResponse } from "../types";
import { LEADERS, PARTIES, CONSTITUENCIES } from "../data/staticData";

interface DashboardWidgetsProps {
  selectedDistrict: District;
  surveyResponses: SurveyResponse[];
}

export default function DashboardWidgets({ selectedDistrict, surveyResponses }: DashboardWidgetsProps) {
  const [activeSegmentTab, setActiveSegmentTab] = useState<"overall" | "demographic" | "leadership" | "liveLogs">("overall");
  const [logsSearchQuery, setLogsSearchQuery] = useState("");

  const districtResponses = surveyResponses.filter(r => r.districtId === selectedDistrict.id);
  const filteredResponses = districtResponses.filter(r => 
    r.customFeedback.toLowerCase().includes(logsSearchQuery.toLowerCase()) ||
    r.occupation.toLowerCase().includes(logsSearchQuery.toLowerCase()) ||
    r.votePreference.toLowerCase().includes(logsSearchQuery.toLowerCase()) ||
    r.primaryIssue.toLowerCase().includes(logsSearchQuery.toLowerCase()) ||
    r.constituencyId.toLowerCase().includes(logsSearchQuery.toLowerCase())
  );

  // Sum up some local statistics
  const districtACs = CONSTITUENCIES.filter(ac => ac.districtId === selectedDistrict.id);
  const totalACs = districtACs.length;
  
  let avgMlaApproval = 0;
  let govApproval = 0;
  let swings = { Safe: 0, Leans: 0, Swing: 0, Battleground: 0 };
  let sortedIssues: { issue: string; percentage: number }[] = [];
  let sortedParties: { party: string; percentage: number }[] = [];
  let leaderApprovalList: { name: string; approval: number }[] = [];
  
  // Demographics state/counts
  let ageCohorts = [
    { label: "18 - 25 Years (First-timers)", percent: 0 },
    { label: "26 - 35 Years (Youth Segment)", percent: 0 },
    { label: "36 - 50 Years (Middle-age)", percent: 0 },
    { label: "50+ Years (Seniors Balance)", percent: 0 }
  ];
  let malePercent = 0;
  let femalePercent = 0;
  let othersPercent = 0;
  let occupationCohorts = [
    { label: "Agriculture & Allied Livelihood", val: 0 },
    { label: "Retail & Local Commerce Traders", val: 0 },
    { label: "Private & Factory Employees", val: 0 },
    { label: "Students / Skill Learners", val: 0 },
    { label: "Unemployed / Domestic Builders", val: 0 }
  ];

  if (districtResponses.length > 0) {
    const totalCount = districtResponses.length;

    // Calculate average MLA approval rating dynamically
    const totalMlaRating = districtResponses.reduce((sum, r) => sum + r.mlaRating, 0);
    avgMlaApproval = Math.round((totalMlaRating / totalCount) * 20);

    const totalGovRating = districtResponses.reduce((sum, r) => sum + r.govtRating, 0);
    govApproval = Math.round((totalGovRating / totalCount) * 20);

    // Dynamic Swings based on constituency preference margins
    const acResponses: Record<string, typeof districtResponses> = {};
    districtResponses.forEach(r => {
      if (!acResponses[r.constituencyId]) acResponses[r.constituencyId] = [];
      acResponses[r.constituencyId].push(r);
    });

    Object.keys(acResponses).forEach(acId => {
      const resps = acResponses[acId];
      const partyCounts: Record<string, number> = {};
      resps.forEach(r => {
        partyCounts[r.votePreference] = (partyCounts[r.votePreference] || 0) + 1;
      });
      const sortedPartyCounts = Object.entries(partyCounts).sort((a, b) => b[1] - a[1]);
      const leadingCount = sortedPartyCounts[0]?.[1] || 0;
      const secondCount = sortedPartyCounts[1]?.[1] || 0;
      const marginPercent = resps.length > 0 ? ((leadingCount - secondCount) / resps.length) * 100 : 0;

      if (marginPercent > 12) swings.Safe += 1;
      else if (marginPercent > 6) swings.Leans += 1;
      else if (marginPercent > 3) swings.Swing += 1;
      else swings.Battleground += 1;
    });
    
    const unrepresentedACsCount = totalACs - Object.keys(acResponses).length;
    if (unrepresentedACsCount > 0) {
      swings.Battleground += unrepresentedACsCount;
    }

    // Dynamic Issues ranking from districtResponses
    const issuesCounts: Record<string, number> = {};
    districtResponses.forEach(r => {
      issuesCounts[r.primaryIssue] = (issuesCounts[r.primaryIssue] || 0) + 1;
    });
    sortedIssues = Object.entries(issuesCounts)
      .map(([issue, count]) => ({ issue, percentage: Math.round((count / totalCount) * 100) }))
      .sort((a, b) => b.percentage - a.percentage)
      .slice(0, 5);

    // Dynamic Party preferences from districtResponses
    const partyCounts: Record<string, number> = {};
    districtResponses.forEach(r => {
      partyCounts[r.votePreference] = (partyCounts[r.votePreference] || 0) + 1;
    });
    const possibleParties = ["TDP", "YSRCP", "JSP", "Others"];
    possibleParties.forEach(p => {
      if (!partyCounts[p]) partyCounts[p] = 0;
    });

    sortedParties = Object.entries(partyCounts)
      .map(([party, count]) => ({ party, percentage: Math.round((count / totalCount) * 100) }))
      .sort((a, b) => b.percentage - a.percentage);

    // Dynamic Leader approval simulation based on favLeader counts
    const leaderCounts: Record<string, number> = {};
    districtResponses.forEach(r => {
      leaderCounts[r.favLeader] = (leaderCounts[r.favLeader] || 0) + 1;
    });
    const possibleLeaders = [
      "Nara Chandrababu Naidu",
      "Y.S. Jagan Mohan Reddy",
      "Pawan Kalyan",
      "Nara Lokesh",
      "YS Sharmila"
    ];
    possibleLeaders.forEach(l => {
      if (!leaderCounts[l]) leaderCounts[l] = 0;
    });

    leaderApprovalList = Object.entries(leaderCounts)
      .map(([name, count]) => ({ name, approval: Math.round((count / totalCount) * 100) }))
      .sort((a, b) => b.approval - a.approval);

    // Demographic Age distribution
    const ageCounts = { "18-25": 0, "26-35": 0, "36-50": 0, "50+": 0 };
    districtResponses.forEach(r => {
      const g = r.ageGroup;
      if (g.includes("18-25")) ageCounts["18-25"]++;
      else if (g.includes("26-35")) ageCounts["26-35"]++;
      else if (g.includes("36-50")) ageCounts["36-50"]++;
      else ageCounts["50+"]++;
    });
    ageCohorts = [
      { label: "18 - 25 Years (First-timers)", percent: Math.round((ageCounts["18-25"] / totalCount) * 100) },
      { label: "26 - 35 Years (Youth Segment)", percent: Math.round((ageCounts["26-35"] / totalCount) * 100) },
      { label: "36 - 50 Years (Middle-age)", percent: Math.round((ageCounts["36-50"] / totalCount) * 100) },
      { label: "50+ Years (Seniors Balance)", percent: Math.round((ageCounts["50+"] / totalCount) * 100) }
    ];

    // Demographic Gender split
    let maleCount = 0;
    let femaleCount = 0;
    let othersCount = 0;
    districtResponses.forEach(r => {
      if (r.gender.toLowerCase() === "male") maleCount++;
      else if (r.gender.toLowerCase() === "female") femaleCount++;
      else othersCount++;
    });
    malePercent = Math.round((maleCount / totalCount) * 1000) / 10;
    femalePercent = Math.round((femaleCount / totalCount) * 1000) / 10;
    othersPercent = Math.round((othersCount / totalCount) * 1000) / 10;

    // Demographic Occupation split
    const possibleOccs = [
      { key: "Agriculture", label: "Agriculture & Allied Livelihood" },
      { key: "Self-employed", label: "Retail & Local Commerce Traders" },
      { key: "Private Sector", label: "Private & Factory Employees" },
      { key: "Students", label: "Students / Skill Learners" },
      { key: "Unemployed", label: "Unemployed / Domestic Builders" }
    ];
    occupationCohorts = possibleOccs.map(occ => {
      const count = districtResponses.filter(r => r.occupation.toLowerCase().includes(occ.key.toLowerCase())).length;
      return {
        label: occ.label,
        val: Math.round((count / totalCount) * 100)
      };
    });

  } else {
    avgMlaApproval = 0;
    govApproval = 0;
    swings = { Safe: 0, Leans: 0, Swing: 0, Battleground: totalACs };
    
    sortedIssues = [];
    sortedParties = [
      { party: "TDP", percentage: 0 },
      { party: "YSRCP", percentage: 0 },
      { party: "JSP", percentage: 0 },
      { party: "Others", percentage: 0 }
    ];
    leaderApprovalList = [
      { name: "Nara Chandrababu Naidu", approval: 0 },
      { name: "Y.S. Jagan Mohan Reddy", approval: 0 },
      { name: "Pawan Kalyan", approval: 0 },
      { name: "Nara Lokesh", approval: 0 },
      { name: "YS Sharmila", approval: 0 }
    ];
    ageCohorts = [
      { label: "18 - 25 Years (First-timers)", percent: 0 },
      { label: "26 - 35 Years (Youth Segment)", percent: 0 },
      { label: "36 - 50 Years (Middle-age)", percent: 0 },
      { label: "50+ Years (Seniors Balance)", percent: 0 }
    ];
    malePercent = 0;
    femalePercent = 0;
    othersPercent = 0;
    occupationCohorts = [
      { label: "Agriculture & Allied Livelihood", val: 0 },
      { label: "Retail & Local Commerce Traders", val: 0 },
      { label: "Private & Factory Employees", val: 0 },
      { label: "Students / Skill Learners", val: 0 },
      { label: "Unemployed / Domestic Builders", val: 0 }
    ];
  }

  return (
    <div className="space-y-8 font-serif">
      
      {/* Upper Widgets Tab Controller */}
      <div className="flex flex-col md:flex-row md:items-end justify-between border-b border-black pb-4 gap-4">
        <div>
          <span className="text-[9px] text-slate-500 uppercase tracking-[0.25em] font-sans font-black">ANALYTICS REGISTER 02</span>
          <h3 className="text-2xl font-serif italic text-black mt-1 flex items-center space-x-2">
            <span>District Intelligence Dashboard</span>
          </h3>
        </div>
        
        <div className="flex border border-black p-1 bg-white font-sans text-xs">
          <button
            onClick={() => setActiveSegmentTab("overall")}
            className={`px-4 py-1.5 transition uppercase tracking-wider font-bold text-[10px] ${
              activeSegmentTab === "overall" ? "bg-black text-white" : "text-black hover:bg-slate-100"
            }`}
          >
            Core Sentiment
          </button>
          <button
            onClick={() => setActiveSegmentTab("leadership")}
            className={`px-4 py-1.5 transition uppercase tracking-wider font-bold text-[10px] ${
              activeSegmentTab === "leadership" ? "bg-black text-white" : "text-black hover:bg-slate-100"
            }`}
          >
            Leaders Popularity
          </button>
          <button
            onClick={() => setActiveSegmentTab("demographic")}
            className={`px-4 py-1.5 transition uppercase tracking-wider font-bold text-[10px] ${
              activeSegmentTab === "demographic" ? "bg-black text-white" : "text-black hover:bg-slate-100"
            }`}
          >
            Demographics
          </button>
          <button
            onClick={() => setActiveSegmentTab("liveLogs")}
            className={`px-4 py-1.5 transition uppercase tracking-wider font-bold text-[10px] ${
              activeSegmentTab === "liveLogs" ? "bg-black text-white" : "text-black hover:bg-slate-100"
            }`}
          >
            Live Logs ({districtResponses.length})
          </button>
        </div>
      </div>

      {/* Top Counters cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        
        <div className="bg-white p-6 border border-black/15 flex flex-col justify-between">
          <div>
            <span className="text-[9px] text-slate-500 block uppercase tracking-wider font-sans font-bold">Total Local Responses</span>
            <span className="text-3xl font-serif italic text-black block mt-2">{surveyResponses.length.toLocaleString()}</span>
          </div>
          <span className="text-[9px] text-slate-500 block mt-4 font-sans tracking-wide uppercase border-t border-black/10 pt-2 font-bold flex items-center space-x-1">
            <span>Quota confidence 95%</span>
          </span>
        </div>

        <div className="bg-white p-6 border border-black/15 flex flex-col justify-between">
          <div>
            <span className="text-[9px] text-slate-500 block uppercase tracking-wider font-sans font-bold">Standard Survey Margin</span>
            <span className="text-3xl font-serif italic text-black block mt-2">&plusmn; 1.8%</span>
          </div>
          <span className="text-[9px] text-slate-500 block mt-4 font-sans tracking-wide uppercase border-t border-black/10 pt-2 font-bold">
            Representative sample quota
          </span>
        </div>

        <div className="bg-white p-6 border border-black/15 flex flex-col justify-between">
          <div>
            <span className="text-[9px] text-slate-500 block uppercase tracking-wider font-sans font-bold">District MLA App.</span>
            <span className="text-3xl font-serif italic text-black block mt-2">{avgMlaApproval}%</span>
          </div>
          <span className="text-[9px] text-slate-500 block mt-4 font-sans tracking-wide uppercase border-t border-black/10 pt-2 font-bold font-serif">
            Avg of {totalACs} constituencies
          </span>
        </div>

        <div className="bg-white p-6 border border-black/15 flex flex-col justify-between">
          <div>
            <span className="text-[9px] text-slate-500 block uppercase tracking-wider font-sans font-bold">State Government Rating</span>
            <span className="text-3xl font-serif italic text-black block mt-2">{govApproval}%</span>
          </div>
          <span className="text-[9px] text-slate-500 block mt-4 font-sans tracking-wide uppercase border-t border-black/10 pt-2 font-bold">
            Direct Welfare Impact Score
          </span>
        </div>

      </div>

      {/* Main Widgets Container relative to active Tab */}
      {activeSegmentTab === "overall" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* Main Party Preference & Voting Intention Donut (span 4) */}
          <div className="lg:col-span-4 bg-white p-6 border border-black/15 flex flex-col justify-between font-serif">
            <div>
              <span className="text-[9px] font-sans font-black text-slate-500 uppercase tracking-widest block mb-1">Voting Intention Ratio</span>
              <h4 className="text-lg font-serif italic text-black mb-6">Party Reference Level</h4>
            </div>

            <div className="flex flex-col items-center justify-center">
              {/* Responsive custom HTML Ring chart block */}
              <div className="relative w-36 h-36 flex items-center justify-center">
                
                {/* SVG Proportional Segments */}
                <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                  {/* Segment 1: TDP */}
                  <circle
                    cx="18"
                    cy="18"
                    r="15.915"
                    fill="transparent"
                    stroke="#D99B26"
                    strokeWidth="3.4"
                    strokeDasharray={`${sortedParties[0]?.percentage || 45} ${100 - (sortedParties[0]?.percentage || 45)}`}
                    strokeDashoffset="0"
                  />
                  {/* Segment 2: YSRCP */}
                  <circle
                    cx="18"
                    cy="18"
                    r="15.915"
                    fill="transparent"
                    stroke="#2F528F"
                    strokeWidth="3.4"
                    strokeDasharray={`${sortedParties[1]?.percentage || 35} ${100 - (sortedParties[1]?.percentage || 35)}`}
                    strokeDashoffset={`-${sortedParties[0]?.percentage || 45}`}
                  />
                  {/* Segment 3: JSP */}
                  <circle
                    cx="18"
                    cy="18"
                    r="15.915"
                    fill="transparent"
                    stroke="#A63A3A"
                    strokeWidth="3.4"
                    strokeDasharray={`${sortedParties[2]?.percentage || 12} ${100 - (sortedParties[2]?.percentage || 12)}`}
                    strokeDashoffset={`-${(sortedParties[0]?.percentage || 45) + (sortedParties[1]?.percentage || 35)}`}
                  />
                  {/* Segment 4: Others */}
                  <circle
                    cx="18"
                    cy="18"
                    r="15.915"
                    fill="transparent"
                    stroke="#121212"
                    strokeWidth="3.2"
                    strokeDasharray={`8 92`}
                    strokeDashoffset={`-${(sortedParties[0]?.percentage || 45) + (sortedParties[1]?.percentage || 35) + (sortedParties[2]?.percentage || 12)}`}
                  />
                </svg>

                <div className="absolute text-center font-serif">
                  <span className="text-[8px] text-slate-500 uppercase tracking-widest block font-sans">Top Lean</span>
                  <span className="text-xl font-serif italic text-black block">{sortedParties[0]?.party || "TDP"}</span>
                  <span className="text-[9.5px] text-black font-semibold font-mono">+{sortedParties[0]?.percentage - (sortedParties[1]?.percentage || 30)}% lead</span>
                </div>
              </div>

              {/* Proportional Grid Legends */}
              <div className="w-full space-y-2 mt-6 text-[11px] font-sans">
                {sortedParties.map((p, idx) => {
                  return (
                    <div key={idx} className="flex items-center justify-between p-2 bg-[#FAF8F5] border border-black/10">
                      <div className="flex items-center space-x-2">
                        <span className={`w-2.5 h-2.5 inline-block ${
                          p.party === "TDP" ? "bg-[#D99B26]" : p.party === "YSRCP" ? "bg-[#2F528F]" : p.party === "JSP" ? "bg-[#A63A3A]" : "bg-[#121212]"
                        }`}></span>
                        <span className="font-bold text-black">{p.party} Preference</span>
                      </div>
                      <span className="text-black font-bold font-mono">{p.percentage}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Issue Importance Ranking Horizontal Chart & Feedback Summary (span 4) */}
          <div className="lg:col-span-4 bg-white p-6 border border-black/15 flex flex-col justify-between font-serif">
            <div>
              <span className="text-[9px] font-sans font-black text-slate-500 uppercase tracking-widest block mb-1">Voter Priorities</span>
              <h4 className="text-lg font-serif italic text-black mb-4">Mandal Issue Matrix</h4>
            </div>

            <div className="space-y-4 my-3">
              {sortedIssues.map((item, idx) => {
                return (
                  <div key={idx} className="space-y-1">
                    <div className="flex justify-between text-xs font-serif text-[#121212]">
                      <span className="truncate max-w-[80%] font-semibold">{item.issue}</span>
                      <span className="font-bold font-mono">{item.percentage}%</span>
                    </div>
                    <div className="w-full bg-slate-100 h-1.5 rounded-none overflow-hidden">
                      <div
                        className="h-full bg-black transition-all duration-300"
                        style={{ width: `${item.percentage}%` }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="border-l-2 border-black pl-4 py-1.5 text-xs text-slate-600 leading-relaxed font-serif bg-[#FAF8F5]">
              <span className="text-black font-sans font-black uppercase text-[8px] tracking-wider block mb-1">Analyst Ground Report</span>
              Water security blueprints and irrigation state canals rank as the critical public infrastructure concerns across {selectedDistrict.name} assembly seats.
            </div>
          </div>

          {/* Assembly Constituency Swing Analysis (span 4) */}
          <div className="lg:col-span-4 bg-white p-6 border border-black/15 flex flex-col justify-between font-serif">
            <div>
              <span className="text-[9px] font-sans font-black text-slate-500 uppercase tracking-widest block mb-1">Seat Probability Matrix</span>
              <h4 className="text-lg font-serif italic text-black mb-4">Constituency Hotbeds</h4>
            </div>

            <div className="grid grid-cols-2 gap-3 my-2 text-center text-xs">
              
              <div className="bg-[#FAF8F5] p-3 border border-black/10">
                <span className="text-[9px] text-slate-500 font-sans font-bold block uppercase mb-1">Safe Stronghold</span>
                <span className="text-xl font-serif italic text-black">{swings.Safe}</span>
                <span className="text-[8px] text-slate-500 block font-sans mt-1">Margin &gt; 12%</span>
              </div>

              <div className="bg-[#FAF8F5] p-3 border border-black/10">
                <span className="text-[9px] text-slate-500 font-sans font-bold block uppercase mb-1">Leaning Lead</span>
                <span className="text-xl font-serif italic text-black">{swings.Leans}</span>
                <span className="text-[8px] text-slate-500 block font-sans mt-1">Margin 6% - 12%</span>
              </div>

              <div className="bg-[#FAF8F5] p-3 border border-black/10 font-serif">
                <span className="text-[9px] text-slate-500 font-sans font-bold block uppercase mb-1">Active Swings</span>
                <span className="text-xl font-serif italic text-black">{swings.Swing}</span>
                <span className="text-[8px] text-slate-500 block font-sans mt-1">Margin 3% - 6%</span>
              </div>

              <div className="bg-[#FAF8F5] p-3 border border-black/10">
                <span className="text-[9px] text-slate-500 font-sans font-bold block uppercase mb-1">Battleground</span>
                <span className="text-xl font-serif italic text-[#8C3E3E]">{swings.Battleground}</span>
                <span className="text-[8px] text-slate-500 block font-sans mt-1">Margin &lt; 3%</span>
              </div>

            </div>

            <div className="border border-black/10 bg-[#FAF8F5] p-3 space-y-2">
              <div className="flex justify-between font-serif text-xs">
                <span className="font-bold text-black">Assembly Seats Checked:</span>
                <span className="font-mono">{totalACs}</span>
              </div>
              <div className="w-full bg-slate-200 h-1 rounded-none overflow-hidden flex font-serif">
                <div className="bg-[#2E4A3F] h-full" style={{ width: `${(swings.Safe / totalACs) * 100}%` }}></div>
                <div className="bg-[#3F5B73] h-full" style={{ width: `${(swings.Leans / totalACs) * 100}%` }}></div>
                <div className="bg-[#9E6F40] h-full" style={{ width: `${(swings.Swing / totalACs) * 100}%` }}></div>
                <div className="bg-[#8C3E3E] h-full" style={{ width: `${(swings.Battleground / totalACs) * 100}%` }}></div>
              </div>
            </div>
          </div>

        </div>
      )}

      {/* Leadership Approval rating tab */}
      {activeSegmentTab === "leadership" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 font-serif">
          <div className="bg-white p-6 border border-black/15">
            <span className="text-[9px] text-slate-500 font-sans font-black block uppercase tracking-widest mb-1">Satisfactory Polling Matrix</span>
            <h4 className="text-lg font-serif italic text-black mb-6">Preferred Leader Metrics</h4>
            
            <div className="space-y-4">
              {leaderApprovalList.map((leader, index) => {
                return (
                  <div key={index} className="space-y-1">
                    <div className="flex justify-between items-center text-xs text-slate-700 font-serif">
                      <div className="flex items-center space-x-2">
                        <span className="w-5 h-5 bg-black text-[#F9F7F2] font-sans text-[9px] font-black flex items-center justify-center">
                          {index + 1}
                        </span>
                        <span className="font-semibold text-black">{leader.name}</span>
                      </div>
                      <span className="font-bold font-mono text-black">{leader.approval}% Fav. Rating</span>
                    </div>
                    <div className="w-full bg-slate-100 h-2 rounded-none overflow-hidden">
                      <div
                        className="h-full bg-[#121212] transition-all"
                        style={{ width: `${leader.approval}%` }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-white p-6 border border-black/15 flex flex-col justify-between font-serif">
            <div>
              <span className="text-[9px] text-slate-500 font-sans font-black block uppercase tracking-wider mb-1">Strategic Framework</span>
              <h4 className="text-lg font-serif italic text-black mb-4">Consolidated Voter Loyalty Range</h4>
              <p className="text-xs text-slate-600 leading-relaxed text-justify mb-4">
                Satisfactory indicators strongly align with mandate execution, local mandal delivery scorecards, and historical anti-incumbency levels in {selectedDistrict.name}.
              </p>
            </div>

            <div className="my-4 grid grid-cols-3 gap-3 text-center text-xs">
              <div className="bg-[#FAF8F5] p-3 border border-black/10">
                <span className="text-[8px] text-slate-500 font-sans font-bold block uppercase mb-1">Loyalty Retention</span>
                <span className="text-base font-serif italic text-black">74%</span>
              </div>
              <div className="bg-[#FAF8F5] p-3 border border-black/10 font-sans">
                <span className="text-[8px] text-slate-500 font-sans font-bold block uppercase mb-1">Swing Undecided</span>
                <span className="text-base font-serif italic text-black">11.4%</span>
              </div>
              <div className="bg-[#FAF8F5] p-3 border border-black/10 font-serif">
                <span className="text-[8px] text-slate-500 font-sans font-bold block uppercase mb-1">Neutral Margin</span>
                <span className="text-base font-serif italic text-black">14.6%</span>
              </div>
            </div>

            <span className="text-[9px] text-slate-500 block text-center font-sans tracking-tight pt-2 border-t border-black/5 uppercase font-bold">
              Reliability verified against {districtResponses.length.toLocaleString()} structured units.
            </span>
          </div>
        </div>
      )}

      {/* Demographic Breakdown Tab */}
      {activeSegmentTab === "demographic" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 font-serif">
          
          {/* Age Distribution */}
          <div className="bg-white p-6 border border-black/15 font-serif">
            <span className="text-[9px] text-slate-500 font-sans font-black block uppercase tracking-wider mb-1">Age Sample Cohorts</span>
            <h4 className="text-lg font-serif italic text-black mb-4">Representative Quota</h4>
            
            <div className="space-y-4">
              {ageCohorts.map((item, id) => (
                <div key={id} className="text-xs space-y-1">
                  <div className="flex justify-between text-slate-700">
                    <span className="font-medium">{item.label}</span>
                    <span className="font-bold font-mono text-black">{item.percent}%</span>
                  </div>
                  <div className="w-full bg-slate-100 h-1 rounded-none overflow-hidden">
                    <div className="bg-black h-full" style={{ width: `${item.percent}%` }}></div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Gender Split */}
          <div className="bg-white p-6 border border-black/15 flex flex-col justify-between font-serif">
            <div>
              <span className="text-[9px] text-slate-500 font-sans font-black block uppercase tracking-wider mb-1">Gender Partition</span>
              <h4 className="text-lg font-serif italic text-black mb-4">Response Balance</h4>
            </div>

            <div className="flex items-center justify-around my-4 border-y border-black/15 py-4">
              <div className="text-center font-serif">
                <div className="text-xl font-serif italic text-black">{malePercent}%</div>
                <span className="text-[8px] text-slate-500 font-sans uppercase tracking-[0.1em] font-bold font-sans">Male Respondents</span>
              </div>
              <div className="w-[1px] h-8 bg-black/10 font-sans"></div>
              <div className="text-center">
                <div className="text-xl font-serif italic text-black font-serif">{femalePercent}%</div>
                <span className="text-[8px] text-slate-500 font-sans uppercase tracking-[0.1em] font-bold font-sans">Female Respondents</span>
              </div>
            </div>

            <div className="w-full bg-slate-100 h-2 rounded-none overflow-hidden flex">
              <div className="bg-[#3F5B73] h-full" style={{ width: `${malePercent}%` }}></div>
              <div className="bg-[#8C3E3E] h-full" style={{ width: `${femalePercent}%` }}></div>
              <div className="bg-slate-350 h-full" style={{ width: `${othersPercent}%` }}></div>
            </div>

            <span className="text-[10px] text-slate-600 inline-block bg-[#FAF8F5] p-3 text-center border border-black/5 mt-4 leading-relaxed font-serif">
              Robust feedback representation driven by self-help organization participants and localized village volunteers.
            </span>
          </div>

          {/* Occupation splits */}
          <div className="bg-white p-6 border border-black/15 font-serif">
            <span className="text-[9px] text-slate-500 font-sans font-black block uppercase tracking-wider mb-1">Occupation Census</span>
            <h4 className="text-lg font-serif italic text-black mb-4">Sample Sector division</h4>

            <div className="space-y-4">
              {occupationCohorts.map((item, idx) => (
                <div key={idx} className="text-xs">
                  <div className="flex justify-between items-center mb-1 text-slate-700 font-serif">
                    <span className="truncate max-w-[80%] font-medium">{item.label}</span>
                    <span className="font-mono font-bold text-black">{item.val}%</span>
                  </div>
                  <div className="w-full bg-slate-100 h-1 rounded-none flex">
                    <div className="bg-[#121212] h-full" style={{ width: `${item.val}%` }}></div>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      )}

      {activeSegmentTab === "liveLogs" && (
        <div className="bg-white border border-black/15 p-6 sm:p-8 font-serif space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-black/10 pb-4 gap-4">
            <div>
              <span className="text-[9px] text-slate-500 font-sans font-black uppercase tracking-widest block">SECURE TELEMETRY FEEDS</span>
              <h4 className="text-lg font-serif italic text-black">Active Regional Submissions</h4>
            </div>
            
            {/* Keyword Search */}
            <div className="relative font-sans text-xs w-full sm:w-72">
              <input
                type="text"
                placeholder="Filter logs by keyword..."
                value={logsSearchQuery}
                onChange={(e) => setLogsSearchQuery(e.target.value)}
                className="w-full bg-[#FAF8F5] border border-black/15 focus:border-black p-2 pr-8 focus:outline-none text-xs text-black"
              />
              {logsSearchQuery && (
                <button
                  onClick={() => setLogsSearchQuery("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-black focus:outline-none"
                >
                  &times;
                </button>
              )}
            </div>
          </div>

          {filteredResponses.length === 0 ? (
            <div className="py-16 text-center space-y-4">
              <svg className="w-20 h-20 mx-auto text-slate-300" stroke="currentColor" fill="none" viewBox="0 0 24 24">
                <rect x="4" y="4" width="16" height="16" rx="2" strokeWidth="1" />
                <line x1="4" y1="10" x2="20" y2="10" strokeWidth="1" />
                <line x1="4" y1="15" x2="20" y2="15" strokeWidth="1" />
                <path d="M10 7h4" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M10 12h4" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="12" cy="12" r="7" strokeDasharray="1.5 1.5" strokeWidth="0.8" className="text-red-750" />
              </svg>
              <div className="space-y-1.5">
                <h5 className="font-sans font-black uppercase tracking-wider text-xs text-black">
                  {logsSearchQuery ? "No Matching Feedback Found" : "No Dynamic Submissions Registered"}
                </h5>
                <p className="text-slate-500 text-xs max-w-sm mx-auto leading-relaxed">
                  {logsSearchQuery 
                    ? `No registered entries matching "${logsSearchQuery}" were found in this district. Please try adjusting your search terms.`
                    : `No digital polls have been registered for ${selectedDistrict.name} under this current cycle. Populate the survey form to see live telemetry weights.`}
                </p>
                {logsSearchQuery && (
                  <button
                    onClick={() => setLogsSearchQuery("")}
                    className="mt-2 bg-[#121212] hover:bg-black text-[#FAF8F5] py-1.5 px-4 text-[10px] font-sans tracking-widest font-black uppercase"
                  >
                    Clear Filter
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredResponses.map((res) => (
                <div key={res.id} className="bg-[#FAF8F5] p-5 border border-black/10 space-y-3 relative overflow-hidden">
                  <div className="flex justify-between items-start font-mono text-[9px] text-slate-500">
                    <span className="font-bold text-black">{res.id}</span>
                    <span>{res.timestamp}</span>
                  </div>
                  
                  <div className="flex flex-wrap gap-1.5 font-sans">
                    <span className="text-[8px] bg-black text-white px-1.5 py-0.5 uppercase tracking-wider font-bold">
                      {res.votePreference} Alignment
                    </span>
                    <span className="text-[8px] bg-slate-200 text-slate-700 px-1.5 py-0.5 uppercase tracking-wider font-bold">
                      {res.ageGroup} / {res.gender}
                    </span>
                    <span className="text-[8px] bg-slate-200 text-slate-700 px-1.5 py-0.5 uppercase tracking-wider font-bold">
                      {res.occupation}
                    </span>
                  </div>

                  <div className="border-t border-black/5 pt-2">
                    <span className="text-[8px] text-slate-400 uppercase tracking-widest font-sans font-bold block mb-0.5">Primary Grievance</span>
                    <span className="text-xs font-serif font-semibold text-black">{res.primaryIssue}</span>
                  </div>

                  <p className="text-xs text-slate-600 font-serif italic leading-relaxed pt-1">
                    "{res.customFeedback}"
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
