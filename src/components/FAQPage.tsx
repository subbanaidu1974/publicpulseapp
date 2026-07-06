/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from "react";
import { HelpCircle, ChevronDown, ChevronUp, Database, Sliders, Activity, ShieldCheck, Scale, Award } from "lucide-react";

interface FAQItem {
  id: string;
  category: "collection" | "weights" | "approval" | "security" | "methodology";
  question: string;
  answer: string;
  detailedPoints?: string[];
  formula?: string;
  formulaLegend?: { key: string; value: string }[];
}

export default function FAQPage() {
  const [openId, setOpenId] = useState<string | null>("collection-1");
  const [activeCategory, setActiveCategory] = useState<string>("all");

  const faqs: FAQItem[] = [
    {
      id: "collection-1",
      category: "collection",
      question: "How is the survey data collected across Andhra Pradesh's 175 constituencies?",
      answer: "Our fieldwork network employs randomized stratified household sampling and localized digital poll inputs across all 26 districts and 175 Assembly Constituencies. Trained field coordinators conduct structured door-to-door interviews with residents to record ground realities. To ensure the utmost integrity, a random 10% subset of all completed registries is automatically audited via telephone verification call-backs by central regional observers.",
      detailedPoints: [
        "In-person enumerations conducted on-ground across urban, rural, and tribal panchayat corridors.",
        "Programmatic geographic bounding tags to ensure coordinators are physically present in the targeted mandal/village.",
        "Rigorous verification calls with respondents to cross-validate survey answers and identify anomalous records."
      ]
    },
    {
      id: "weights-1",
      category: "weights",
      question: "How are survey metrics weighted to reflect true demographic balances?",
      answer: "Raw digital polling is inherently subject to self-selection bias and regional density skews. To resolve this, People Pulse uses a Demographic Weighting Model (the 'raking' algorithm). We balance all raw data inputs against Census 2011 indicators and subsequent public projection updates.",
      detailedPoints: [
        "Gender Distribution: Calibrating responses to match the regional female-to-male ratios.",
        "Age Strata: Balancing cohorts (18-25, 26-45, 46-60, 60+) to prevent over-representing any age group.",
        "Rural vs. Urban Census blocks: Weighting village development indicators relative to major municipality counts.",
        "Occupational Class: Ensuring micro-segments like handloom weavers, agricultural labor, and students have equitable voices."
      ]
    },
    {
      id: "approval-1",
      category: "approval",
      question: "How is the 'Approval Index' calculated?",
      answer: "The Approval Index is a composite score (ranging from 0% to 100%) reflecting local satisfaction with sitting Members of the Legislative Assembly (MLAs) and overall governance quality. It is calculated by aggregating multiple prioritized indicators with specific, predefined weights.",
      formula: "Index = (w1 * MLA_Rating) + (w2 * Infra_Score) + (w3 * Welfare_Rating) + (w4 * Administration_Rating)",
      formulaLegend: [
        { key: "w1 (40%)", value: "MLA Performance Assessment (Sitting MLA's popularity and accessibility)." },
        { key: "w2 (25%)", value: "Infrastructure Score (satisfaction with drinking water, roads, power supply, and sanitation)." },
        { key: "w3 (20%)", value: "Welfare & Benefits Delivery (speed and transparency of state welfare schemes)." },
        { key: "w4 (15%)", value: "Local Administration Quality (public grievance redressal speed and civic services)." }
      ],
      detailedPoints: [
        "MLA_Rating is derived of responsive Likert scale inputs (strongly approve to strongly disapprove).",
        "Welfare delivery represents public responses toward cash transfers, ration reliability, and health support eligibility.",
        "Unresolved local grievances are treated as penalty offsets, subtracting up to 5% from final index values if specific issues exceed critical public thresholds."
      ]
    },
    {
      id: "security-1",
      category: "security",
      question: "How do you protect the opinion models from duplicate or fraudulent entries?",
      answer: "We deploy multi-tier security and validation gates on incoming survey telemetry to preserve data integrity and prevent coordinated manipulation or spam.",
      detailedPoints: [
        "Device Fingerprinting: Restricting one submitted poll per physical device identity over rolling monthly boundaries.",
        "OTP Validation: Restricting random public inputs to verified mobile numbers.",
        "Spatial Logic Verifications: Flagging entries where geographic tags do not align with selected constituency boundaries.",
        "Voluntary Code of Conduct Audit: Every volunteer coordinator agrees under signed oath to record only authentic voter responses without bias."
      ]
    },
    {
      id: "methodology-1",
      category: "methodology",
      question: "What is the statistical significance and confidence interval of the data?",
      answer: "All reports and dashboard charts generated by People Pulse comply with internationally accepted polling and sociological research standards, bringing rigorous accountability to state polls.",
      detailedPoints: [
        "Confidence Interval: 95% across statewide consolidations.",
        "Margin of Error: ±1.8% at the state-level; between ±2.5% and ±4.0% at individual district-level samples.",
        "Refresh Rate: Data models are automatically updated daily at 22:00 IST as field coordinators submit verified survey batches."
      ]
    }
  ];

  const categories = [
    { id: "all", label: "All Areas", icon: HelpCircle },
    { id: "collection", label: "Data Collection", icon: Database },
    { id: "weights", label: "Demographic Weighting", icon: Sliders },
    { id: "approval", label: "Approval Index", icon: Scale },
    { id: "security", label: "Data Integrity", icon: ShieldCheck },
    { id: "methodology", label: "Statistical Significance", icon: Activity }
  ];

  const filteredFaqs = activeCategory === "all" 
    ? faqs 
    : faqs.filter(faq => faq.category === activeCategory);

  const toggleOpen = (id: string) => {
    setOpenId(openId === id ? null : id);
  };

  return (
    <div className="space-y-10 animate-fade-in font-serif">
      {/* Page Header */}
      <div className="bg-[#FAF8F5] dark:bg-zinc-900/40 p-8 border-y border-black/40">
        <span className="text-[9.5px] uppercase tracking-[0.25em] font-sans font-black text-slate-500 block mb-1">
          METHODOLOGY REGISTER &bull; APPENDIX A
        </span>
        <h2 className="text-3xl font-serif italic text-black dark:text-white">
          Frequently Answered Questions (FAQs)
        </h2>
        <p className="text-xs text-slate-600 dark:text-slate-400 mt-2 max-w-2xl leading-relaxed">
          Review details concerning our public opinion dataset calculations, our demographic weighting engine,
          the composite Approval Index formula, and the physical security protocols deployed by our volunteer field networks.
        </p>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        
        {/* Navigation Sidebar */}
        <div className="lg:col-span-1 space-y-2">
          <span className="text-[8.5px] font-sans font-black tracking-widest text-[#121212]/80 dark:text-neutral-300 block uppercase mb-4 px-2">
            Filter by Categories
          </span>
          <div className="flex flex-wrap lg:flex-col gap-1.5">
            {categories.map((cat) => {
              const Icon = cat.icon;
              const isActive = activeCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => {
                    setActiveCategory(cat.id);
                    // Open first item of selected category
                    const matched = faqs.find(f => f.category === cat.id || cat.id === "all");
                    if (matched) setOpenId(matched.id);
                  }}
                  className={`w-full text-left px-4 py-3 text-[10px] sm:text-[11px] font-sans tracking-wider uppercase font-bold flex items-center space-x-3 transition-all duration-150 border cursor-pointer ${
                    isActive 
                      ? "bg-black text-[#F9F7F2] border-black dark:bg-white dark:text-black dark:border-white" 
                      : "bg-[#FAF8F5] text-slate-700 hover:text-black hover:bg-neutral-50 dark:bg-zinc-800/40 dark:text-slate-300 dark:border-white/5 hover:dark:bg-zinc-800"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0 transition-transform duration-150" />
                  <span>{cat.label}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-8 bg-[#E5E2D9]/20 dark:bg-zinc-900/20 p-5 border border-dashed border-black/10 dark:border-white/10 hidden lg:block">
            <h5 className="font-sans font-black text-[9px] tracking-widest text-black dark:text-white uppercase mb-2">
              Auditor / Analyst Note
            </h5>
            <p className="text-[10.5px] leading-relaxed text-slate-500 dark:text-slate-400">
              Our complete sample log contains no personal identifying information (PII). In compliance with research ethics codes, all voter contacts are discarded after spatial validation.
            </p>
          </div>
        </div>

        {/* FAQ Content Area */}
        <div className="lg:col-span-3 space-y-4">
          <div className="border-b border-black/15 pb-2 mb-4">
            <span className="text-[9px] font-sans font-bold tracking-widest text-slate-500 uppercase block">
              Showing {filteredFaqs.length} Related Inquiries
            </span>
          </div>

          <div className="space-y-4">
            {filteredFaqs.map((faq, index) => {
              const isOpen = openId === faq.id;
              return (
                <div 
                  key={faq.id} 
                  className={`border transition-all duration-300 ${
                    isOpen 
                      ? "border-black dark:border-white bg-[#FAF8F5] dark:bg-zinc-900/20" 
                      : "border-black/10 dark:border-white/10 hover:border-black/30 bg-transparent"
                  }`}
                >
                  {/* Question Title Header */}
                  <button
                    type="button"
                    onClick={() => toggleOpen(faq.id)}
                    className="w-full text-left px-5 py-4.5 flex items-start justify-between space-x-4 cursor-pointer"
                  >
                    <div className="flex items-start space-x-3.5">
                      <span className="text-[10px] font-mono font-bold text-slate-400 bg-black/5 dark:bg-white/5 px-2 py-0.5 rounded-sm relative top-0.5 shrink-0">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <h3 className="text-sm sm:text-base font-serif font-black text-black dark:text-white tracking-tight leading-snug">
                        {faq.question}
                      </h3>
                    </div>
                    <span className="text-slate-500 bg-transparent shrink-0 mt-1">
                      {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </span>
                  </button>

                  {/* Accordion Expandable Panel */}
                  {isOpen && (
                    <div className="px-5 pb-6 pt-1 space-y-4 text-xs sm:text-[13px] leading-relaxed text-slate-700 dark:text-slate-300 font-serif border-t border-black/5 dark:border-white/5 animate-fade-in">
                      <p className="text-justify leading-relaxed">
                        {faq.answer}
                      </p>

                      {/* Mathematical formulas */}
                      {faq.formula && (
                        <div className="bg-[#121212] text-[#F9F7F2] p-4.5 font-mono text-[10.5px] border-l-4 border-[#EADCC6]/80 my-4 space-y-2 overflow-x-auto select-all">
                          <div className="text-[#888888] font-sans tracking-widest text-[8px] uppercase font-bold mb-1">
                            COMPOSITE FORMULATION
                          </div>
                          <code className="block font-semibold text-amber-100 font-mono py-1">
                            {faq.formula}
                          </code>
                          {faq.formulaLegend && (
                            <div className="mt-3.5 pt-3 border-t border-white/10 space-y-2 text-[9.5px]">
                              <span className="block font-sans text-[8px] tracking-widest text-slate-400 uppercase font-black">
                                Weight Assignment Table
                              </span>
                              {faq.formulaLegend.map((legend, lid) => (
                                <div key={lid} className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-2">
                                  <span className="text-[#EADCC6] font-bold min-w-[70px] shrink-0 font-mono">
                                    {legend.key}:
                                  </span>
                                  <span className="text-slate-300 font-sans">{legend.value}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Detailed Points checklist */}
                      {faq.detailedPoints && faq.detailedPoints.length > 0 && (
                        <div className="space-y-2.5 pt-2">
                          <span className="block font-sans font-black tracking-wider text-[8.5px] uppercase text-black dark:text-white">
                            Key Structural Subkeys & Rules
                          </span>
                          <ul className="space-y-2 pl-1.5 text-[12px]">
                            {faq.detailedPoints.map((point, pIdx) => (
                              <li key={pIdx} className="flex items-start space-x-2.5">
                                <span className="text-green-600 dark:text-green-400 text-[10px] select-none shrink-0 relative top-[2px]">
                                  □
                                </span>
                                <span className="text-slate-650 dark:text-slate-300 text-justify font-serif">
                                  {point}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}
