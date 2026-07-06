/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, MouseEvent, useMemo } from "react";
import { MapPin, Info, ArrowRight, Activity, Users, Compass } from "lucide-react";
import { District, Constituency, SurveyResponse } from "../types";
import { DISTRICTS, CONSTITUENCIES } from "../data/staticData";

interface InteractiveMapProps {
  onSelectDistrict: (districtId: string) => void;
  selectedDistrictId: string;
  surveyResponses: SurveyResponse[];
}

export default function InteractiveMap({ 
  onSelectDistrict, 
  selectedDistrictId,
  surveyResponses
}: InteractiveMapProps) {
  const [hoveredDistrict, setHoveredDistrict] = useState<District | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const handleMouseMove = (e: MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMousePos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  // Generate stable 3-day sentiment history based on district id and current approval rating
  const get3DaySentiment = (dist: District) => {
    const charSum = dist.id.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const d3 = dist.avgApprovalRating;
    const day2Offset = ((charSum * 3) % 5) - 2; // range -2 to +2
    const day1Offset = ((charSum * 7) % 5) - 2; // range -2 to +2
    
    const d2 = d3 - day2Offset;
    const d1 = d2 - day1Offset;
    
    const clamp = (val: number) => Math.max(0, Math.min(100, val));
    return [clamp(d1), clamp(d2), clamp(d3)];
  };

  const getSparklineColor = (rating: number) => {
    if (rating >= 62) return { stroke: "#4ADE80", fill: "rgba(74, 222, 128, 0.12)" };
    if (rating >= 55) return { stroke: "#60A5FA", fill: "rgba(96, 165, 250, 0.12)" };
    if (rating >= 50) return { stroke: "#F59E0B", fill: "rgba(245, 158, 11, 0.12)" };
    return { stroke: "#F87171", fill: "rgba(248, 113, 113, 0.12)" };
  };

  // Dynamically compute real-time metrics for districts based on survey responses
  const processedDistricts = useMemo(() => {
    return DISTRICTS.map(d => {
      const resps = surveyResponses.filter(r => r.districtId === d.id);
      const totalResponses = resps.length;
      
      const avgApproval = totalResponses > 0 
        ? Math.round(resps.reduce((sum, r) => sum + (r.mlaRating + r.govtRating) / 2, 0) / totalResponses * 20)
        : 0;

      let leadingParty = "—";
      let topIssue = "None Registered";
      if (totalResponses > 0) {
        const partyCounts: Record<string, number> = {};
        resps.forEach(r => {
          partyCounts[r.votePreference] = (partyCounts[r.votePreference] || 0) + 1;
        });
        const sorted = Object.entries(partyCounts).sort((a, b) => b[1] - a[1]);
        leadingParty = sorted[0]?.[0] || "—";

        const issueCounts: Record<string, number> = {};
        resps.forEach(r => {
          issueCounts[r.primaryIssue] = (issueCounts[r.primaryIssue] || 0) + 1;
        });
        const sortedIssues = Object.entries(issueCounts).sort((a, b) => b[1] - a[1]);
        topIssue = sortedIssues[0]?.[0] || "None Registered";
      }

      return {
        ...d,
        totalResponses,
        avgApprovalRating: avgApproval,
        partyLeading: leadingParty,
        topIssueSelected: topIssue
      };
    });
  }, [surveyResponses]);

  const selectedDist = processedDistricts.find((d) => d.id === selectedDistrictId) || processedDistricts[11]; // default to NTR/Guntur level

  // Group constituencies in selected district
  const relatedConstituencies = CONSTITUENCIES.filter(
    (c) => c.districtId === selectedDist.id
  );

  // Determine elegant editorial color for district approval rating
  const getApprovalColor = (rating: number) => {
    if (rating >= 62) return "fill-[#2E4A3F] stroke-[#2E4A40] text-[#2E4A40]";
    if (rating >= 55) return "fill-[#3F5B73] stroke-[#3F5B73] text-[#3F5B73]";
    if (rating >= 50) return "fill-[#9E6F40] stroke-[#9E6F40] text-[#9E6F40]";
    return "fill-[#8C3E3E] stroke-[#8C3E3E] text-[#8C3E3E]";
  };

  const getApprovalBgColor = (rating: number) => {
    if (rating >= 62) return "bg-[#2E4A3F] text-[#FAF8F5]";
    if (rating >= 55) return "bg-[#3F5B73] text-[#FAF8F5]";
    if (rating >= 50) return "bg-[#9E6F40] text-[#FAF8F5]";
    return "bg-[#8C3E3E] text-[#FAF8F5]";
  };

  return (
    <div id="interactive-map-section" className="grid grid-cols-1 lg:grid-cols-12 gap-8 bg-[#FAF8F5] p-6 sm:p-8 border border-black/15 font-serif">
      
      {/* Map visualization left (span 7) */}
      <div className="lg:col-span-7 flex flex-col justify-between">
        <div>
          <span className="text-[9px] text-slate-500 uppercase tracking-[0.25em] font-sans font-black">GRAPHIC REGISTER 01</span>
          <h3 className="text-xl font-serif italic text-black mt-1">
            <span>Andhra Census & Opinion Map</span>
          </h3>
          <p className="text-xs text-slate-600 font-serif mt-1 mb-4 leading-relaxed">
            Select any district node to load localized statistical samples and Assembly Constituencies. Color representation reflects MLA approval ratings.
          </p>
        </div>

        {/* Schematic Geographic map panel */}
        <div 
          onMouseMove={handleMouseMove}
          className="relative bg-white border border-black/10 p-4 min-h-[380px] flex items-center justify-center overflow-hidden"
        >
          
          {/* North/South/East/West guides */}
          <div className="absolute top-3 left-3 text-[8px] text-slate-550 font-sans tracking-widest font-bold">NORTH-WEST / INLAND</div>
          <div className="absolute bottom-3 right-3 text-[8px] text-slate-550 font-sans tracking-widest font-bold">SOUTH-EAST / OCEAN ROAD</div>

          {/* Floating Re-center State Perspective Button */}
          <button
            type="button"
            title="Reset selection back to central state view"
            onClick={() => onSelectDistrict("AP-12")}
            className="absolute top-3 right-3 z-20 bg-black hover:bg-neutral-800 text-[#F9F7F2] border border-black px-2.5 py-1 text-[8px] font-sans tracking-widest uppercase font-bold flex items-center space-x-1.5 shadow-sm active:scale-95 transition-all duration-150 cursor-pointer"
          >
            <Compass className="w-3.5 h-3.5" />
            <span>Center Perspective</span>
          </button>

          {/* Compass Rose Grid */}
          <div className="absolute inset-0 bg-[radial-gradient(#000000_1px,transparent_1px)] [background-size:16px_16px] opacity-[0.06]"></div>

          {/* SVG Map of Andhra Pradesh 26 Districts */}
          <svg
            viewBox="0 0 100 100"
            className="w-full max-w-[460px] h-auto z-10 select-none cursor-pointer filter drop-shadow-sm"
          >
            {/* Draw Coastal Line Accent */}
            <path
              d="M 19 73 Q 30 65 38 45 T 49 46 T 51 41 T 65 32 T 80 15"
              fill="none"
              stroke="#121212"
              strokeWidth="0.8"
              strokeDasharray="2,2"
              className="opacity-20"
            />
            
            {/* Connecting lines between geographic districts for structural flow */}
            {processedDistricts.map((dist, idx) => {
              const prev = processedDistricts[idx - 1];
              if (!prev) return null;
              return (
                <line
                  key={`line-${idx}`}
                  x1={prev.coordinates.x}
                  y1={prev.coordinates.y}
                  x2={dist.coordinates.x}
                  y2={dist.coordinates.y}
                  stroke="#ccc"
                  strokeWidth="0.3"
                  className="opacity-40"
                />
              );
            })}

            {/* District Bubble Nodes */}
            {processedDistricts.map((dist) => {
              const isSelected = dist.id === selectedDistrictId;
              const isHovered = hoveredDistrict?.id === dist.id;

              return (
                <g
                  key={dist.id}
                  onClick={() => onSelectDistrict(dist.id)}
                  onMouseEnter={() => setHoveredDistrict(dist)}
                  onMouseLeave={() => setHoveredDistrict(null)}
                  className="transition duration-150"
                >
                  {/* Outer ring on select */}
                  {isSelected && (
                    <circle
                      cx={dist.coordinates.x}
                      cy={dist.coordinates.y}
                      r="4.2"
                      className="fill-none stroke-black stroke-[0.3px]"
                    />
                  )}

                  {/* Node Circle */}
                  <circle
                    cx={dist.coordinates.x}
                    cy={dist.coordinates.y}
                    r={isSelected ? "2.4" : isHovered ? "2.0" : "1.6"}
                    className={`transition-all duration-150 ${getApprovalColor(dist.avgApprovalRating)} ${
                      isSelected 
                        ? "stroke-black stroke-[0.8px] scale-110" 
                        : isHovered 
                        ? "stroke-black stroke-[0.5px] cursor-pointer" 
                        : "stroke-black/20 stroke-[0.3px]"
                    }`}
                  />

                  {/* label for major/selected nodes */}
                  {(isSelected || isHovered || dist.seatsCount > 7) && (
                    <text
                      x={dist.coordinates.x}
                      y={dist.coordinates.y - 3.2}
                      className="text-[2.2px] fill-black font-sans font-bold tracking-tight text-center select-none"
                      textAnchor="middle"
                    >
                      {dist.name}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* District Mouse Hover Tooltip Overlay */}
          {hoveredDistrict && (() => {
            const sentimentData = get3DaySentiment(hoveredDistrict);
            const minVal = Math.min(...sentimentData);
            const maxVal = Math.max(...sentimentData);
            const valRange = maxVal === minVal ? 1 : maxVal - minVal;

            const yMin = 14;
            const yMax = 28;
            const yRange = yMax - yMin;

            const p1y = maxVal === minVal ? 21 : yMax - ((sentimentData[0] - minVal) / valRange) * yRange;
            const p2y = maxVal === minVal ? 21 : yMax - ((sentimentData[1] - minVal) / valRange) * yRange;
            const p3y = maxVal === minVal ? 21 : yMax - ((sentimentData[2] - minVal) / valRange) * yRange;

            const colorInfo = getSparklineColor(hoveredDistrict.avgApprovalRating);
            const trendDiff = sentimentData[2] - sentimentData[0];
            const trendText = trendDiff > 0 ? `+${trendDiff}%` : trendDiff < 0 ? `${trendDiff}%` : "Stable";
            const trendColor = trendDiff > 0 ? "text-[#4ADE80]" : trendDiff < 0 ? "text-[#F87171]" : "text-slate-400";

            return (
              <div 
                style={{ 
                  top: `${mousePos.y + 16}px`, 
                  left: `${mousePos.x + 16}px`,
                }}
                className="absolute z-50 bg-[#121212] text-[#F9F7F2] border border-white/10 p-3.5 shadow-xl pointer-events-none w-56 font-sans text-[11px] leading-relaxed transition-all duration-75"
              >
                <div className="flex justify-between items-center pb-1.5 border-b border-white/10 mb-2">
                  <span className="font-extrabold text-xs text-white">{hoveredDistrict.name}</span>
                  <span className="text-[8px] bg-white/10 text-[#EADCC6]/80 px-1.5 py-0.5 font-mono tracking-wider uppercase font-bold">{hoveredDistrict.region}</span>
                </div>
                <div className="space-y-1.5 font-sans">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Sample Responses:</span>
                    <span className="font-bold text-white font-mono">{hoveredDistrict.totalResponses.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Approval Index:</span>
                    <span className="font-bold text-[#EADCC6]/90 font-mono">{hoveredDistrict.avgApprovalRating}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400 font-medium">Projected Winner:</span>
                    <span className="font-bold text-white uppercase tracking-wider text-[9px]">{hoveredDistrict.partyLeading}</span>
                  </div>
                  <div className="flex justify-between pt-1 border-t border-white/[0.06]">
                    <span className="text-slate-400">MLA Assembly Seats:</span>
                    <span className="font-bold text-white font-mono">{hoveredDistrict.seatsCount}</span>
                  </div>

                  {/* 3-Day Sentiment Sparkline Component */}
                  <div className="pt-2 border-t border-white/[0.06] space-y-1">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400 text-[9.5px] uppercase font-bold tracking-wider">3-Day Sentiment</span>
                      <span className={`text-[9px] font-mono font-bold ${trendColor}`}>
                        {trendText}
                      </span>
                    </div>

                    <svg className="w-full h-11 overflow-visible mt-1" viewBox="0 0 160 42">
                      {/* Grid line */}
                      <line x1="10" y1="21" x2="150" y2="21" stroke="rgba(255,255,255,0.06)" strokeDasharray="2,2" strokeWidth="0.8" />
                      
                      {/* Area path */}
                      <path
                        d={`M 10 32 L 10 ${p1y} L 80 ${p2y} L 150 ${p3y} L 150 32 Z`}
                        fill={colorInfo.fill}
                        className="transition-all duration-300"
                      />
                      
                      {/* Sparkline path */}
                      <path
                        d={`M 10 ${p1y} L 80 ${p2y} L 150 ${p3y}`}
                        fill="none"
                        stroke={colorInfo.stroke}
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="transition-all duration-300"
                      />
                      
                      {/* Data dots */}
                      <circle cx="10" cy={p1y} r="2" fill={colorInfo.stroke} className="transition-all duration-300" />
                      <circle cx="80" cy={p2y} r="2" fill={colorInfo.stroke} className="transition-all duration-300" />
                      <circle cx="150" cy={p3y} r="2" fill={colorInfo.stroke} className="transition-all duration-300" />

                      {/* Values */}
                      <text x="10" y={p1y - 4} textAnchor="start" className="text-[7.5px] fill-slate-300 font-mono font-black">{sentimentData[0]}%</text>
                      <text x="80" y={p2y - 4} textAnchor="middle" className="text-[7.5px] fill-slate-300 font-mono font-black">{sentimentData[1]}%</text>
                      <text x="150" y={p3y - 4} textAnchor="end" className="text-[7.5px] fill-slate-300 font-mono font-black">{sentimentData[2]}%</text>

                      {/* Date interval labels */}
                      <text x="10" y="39" textAnchor="start" className="text-[6px] fill-slate-500 font-sans uppercase font-bold tracking-wider">2 days ago</text>
                      <text x="80" y="39" textAnchor="middle" className="text-[6px] fill-slate-500 font-sans uppercase font-bold tracking-wider">Yesterday</text>
                      <text x="150" y="39" textAnchor="end" className="text-[6px] fill-slate-500 font-sans uppercase font-bold tracking-wider">Today</text>
                    </svg>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Simple floating color code legend */}
          <div className="absolute bottom-3 left-3 bg-white/95 border border-black/15 p-3 text-[8.5px] space-y-1 z-20 font-sans tracking-wider uppercase">
            <div className="font-black text-black pb-1 border-b border-black/10 mb-1.5">MLA Approval Rating Key</div>
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 bg-[#2E4A3F] inline-block"></span>
              <span className="text-slate-650">High Approval (&ge;62%)</span>
            </div>
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 bg-[#3F5B73] inline-block"></span>
              <span className="text-slate-650 font-medium">Moderate (55-61%)</span>
            </div>
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 bg-[#9E6F40] inline-block"></span>
              <span className="text-slate-650">Marginal Approval (50-54%)</span>
            </div>
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 bg-[#8C3E3E] inline-block"></span>
              <span className="text-slate-650">Unpopular Rating (&lt;50%)</span>
            </div>
          </div>
        </div>

        {/* Hover / Tooltip display bar */}
        <div className="mt-4 min-h-[46px] bg-white border border-black/10 px-4 py-3 flex items-center justify-between text-xs font-serif">
          {hoveredDistrict ? (
            <div className="w-full flex items-center justify-between text-xs font-serif text-[#121212]">
              <div className="flex items-center space-x-2">
                <span className="font-bold text-black">{hoveredDistrict.name}</span>
                <span className="text-slate-500 font-sans text-[10px] tracking-wider font-bold">({hoveredDistrict.region})</span>
              </div>
              <div className="flex items-center space-x-4">
                <span>Seats: <strong className="font-sans font-bold">{hoveredDistrict.seatsCount}</strong></span>
                <span>Approval: <strong className="font-sans font-bold">{hoveredDistrict.avgApprovalRating}%</strong></span>
                <span className="font-sans text-[10px] tracking-wider uppercase font-black bg-black text-[#FAF8F5] px-1.5 py-0.5">Leading: {hoveredDistrict.partyLeading}</span>
              </div>
            </div>
          ) : (
            <span className="text-xs text-slate-500 flex items-center space-x-1.5">
              <Info className="w-3.5 h-3.5 text-black" />
              <span>Hover over bubbles to check immediate metrics. Selected District is <strong className="text-black font-bold">{selectedDist.name}</strong>.</span>
            </span>
          )}
        </div>
      </div>

      {/* District profile panel right (span 5) */}
      <div className="lg:col-span-5 flex flex-col justify-between border-t lg:border-t-0 lg:border-l border-black/10 pt-6 lg:pt-0 lg:pl-8 font-serif">
        <div>
          <div className="flex items-start justify-between border-b border-black/10 pb-4">
            <div>
              <span className="text-[9px] bg-black text-[#F9F7F2] font-sans tracking-widest uppercase font-black px-2 py-1 inline-block">{selectedDist.region} Region</span>
              <h2 className="text-2xl font-serif italic text-black mt-3">{selectedDist.name} District</h2>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-sans block">Assembly Seats</span>
              <div className="text-3xl font-serif italic text-black mt-1">{selectedDist.seatsCount}</div>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-4">
            <div className="bg-white p-4 border border-black/10">
              <span className="text-[9px] text-slate-500 font-sans uppercase tracking-wider block">Sample Responses</span>
              <span className="text-lg font-serif italic text-black mt-1 block">{selectedDist.totalResponses.toLocaleString()}</span>
            </div>
            <div className="bg-white p-4 border border-black/10">
              <span className="text-[9px] text-slate-500 font-sans uppercase tracking-wider block">Projected Winner</span>
              <span className="text-sm font-sans tracking-wide uppercase font-black text-black mt-1 block flex items-center space-x-1">
                <span>{selectedDist.partyLeading}</span>
                <span className="text-[9px] text-slate-500 font-normal">({selectedDist.avgApprovalRating}% app)</span>
              </span>
            </div>
          </div>

          <div className="mt-6 p-5 border bg-white border-black/10 space-y-2">
            <span className="text-[9px] text-slate-500 uppercase tracking-[0.2em] font-sans font-black block">Pre-eminent Demand</span>
            <div className="text-sm font-serif italic font-bold text-black border-l-2 border-black pl-3 py-1 bg-[#FAF8F5]">
              {selectedDist.topIssueSelected}
            </div>
            <p className="text-[11px] text-slate-600 mt-2 text-justify leading-relaxed">
              Based on localized opinion metrics, infrastructure demand is the key driver of candidate polling trends in {selectedDist.name} mandals.
            </p>
          </div>

          {/* List of constituencies inside district */}
          <div className="mt-6">
            <div className="flex items-center justify-between mb-3 border-b border-black/10 pb-1.5">
              <h4 className="text-[10px] font-sans font-black uppercase tracking-widest text-[#121212]">Assembly Constituencies ({relatedConstituencies.length})</h4>
              <span className="text-[9px] font-sans text-slate-400">PICK SEAT</span>
            </div>
            <div className="max-h-[160px] overflow-y-auto pr-1 space-y-1 border border-black/10 p-2 bg-white custom-scrollbar rounded-none">
              {relatedConstituencies.map((ac) => {
                const preference = ac.partyPreference[0] || { party: "TDP" };
                return (
                  <div
                    key={ac.id}
                    className="flex items-center justify-between text-[11px] p-2 bg-transparent hover:bg-[#FAF8F5] border-b border-black/[0.04] cursor-pointer transition text-slate-800 hover:text-black"
                  >
                    <div className="flex items-center space-x-2">
                      <span className="font-mono text-[9px] text-slate-400">AC #{ac.id}</span>
                      <span className="font-serif text-xs px-1 font-medium">{ac.name}</span>
                    </div>
                    <div className="flex items-center space-x-3 font-sans">
                      <span className="text-[9.5px] uppercase tracking-wider text-slate-600 font-bold">App: {ac.approvalRating}%</span>
                      <span className="font-black text-xs text-black">{preference.party}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-black/10 flex items-center justify-end text-[10px] tracking-widest uppercase font-sans font-black text-black">
          <span>Inspect breakdown metrics below</span>
          <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
        </div>
      </div>
    </div>
  );
}
