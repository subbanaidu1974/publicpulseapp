/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo } from "react";
import { 
  TrendingUp, 
  TrendingDown, 
  AlertTriangle, 
  Search, 
  Sparkles, 
  ArrowUpDown, 
  Compass, 
  Eye, 
  Award, 
  Filter 
} from "lucide-react";
import { District, Constituency, SurveyResponse } from "../types";
import { DISTRICTS, CONSTITUENCIES } from "../data/staticData";

interface DistrictComparisonTableProps {
  onSelectDistrict: (districtId: string) => void;
  selectedDistrictId: string;
  surveyResponses: SurveyResponse[];
}

export default function DistrictComparisonTable({ 
  onSelectDistrict, 
  selectedDistrictId,
  surveyResponses
}: DistrictComparisonTableProps) {
  // State for search and filters
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRegion, setSelectedRegion] = useState<"All" | "Coastal" | "Rayalaseema" | "Uttarandhra">("All");
  const [selectedGrievance, setSelectedGrievance] = useState<string>("All");
  const [sortBy, setSortBy] = useState<"approval-desc" | "approval-asc" | "responses-desc" | "seats-desc">("approval-desc");

  // Dynamically compute real-time metrics for districts based on survey responses
  const processedDistricts = useMemo(() => {
    return DISTRICTS.map(d => {
      const districtACs = CONSTITUENCIES.filter(ac => ac.districtId === d.id);
      const totalACs = districtACs.length;
      
      const resps = surveyResponses.filter(r => r.districtId === d.id);
      const totalResponses = resps.length;
      
      // Calculate real-time average approval rating from responses or default to 0 (no live registrations yet)
      const avgApproval = totalResponses > 0 
        ? Math.round(resps.reduce((sum, r) => sum + (r.mlaRating + r.govtRating) / 2, 0) / totalResponses * 20)
        : 0;

      // Extract top grievance dynamically
      let topIssue = "None";
      let leadingParty = "—";
      if (totalResponses > 0) {
        const issueCounts: Record<string, number> = {};
        resps.forEach(r => {
          issueCounts[r.primaryIssue] = (issueCounts[r.primaryIssue] || 0) + 1;
        });
        const sorted = Object.entries(issueCounts).sort((a, b) => b[1] - a[1]);
        topIssue = sorted[0]?.[0] || "None";

        const partyCounts: Record<string, number> = {};
        resps.forEach(r => {
          partyCounts[r.votePreference] = (partyCounts[r.votePreference] || 0) + 1;
        });
        const sortedParties = Object.entries(partyCounts).sort((a, b) => b[1] - a[1]);
        leadingParty = sortedParties[0]?.[0] || "—";
      }

      return {
        ...d,
        totalResponses,
        avgApprovalRating: avgApproval,
        seatsCount: totalACs || d.seatsCount,
        topIssueSelected: topIssue,
        partyLeading: leadingParty
      };
    });
  }, [surveyResponses]); // Re-calculate when constituencies' approvalRating changes (e.g., after survey submission)

  // Extract all unique primary issues/grievances for the filter dropdown
  const uniqueGrievances = useMemo(() => {
    const issues = processedDistricts.map(d => d.topIssueSelected);
    return ["All", ...Array.from(new Set(issues))];
  }, [processedDistricts]);

  // Compute key highlights dynamically
  const highlights = useMemo(() => {
    if (processedDistricts.length === 0) return null;

    // 1. Highest Approval Rating
    const topPerforming = [...processedDistricts].sort((a, b) => b.avgApprovalRating - a.avgApprovalRating)[0];

    // 2. Lowest Approval Rating (Critical Area)
    const criticalArea = [...processedDistricts].sort((a, b) => a.avgApprovalRating - b.avgApprovalRating)[0];

    // 3. Highest Response Volume (Telemetry Leader)
    const responseLeader = [...processedDistricts].sort((a, b) => b.totalResponses - a.totalResponses)[0];

    return {
      topPerforming,
      criticalArea,
      responseLeader
    };
  }, [processedDistricts]);

  // Filter and sort districts
  const filteredAndSortedDistricts = useMemo(() => {
    let result = [...processedDistricts];

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(d => d.name.toLowerCase().includes(query));
    }

    // Region filter
    if (selectedRegion !== "All") {
      result = result.filter(d => d.region === selectedRegion);
    }

    // Grievance filter
    if (selectedGrievance !== "All") {
      result = result.filter(d => d.topIssueSelected === selectedGrievance);
    }

    // Sort order
    if (sortBy === "approval-desc") {
      result.sort((a, b) => b.avgApprovalRating - a.avgApprovalRating);
    } else if (sortBy === "approval-asc") {
      result.sort((a, b) => a.avgApprovalRating - b.avgApprovalRating);
    } else if (sortBy === "responses-desc") {
      result.sort((a, b) => b.totalResponses - a.totalResponses);
    } else if (sortBy === "seats-desc") {
      result.sort((a, b) => b.seatsCount - a.seatsCount);
    }

    return result;
  }, [processedDistricts, searchQuery, selectedRegion, selectedGrievance, sortBy]);

  // Helper to determine colored tag and background based on approval ratings
  const getApprovalStyles = (rating: number) => {
    if (rating === 0) {
      return {
        bg: "bg-slate-100 text-slate-500 border-slate-200/50",
        progress: "bg-slate-200",
        text: "text-slate-400",
        label: "No Data"
      };
    }
    if (rating >= 62) {
      return {
        bg: "bg-[#2E4A3F]/10 text-[#2E4A3F] border-[#2E4A3F]/20",
        progress: "bg-[#2E4A3F]",
        text: "text-[#2E4A3F]",
        label: "Optimal"
      };
    }
    if (rating >= 55) {
      return {
        bg: "bg-[#3F5B73]/10 text-[#3F5B73] border-[#3F5B73]/20",
        progress: "bg-[#3F5B73]",
        text: "text-[#3F5B73]",
        label: "Stable"
      };
    }
    if (rating >= 50) {
      return {
        bg: "bg-[#9E6F40]/10 text-[#9E6F40] border-[#9E6F40]/20",
        progress: "bg-[#9E6F40]",
        text: "text-[#9E6F40]",
        label: "Vulnerable"
      };
    }
    return {
      bg: "bg-[#8C3E3E]/10 text-[#8C3E3E] border-[#8C3E3E]/20",
      progress: "bg-[#8C3E3E]",
      text: "text-[#8C3E3E]",
      label: "Critical"
    };
  };

  // Helper for regional display tags
  const getRegionStyle = (region: string) => {
    switch(region) {
      case "Coastal":
        return "bg-slate-100 text-slate-800 border-slate-200";
      case "Rayalaseema":
        return "bg-amber-50 text-amber-900 border-amber-200/50";
      case "Uttarandhra":
        return "bg-cyan-50 text-cyan-950 border-cyan-200/50";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  // Helper for party leading style
  const getPartyStyle = (party: string) => {
    switch(party) {
      case "TDP":
        return "text-[#F1C40F] font-bold";
      case "YSRCP":
        return "text-[#27AE60] font-bold";
      case "JSP":
        return "text-[#E74C3C] font-bold";
      default:
        return "text-slate-500 font-bold";
    }
  };

  return (
    <div className="bg-white border border-black/15 p-6 sm:p-8 space-y-8" id="district-comparison-matrix">
      {/* Title & Description */}
      <div className="border-b border-black/10 pb-4">
        <span className="text-[9px] uppercase tracking-[0.25em] font-sans font-black text-slate-500 block">
          Andhra Pradesh Performance Index
        </span>
        <h3 className="text-xl font-serif italic text-black mt-1">
          Statewide District Performance Matrix
        </h3>
        <p className="text-xs text-slate-600 font-serif mt-1.5 max-w-3xl leading-relaxed">
          A dynamic comparative matrix of the 26 districts of Andhra Pradesh. Highlighted ratings represent the real-time aggregated MLA approval rating (derived dynamically from constituencies) mapped against their primary local grievances.
        </p>
      </div>

      {/* Highlights Bento Row */}
      {highlights && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Top Performer Card */}
          <div className="bg-[#FAF8F5] border border-black/10 p-5 flex flex-col justify-between hover:border-black/25 transition">
            <div className="space-y-1">
              <div className="flex items-center space-x-1.5 text-[#2E4A3F] font-sans">
                <Award className="w-4 h-4" />
                <span className="text-[9px] font-black uppercase tracking-wider">Top-Performing District</span>
              </div>
              <h4 className="text-base font-serif italic text-black pt-1">
                {highlights.topPerforming.name}
              </h4>
              <p className="text-[10px] font-serif text-slate-500">
                Region: {highlights.topPerforming.region}
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-black/5 flex justify-between items-end">
              <span className="text-[10px] font-sans font-bold text-slate-600">Avg Approval:</span>
              <span className="text-xl font-serif italic font-bold text-[#2E4A3F]">
                {highlights.topPerforming.avgApprovalRating}%
              </span>
            </div>
          </div>

          {/* Under Performing / Critical Card */}
          <div className="bg-[#FAF8F5] border border-black/10 p-5 flex flex-col justify-between hover:border-black/25 transition">
            <div className="space-y-1">
              <div className="flex items-center space-x-1.5 text-[#8C3E3E] font-sans">
                <AlertTriangle className="w-4 h-4" />
                <span className="text-[9px] font-black uppercase tracking-wider">Critical Grievance District</span>
              </div>
              <h4 className="text-base font-serif italic text-black pt-1">
                {highlights.criticalArea.name}
              </h4>
              <p className="text-[10px] font-serif text-slate-500 line-clamp-1">
                Top Issue: {highlights.criticalArea.topIssueSelected}
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-black/5 flex justify-between items-end">
              <span className="text-[10px] font-sans font-bold text-slate-600">Avg Approval:</span>
              <span className="text-xl font-serif italic font-bold text-[#8C3E3E]">
                {highlights.criticalArea.avgApprovalRating}%
              </span>
            </div>
          </div>

          {/* Response Telemetry Card */}
          <div className="bg-[#FAF8F5] border border-black/10 p-5 flex flex-col justify-between hover:border-black/25 transition">
            <div className="space-y-1">
              <div className="flex items-center space-x-1.5 text-[#3F5B73] font-sans">
                <Compass className="w-4 h-4" />
                <span className="text-[9px] font-black uppercase tracking-wider">Active Telemetry Volume</span>
              </div>
              <h4 className="text-base font-serif italic text-black pt-1">
                {highlights.responseLeader.name}
              </h4>
              <p className="text-[10px] font-serif text-slate-500">
                Total Local Input Weights
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-black/5 flex justify-between items-end">
              <span className="text-[10px] font-sans font-bold text-slate-600">Sample Count:</span>
              <span className="text-xl font-serif italic font-bold text-black">
                {highlights.responseLeader.totalResponses.toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Advanced Filter and Control Bar */}
      <div className="bg-[#FAF8F5] border border-black/10 p-4 space-y-4 font-sans text-xs">
        <div className="flex flex-col lg:flex-row gap-4 justify-between">
          
          {/* Left: Search & Grievance Dropdown */}
          <div className="flex flex-col sm:flex-row gap-3 flex-1">
            {/* Search Input */}
            <div className="relative flex-1">
              <input
                type="text"
                placeholder="Search district name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-white border border-black/15 focus:border-black p-2.5 pl-8 focus:outline-none text-xs text-black"
              />
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              {searchQuery && (
                <button 
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 font-bold text-slate-400 hover:text-black focus:outline-none text-base"
                >
                  &times;
                </button>
              )}
            </div>

            {/* Grievance Category Dropdown */}
            <div className="flex items-center space-x-2">
              <span className="text-[10px] uppercase font-bold text-slate-500 flex items-center space-x-1 whitespace-nowrap">
                <Filter className="w-3.5 h-3.5" />
                <span>Grievance:</span>
              </span>
              <select
                value={selectedGrievance}
                onChange={(e) => setSelectedGrievance(e.target.value)}
                className="bg-white border border-black/15 p-2 focus:outline-none focus:border-black max-w-[200px]"
              >
                {uniqueGrievances.map((issue) => (
                  <option key={issue} value={issue}>
                    {issue}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Right: Sort Settings */}
          <div className="flex items-center space-x-2">
            <span className="text-[10px] uppercase font-bold text-slate-500 flex items-center space-x-1 whitespace-nowrap">
              <ArrowUpDown className="w-3.5 h-3.5" />
              <span>Sort By:</span>
            </span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-white border border-black/15 p-2 focus:outline-none focus:border-black"
            >
              <option value="approval-desc">Highest Approval Rating</option>
              <option value="approval-asc">Lowest Approval Rating</option>
              <option value="responses-desc">Survey Response Volumes</option>
              <option value="seats-desc">Assembly Seat Shares</option>
            </select>
          </div>

        </div>

        {/* Region Filter Tabs */}
        <div className="flex flex-wrap items-center gap-1 border-t border-black/5 pt-3">
          <span className="text-[10px] uppercase font-bold text-slate-500 mr-2">Region Filter:</span>
          {(["All", "Coastal", "Rayalaseema", "Uttarandhra"] as const).map((reg) => (
            <button
              key={reg}
              onClick={() => setSelectedRegion(reg)}
              className={`px-3 py-1 font-sans font-bold text-[9px] uppercase tracking-wider transition ${
                selectedRegion === reg 
                  ? "bg-black text-white" 
                  : "bg-white text-black hover:bg-slate-100 border border-black/10"
              }`}
            >
              {reg === "All" ? "All Regions" : reg}
            </button>
          ))}
        </div>
      </div>

      {/* Grid / Table Content */}
      <div className="overflow-x-auto border border-black/10">
        <table className="w-full text-left border-collapse min-w-[750px]">
          <thead>
            <tr className="bg-[#FAF8F5] border-b border-black/10 text-[9px] text-slate-500 uppercase tracking-wider font-sans font-black">
              <th className="py-3 px-4 w-16 text-center">Rank</th>
              <th className="py-3 px-4">District / Region</th>
              <th className="py-3 px-4 text-center">Seats</th>
              <th className="py-3 px-4 text-center">Responses</th>
              <th className="py-3 px-4">Average Approval Rating</th>
              <th className="py-3 px-4">Primary Grievance Category</th>
              <th className="py-3 px-4 text-center">Lead Party</th>
              <th className="py-3 px-4 text-center">Focus Map</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/5 font-sans text-xs">
            {filteredAndSortedDistricts.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-500 font-serif">
                  <AlertTriangle className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                  <p className="font-bold text-black text-xs uppercase tracking-wider font-sans">No Districts Match Selection</p>
                  <p className="text-[11px] text-slate-500 mt-1 max-w-sm mx-auto leading-relaxed">
                    Adjust or reset your active text search, region selectors, or primary grievance filters to view results.
                  </p>
                </td>
              </tr>
            ) : (
              filteredAndSortedDistricts.map((dist, idx) => {
                const isSelected = dist.id === selectedDistrictId;
                const stats = getApprovalStyles(dist.avgApprovalRating);
                
                return (
                  <tr 
                    key={dist.id} 
                    className={`transition-colors hover:bg-[#FAF8F5]/40 ${
                      isSelected ? "bg-amber-50/35 font-medium" : ""
                    }`}
                  >
                    {/* Rank */}
                    <td className="py-4 px-4 text-center font-mono font-bold text-slate-500">
                      {idx + 1}
                    </td>

                    {/* District & Region */}
                    <td className="py-4 px-4">
                      <div className="flex items-center space-x-2">
                        <span className="font-serif italic text-black text-sm font-semibold block">
                          {dist.name}
                        </span>
                        <span className={`text-[8px] font-sans font-bold uppercase px-1.5 py-0.5 border rounded-none ${getRegionStyle(dist.region)}`}>
                          {dist.region}
                        </span>
                      </div>
                    </td>

                    {/* Seats */}
                    <td className="py-4 px-4 text-center font-mono font-semibold text-black">
                      {dist.seatsCount}
                    </td>

                    {/* Responses */}
                    <td className="py-4 px-4 text-center font-mono text-slate-600">
                      {dist.totalResponses.toLocaleString()}
                    </td>

                    {/* Approval Rating Indicator */}
                    <td className="py-4 px-4 w-52">
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center text-[10px]">
                          <span className={`font-mono font-bold ${stats.text}`}>
                            {dist.avgApprovalRating}%
                          </span>
                          <span className={`text-[8px] uppercase tracking-wider font-bold px-1 py-0.2 border rounded-none ${stats.bg}`}>
                            {stats.label}
                          </span>
                        </div>
                        {/* Elegant styled progress bar */}
                        <div className="w-full bg-slate-100 h-1.5 overflow-hidden">
                          <div 
                            className={`h-full transition-all duration-500 ${stats.progress}`}
                            style={{ width: `${dist.avgApprovalRating}%` }}
                          />
                        </div>
                      </div>
                    </td>

                    {/* Primary Grievance */}
                    <td className="py-4 px-4">
                      <div className="flex items-center space-x-1.5">
                        {dist.avgApprovalRating > 0 && dist.avgApprovalRating < 55 && (
                          <AlertTriangle className="w-3.5 h-3.5 text-[#8C3E3E] shrink-0" />
                        )}
                        <span className="font-serif italic text-slate-800 text-xs">
                          {dist.topIssueSelected === "None" ? "None Registered" : dist.topIssueSelected}
                        </span>
                      </div>
                    </td>

                    {/* Leading Party */}
                    <td className="py-4 px-4 text-center font-sans font-black text-xs">
                      <span className={getPartyStyle(dist.partyLeading)}>
                        {dist.partyLeading}
                      </span>
                    </td>

                    {/* Interactive Selector */}
                    <td className="py-4 px-4 text-center">
                      <button
                        onClick={() => onSelectDistrict(dist.id)}
                        className={`text-[8.5px] uppercase font-sans font-black tracking-widest py-1.5 px-3 transition cursor-pointer ${
                          isSelected 
                            ? "bg-black text-[#F9F7F2] ring-1 ring-black" 
                            : "border border-black/15 text-black hover:bg-black hover:text-[#F9F7F2] hover:border-black"
                        }`}
                      >
                        {isSelected ? "Focused" : "Focus"}
                      </button>
                    </td>

                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      
      {/* Quick Legend Info */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center text-[10px] text-slate-500 font-sans border-t border-black/5 pt-4 gap-2">
        <div className="flex flex-wrap items-center gap-4">
          <span className="font-bold text-slate-400 uppercase tracking-widest">Index Scale:</span>
          <div className="flex items-center space-x-1">
            <span className="w-2.5 h-2.5 bg-[#2E4A3F] inline-block" />
            <span>Optimal (&ge; 62%)</span>
          </div>
          <div className="flex items-center space-x-1">
            <span className="w-2.5 h-2.5 bg-[#3F5B73] inline-block" />
            <span>Stable (55-61%)</span>
          </div>
          <div className="flex items-center space-x-1">
            <span className="w-2.5 h-2.5 bg-[#9E6F40] inline-block" />
            <span>Vulnerable (50-54%)</span>
          </div>
          <div className="flex items-center space-x-1">
            <span className="w-2.5 h-2.5 bg-[#8C3E3E] inline-block" />
            <span>Critical (&lt; 50%)</span>
          </div>
        </div>
        <span className="italic font-serif">
          Click "Focus" to synchronize the geographic map and filter deep analytics below.
        </span>
      </div>

    </div>
  );
}
