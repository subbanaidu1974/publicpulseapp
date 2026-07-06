/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { District, Constituency, SurveyResponse, ReportItem, NewsCard, Testimonial, NewsVideo } from "../types";

// High-profile key state leaders for survey preferences
export const LEADERS = [
  "Nara Chandrababu Naidu",
  "Y. S. Jagan Mohan Reddy",
  "Pawan Kalyan",
  "Nara Lokesh",
  "YS Sharmila",
  "Pawan Kalyan (JSP)",
  "None of the Above (NOTA)"
];

export const PARTIES = [
  { code: "TDP", name: "Telugu Desam Party", color: "bg-amber-500", border: "border-amber-500", text: "text-amber-500", hex: "#F59E0B" },
  { code: "YSRCP", name: "YSR Congress Party", color: "bg-blue-600", border: "border-blue-600", text: "text-blue-600", hex: "#2563EB" },
  { code: "JSP", name: "Jana Sena Party", color: "bg-red-500", border: "border-red-500", text: "text-red-500", hex: "#EF4444" },
  { code: "INC", name: "Indian National Congress", color: "bg-green-600", border: "border-green-600", text: "text-green-600", hex: "#16A34A" },
  { code: "BJP", name: "Bharatiya Janata Party", color: "bg-orange-500", border: "border-orange-500", text: "text-orange-500", hex: "#F97316" },
  { code: "OTH", name: "Others / Independent", color: "bg-slate-500", border: "border-slate-500", text: "text-slate-500", hex: "#64748B" }
];

// Curated 26 Districts of Andhra Pradesh with geometric positions (for a beautiful visual map)
export const DISTRICTS: District[] = [
  // Uttarandhra (North Coast)
  { id: "AP-01", name: "Srikakulam", region: "Uttarandhra", constituencyIds: [], population: 2704148, totalResponses: 1980, avgApprovalRating: 61, topIssueSelected: "Employment & Migration", partyLeading: "TDP", seatsCount: 10, coordinates: { x: 80, y: 15 } },
  { id: "AP-02", name: "Parvathipuram Manyam", region: "Uttarandhra", constituencyIds: [], population: 924000, totalResponses: 1120, avgApprovalRating: 54, topIssueSelected: "Tribal Rights & Roads", partyLeading: "TDP", seatsCount: 4, coordinates: { x: 74, y: 19 } },
  { id: "AP-03", name: "Vizianagaram", region: "Uttarandhra", constituencyIds: [], population: 2310243, totalResponses: 1850, avgApprovalRating: 58, topIssueSelected: "Drinking Water", partyLeading: "TDP", seatsCount: 9, coordinates: { x: 70, y: 25 } },
  { id: "AP-04", name: "Visakhapatnam", region: "Uttarandhra", constituencyIds: [], population: 2261000, totalResponses: 3450, avgApprovalRating: 64, topIssueSelected: "Industrial Pollution", partyLeading: "JSP", seatsCount: 6, coordinates: { x: 65, y: 32 } },
  { id: "AP-05", name: "Anakapalli", region: "Uttarandhra", constituencyIds: [], population: 1720000, totalResponses: 1650, avgApprovalRating: 59, topIssueSelected: "Sugarcane MSP & Industry", partyLeading: "TDP", seatsCount: 7, coordinates: { x: 58, y: 35 } },
  { id: "AP-06", name: "Alluri Sitharama Raju", region: "Uttarandhra", constituencyIds: [], population: 954000, totalResponses: 1080, avgApprovalRating: 52, topIssueSelected: "Healthcare Access", partyLeading: "YSRCP", seatsCount: 3, coordinates: { x: 55, y: 22 } },
  
  // Coastal Andhra (Centrals)
  { id: "AP-07", name: "Kakinada", region: "Coastal", constituencyIds: [], population: 2154000, totalResponses: 2100, avgApprovalRating: 66, topIssueSelected: "Fisheries Development", partyLeading: "JSP", seatsCount: 7, coordinates: { x: 51, y: 41 } },
  { id: "AP-08", name: "East Godavari", region: "Coastal", constituencyIds: [], population: 1910000, totalResponses: 1950, avgApprovalRating: 62, topIssueSelected: "Agricultural Input Costs", partyLeading: "TDP", seatsCount: 7, coordinates: { x: 47, y: 38 } },
  { id: "AP-09", name: "Dr. B.R. Ambedkar Konaseema", region: "Coastal", constituencyIds: [], population: 1719000, totalResponses: 1810, avgApprovalRating: 60, topIssueSelected: "Coconut Farmers Welfare", partyLeading: "JSP", seatsCount: 7, coordinates: { x: 49, y: 46 } },
  { id: "AP-10", name: "Eluru", region: "Coastal", constituencyIds: [], population: 2003000, totalResponses: 1880, avgApprovalRating: 57, topIssueSelected: "Aquaculture & Drainage", partyLeading: "TDP", seatsCount: 7, coordinates: { x: 42, y: 36 } },
  { id: "AP-11", name: "West Godavari", region: "Coastal", constituencyIds: [], population: 1780000, totalResponses: 1720, avgApprovalRating: 65, topIssueSelected: "Crop Insurance & Roads", partyLeading: "TDP", seatsCount: 7, coordinates: { x: 44, y: 44 } },
  { id: "AP-12", name: "NTR", region: "Coastal", constituencyIds: [], population: 2219000, totalResponses: 2800, avgApprovalRating: 68, topIssueSelected: "Urban Infrastructure", partyLeading: "TDP", seatsCount: 7, coordinates: { x: 34, y: 37 } },
  { id: "AP-13", name: "Krishna", region: "Coastal", constituencyIds: [], population: 1754000, totalResponses: 1910, avgApprovalRating: 61, topIssueSelected: "Port Development & Jobs", partyLeading: "TDP", seatsCount: 7, coordinates: { x: 38, y: 45 } },
  { id: "AP-14", name: "Guntur", region: "Coastal", constituencyIds: [], population: 2091000, totalResponses: 2950, avgApprovalRating: 67, topIssueSelected: "Urban Traffic & Roads", partyLeading: "TDP", seatsCount: 7, coordinates: { x: 29, y: 47 } },
  { id: "AP-15", name: "Palnadu", region: "Coastal", constituencyIds: [], population: 2042000, totalResponses: 1790, avgApprovalRating: 52, topIssueSelected: "Drinking Water & Mining Impact", partyLeading: "YSRCP", seatsCount: 7, coordinates: { x: 23, y: 40 } },
  { id: "AP-16", name: "Bapatla", region: "Coastal", constituencyIds: [], population: 1587000, totalResponses: 1540, avgApprovalRating: 59, topIssueSelected: "Sea Water Intrusion", partyLeading: "TDP", seatsCount: 6, coordinates: { x: 27, y: 53 } },
  { id: "AP-17", name: "Prakasam", region: "Coastal", constituencyIds: [], population: 2288000, totalResponses: 2150, avgApprovalRating: 56, topIssueSelected: "Fluorosis & Borewells", partyLeading: "YSRCP", seatsCount: 8, coordinates: { x: 20, y: 59 } },
  { id: "AP-18", name: "SPSR Nellore", region: "Coastal", constituencyIds: [], population: 2465000, totalResponses: 2300, avgApprovalRating: 59, topIssueSelected: "Aquaculture & Unemployment", partyLeading: "TDP", seatsCount: 10, coordinates: { x: 19, y: 73 } },
  
  // Rayalaseema (South/Inland)
  { id: "AP-19", name: "Kurnool", region: "Rayalaseema", constituencyIds: [], population: 2366000, totalResponses: 2200, avgApprovalRating: 53, topIssueSelected: "Drought & Irrigation", partyLeading: "YSRCP", seatsCount: 8, coordinates: { x: 10, y: 48 } },
  { id: "AP-20", name: "Nandyal", region: "Rayalaseema", constituencyIds: [], population: 1786000, totalResponses: 1680, avgApprovalRating: 55, topIssueSelected: "Seeds adulteration", partyLeading: "YSRCP", seatsCount: 7, coordinates: { x: 14, y: 54 } },
  { id: "AP-21", name: "Ananthapuramu", region: "Rayalaseema", constituencyIds: [], population: 2246000, totalResponses: 2050, avgApprovalRating: 58, topIssueSelected: "Groundwater depletion", partyLeading: "TDP", seatsCount: 8, coordinates: { x: 5, y: 64 } },
  { id: "AP-22", name: "Sri Sathya Sai", region: "Rayalaseema", constituencyIds: [], population: 1845000, totalResponses: 1740, avgApprovalRating: 60, topIssueSelected: "Horticulture cold storage", partyLeading: "TDP", seatsCount: 6, coordinates: { x: 7, y: 72 } },
  { id: "AP-23", name: "YSR Kadapa", region: "Rayalaseema", constituencyIds: [], population: 2061000, totalResponses: 2410, avgApprovalRating: 49, topIssueSelected: "Steel Plant Delayed project", partyLeading: "YSRCP", seatsCount: 7, coordinates: { x: 14, y: 65 } },
  { id: "AP-24", name: "Annamayya", region: "Rayalaseema", constituencyIds: [], population: 1694000, totalResponses: 1590, avgApprovalRating: 54, topIssueSelected: "Tomato MSP & Storage", partyLeading: "YSRCP", seatsCount: 6, coordinates: { x: 13, y: 75 } },
  { id: "AP-25", name: "Chittoor", region: "Rayalaseema", constituencyIds: [], population: 1872000, totalResponses: 1980, avgApprovalRating: 62, topIssueSelected: "Milk Pricing & Agriculture", partyLeading: "TDP", seatsCount: 7, coordinates: { x: 8, y: 84 } },
  { id: "AP-26", name: "Tirupati", region: "Rayalaseema", constituencyIds: [], population: 2197000, totalResponses: 2850, avgApprovalRating: 63, topIssueSelected: "Pilgrim amenities & sanitation", partyLeading: "TDP", seatsCount: 7, coordinates: { x: 16, y: 81 } }
];

// Curated high-profile constituencies across various districts
const HIGH_PROFILE_CONSTITUENCIES: Partial<Constituency>[] = [
  {
    id: "AC-170",
    name: "Kuppam",
    districtId: "AP-25",
    sittingMLA: "Nara Chandrababu Naidu (TDP)",
    MLAFeedback: "Strong local grip. Highly responsive. Water canal works are delayed.",
    population: 265000,
    voters: 215000,
    surveyResponses: 0,
    approvalRating: 69,
    swingStatus: "Safe",
    topIssues: [
      { issue: "Handloom Sector Crisis", percentage: 38 },
      { issue: "Drinking Water Grid", percentage: 32 },
      { issue: "Youth Unemployment", percentage: 30 }
    ],
    partyPreference: [
      { party: "TDP", percentage: 58 },
      { party: "YSRCP", percentage: 32 },
      { party: "JSP", percentage: 4 },
      { party: "INC", percentage: 3 },
      { party: "BJP", percentage: 1 },
      { party: "OTH", percentage: 2 }
    ],
    trendHistory: [
      { month: "Jan 2026", leadParty: "TDP", gap: 28 },
      { month: "Mar 2026", leadParty: "TDP", gap: 26 },
      { month: "May 2026", leadParty: "TDP", gap: 26 }
    ]
  },
  {
    id: "AC-156",
    name: "Pulivendula",
    districtId: "AP-23",
    sittingMLA: "Y.S. Jagan Mohan Reddy (YSRCP)",
    MLAFeedback: "Unmatched personal base. High welfare satisfaction but criticisms on industrial development.",
    population: 280000,
    voters: 224000,
    surveyResponses: 0,
    approvalRating: 71,
    swingStatus: "Safe",
    topIssues: [
      { issue: "Drought Compensation", percentage: 42 },
      { issue: "Food Processing Unit Jobs", percentage: 33 },
      { issue: "Drip Irrigation Subsidy", percentage: 25 }
    ],
    partyPreference: [
      { party: "YSRCP", percentage: 61 },
      { party: "TDP", percentage: 27 },
      { party: "INC", percentage: 7 },
      { party: "OTH", percentage: 5 }
    ],
    trendHistory: [
      { month: "Jan 2026", leadParty: "YSRCP", gap: 35 },
      { month: "Mar 2026", leadParty: "YSRCP", gap: 32 },
      { month: "May 2026", leadParty: "YSRCP", gap: 34 }
    ]
  },
  {
    id: "AC-091",
    name: "Mangalagiri",
    districtId: "AP-14",
    sittingMLA: "Nara Lokesh (TDP)",
    MLAFeedback: "Highly active development monitoring. IT park expansion appreciation. Capital city land issues.",
    population: 295000,
    voters: 235000,
    surveyResponses: 0,
    approvalRating: 64,
    swingStatus: "Leans",
    topIssues: [
      { issue: "Amaravati Capital Progress", percentage: 45 },
      { issue: "Handloom weavers subsidies", percentage: 30 },
      { issue: "Drainage Infrastructure", percentage: 25 }
    ],
    partyPreference: [
      { party: "TDP", percentage: 51 },
      { party: "YSRCP", percentage: 37 },
      { party: "JSP", percentage: 6 },
      { party: "INC", percentage: 4 },
      { party: "OTH", percentage: 2 }
    ],
    trendHistory: [
      { month: "Jan 2026", leadParty: "TDP", gap: 11 },
      { month: "Mar 2026", leadParty: "TDP", gap: 13 },
      { month: "May 2026", leadParty: "TDP", gap: 14 }
    ]
  },
  {
    id: "AC-150",
    name: "Hindupur",
    districtId: "AP-22",
    sittingMLA: "Nandamuri Balakrishna (TDP)",
    MLAFeedback: "Charismatic MLA. Visible local infra work, though residents demand more local presence.",
    population: 275000,
    voters: 218000,
    surveyResponses: 0,
    approvalRating: 60,
    swingStatus: "Safe",
    topIssues: [
      { issue: "Drinking Water Shortage", percentage: 48 },
      { issue: "Industrial Jobs in Lepakshi SEZ", percentage: 32 },
      { issue: "Road Connectivity", percentage: 20 }
    ],
    partyPreference: [
      { party: "TDP", percentage: 53 },
      { party: "YSRCP", percentage: 36 },
      { party: "JSP", percentage: 5 },
      { party: "INC", percentage: 3 },
      { party: "OTH", percentage: 3 }
    ],
    trendHistory: [
      { month: "Jan 2026", leadParty: "TDP", gap: 15 },
      { month: "Mar 2026", leadParty: "TDP", gap: 16 },
      { month: "May 2026", leadParty: "TDP", gap: 17 }
    ]
  },
  {
    id: "AC-071",
    name: "Bhimavaram",
    districtId: "AP-11",
    sittingMLA: "Grandhi Srinivas (YSRCP)",
    MLAFeedback: "Active MLA, but strong anti-incumbency feedback on aquaculture policy and infrastructure.",
    population: 252000,
    voters: 204000,
    surveyResponses: 0,
    approvalRating: 46,
    swingStatus: "Swing",
    topIssues: [
      { issue: "Aqua farmer power tariff", percentage: 39 },
      { issue: "Bypass road flyover construction", percentage: 33 },
      { issue: "Sanitation and drinking water", percentage: 28 }
    ],
    partyPreference: [
      { party: "JSP", percentage: 44 },
      { party: "TDP", percentage: 25 },
      { party: "YSRCP", percentage: 24 },
      { party: "BJP", percentage: 3 },
      { party: "OTH", percentage: 4 }
    ],
    trendHistory: [
      { month: "Jan 2026", leadParty: "JSP", gap: 12 },
      { month: "Mar 2026", leadParty: "JSP", gap: 16 },
      { month: "May 2026", leadParty: "JSP", gap: 19 }
    ]
  }
];

// Generates 175 complete constituencies mapped to 26 districts programmatically
// to ensure beautiful completeness and flawless dropdown selectors.
export const generateConstituencies = (): Constituency[] => {
  const list: Constituency[] = [];
  const issuesList = [
    "Drinking Water Grid",
    "Youth Unemployment",
    "Farmer MSP & Subsidies",
    "Rural Health Center Amenities",
    "Bypasses and Road Expansion",
    "Welfare Scheme Disbursement Speed",
    "Power Grid Reliability",
    "Aqua/Dairy Support Prices",
    "Encroachments & Town Drainage"
  ];

  const templateMLAs = [
    { name: "A. Srikanth Reddy", party: "YSRCP" },
    { name: "K. Atchannaidu", party: "TDP" },
    { name: "D. Prabhakar Rao", party: "TDP" },
    { name: "P. Vishnu Kumar Raju", party: "BJP" },
    { name: "Kandula Durgesh", party: "JSP" },
    { name: "P. Satish Varma", party: "TDP" },
    { name: "T. Rajasekhar", party: "YSRCP" },
    { name: "B. Venkateswarlu", party: "TDP" },
    { name: "G. Srinivasa Rao", party: "JSP" }
  ];

  // Map of districts to constituency names to make them look authentic
  const districtToACNames: Record<string, string[]> = {
    "AP-01": ["Srikakulam City", "Tekkali", "Palasa", "Ichchapuram", "Amadalavalasa", "Pathapatnam", "Narasannapeta", "Rajam", "Etcherla", "Ranastalam"],
    "AP-02": ["Parvathipuram", "Salur", "Kurupam", "Palakonda"],
    "AP-03": ["Vizianagaram City", "Gajapathinaram", "Bobbili", "Cheepurupalli", "Nellimarla", "Srungavarapukota", "S.Kota", "Bhupathipalem", "Jami"],
    "AP-04": ["Visakhapatnam East", "Visakhapatnam West", "Visakhapatnam South", "Visakhapatnam North", "Bheemili", "Gajuwaka"],
    "AP-05": ["Anakapalli", "Chodavaram", "Madugula", "Yellamanchili", "Payakaraopet", "Narsipatnam", "Sabbavaram"],
    "AP-06": ["Paderu", "Araku Valley", "Rampachodavaram"],
    "AP-07": ["Kakinada City", "Kakinada Rural", "Pithapuram", "Tuni", "Prathipadu", "Jaggampeta", "Peddapuram"],
    "AP-08": ["Rajahmundry City", "Rajahmundry Rural", "Anaparthy", "Rajanagaram", "Kovvur", "Nidadavole", "Gopalapuram"],
    "AP-09": ["Ramachandrapuram", "Mummidivaram", "Amalapuram", "Razole", "Gannavaram AC", "Kothapeta", "Mandapeta"],
    "AP-10": ["Eluru City", "Denduluru", "Unguturu", "Polavaram", "Chintalapudi", "Nuzvid", "Tadepalligudem"],
    "AP-11": ["Achanta", "Palakollu", "Narsapuram", "Bhimavaram", "Undi", "Tanuku", "Tadepalligudem Rural"],
    "AP-12": ["Vijayawada Central", "Vijayawada West", "Vijayawada East", "Mylavaram", "Nandigama", "Jaggayyapeta", "Tiruvuru"],
    "AP-13": ["Machilipatnam", "Gudivada", "Pedana", "Kaikalur", "Avanigadda", "Pamarru", "Penamaluru"],
    "AP-14": ["Guntur West", "Guntur East", "Mangalagiri", "Tadikonda", "Prathipadu", "Tenali", "Ponnur"],
    "AP-15": ["Narasaraopet", "Chilakaluripet", "Sattenapalle", "Gurazala", "Macherla", "Vinukonda", "Pedakurapadu"],
    "AP-16": ["Bapatla", "Vemuru", "Repalle", "Parchur", "Addanki", "Chirala"],
    "AP-17": ["Ongole", "Markapuram", "Kandukur", "Darsi", "Podili", "Kanigiri", "Giddalur", "Yerragondapalem"],
    "AP-18": ["Nellore City", "Nellore Rural", "Kavali", "Atmakur", "Udayagiri", "Gudur", "Sullurpeta", "Venkatagiri", "Kovur", "Buchireddypalem"],
    "AP-19": ["Kurnool City", "Adoni", "Yemmiganur", "Mantralayam", "Pattikonda", "Kodumur", "Pathikonda", "Alur"],
    "AP-20": ["Nandyal City", "Allagadda", "Banaganapalle", "Dhone", "Nandikotkur", "Srisailam", "Koilkuntla"],
    "AP-21": ["Anantapur Urban", "Anantapur Rural", "Guntakal", "Tadipatri", "Singanamala", "Kalyandurg", "Rayadurg", "Uravakonda"],
    "AP-22": ["Hindupur", "Penukonda", "Dharmavaram", "Madakasira", "Kadiri", "Puttaparthi"],
    "AP-23": ["Pulivendula", "Kadapa City", "Jammalamadugu", "Proddatur", "Mydukur", "Kamalapuram", "Badvel"],
    "AP-24": ["Rayachoti", "Rajampet", "Railway Kodur", "Madanapalle", "Tamballapalle", "Pileru"],
    "AP-25": ["Chittoor City", "Kuppam", "Punganur", "Palamaner", "Karvetinagar", "Nagari", "Gangadhara Nellore"],
    "AP-26": ["Tirupati City", "Srikalahasti", "Satyavedu", "Chandragiri", "Venkatagiri Rural", "Sulurpet border", "Gudur Coast"]
  };

  let globalAcCounter = 1;

  DISTRICTS.forEach((dist) => {
    const acNames = districtToACNames[dist.id] || [];
    const targetCount = dist.seatsCount;

    for (let i = 0; i < targetCount; i++) {
      const acName = acNames[i] || `${dist.name} ${i + 1}`;
      const acId = `AC-${globalAcCounter.toString().padStart(3, "0")}`;
      globalAcCounter++;

      // Check if this exists as a curated high profile constituency
      const curate = HIGH_PROFILE_CONSTITUENCIES.find(
        (c) => c.name?.toLowerCase() === acName.toLowerCase()
      );

      if (curate) {
        list.push({
          id: curate.id!,
          name: curate.name!,
          districtId: dist.id,
          districtName: dist.name,
          population: curate.population!,
          voters: curate.voters!,
          surveyResponses: curate.surveyResponses!,
          topIssues: curate.topIssues!,
          approvalRating: curate.approvalRating!,
          partyPreference: curate.partyPreference!,
          trendHistory: curate.trendHistory!,
          mandalCount: Math.floor(Math.random() * 4) + 3,
          villageCount: Math.floor(Math.random() * 25) + 30,
          sittingMLA: curate.sittingMLA!,
          MLAFeedback: curate.MLAFeedback!,
          swingStatus: curate.swingStatus!,
          demographics: {
            age: { labels: ["18-25", "26-35", "36-50", "50+"], values: [24, 32, 28, 16] },
            gender: { labels: ["Male", "Female", "Others"], values: [49.5, 50.1, 0.4] },
            occupation: { labels: ["Agriculture", "Self-employed", "Private Sector", "Students", "Unemployed"], values: [38, 22, 18, 12, 10] }
          }
        });
      } else {
        // Generate realistic mock data
        const baseApproval = dist.avgApprovalRating + (Math.floor(Math.random() * 15) - 7);
        const mlaParty = dist.partyLeading === "TDP" ? "TDP" : dist.partyLeading === "YSRCP" ? "YSRCP" : "JSP";
        const mlaName = templateMLAs[Math.floor(Math.random() * templateMLAs.length)];
        const mainIssuesIndices = [
          Math.floor(Math.random() * issuesList.length),
          Math.floor(Math.random() * issuesList.length)
        ];
        if (mainIssuesIndices[0] === mainIssuesIndices[1]) {
          mainIssuesIndices[1] = (mainIssuesIndices[0] + 1) % issuesList.length;
        }

        const partyWeights = dist.partyLeading === "TDP" 
          ? [46, 36, 11, 4, 3] 
          : dist.partyLeading === "YSRCP" 
          ? [34, 48, 8, 5, 5] 
          : [36, 32, 24, 4, 4]; // JSP lead

        list.push({
          id: acId,
          name: acName,
          districtId: dist.id,
          districtName: dist.name,
          population: Math.floor(Math.random() * 80000) + 210000,
          voters: Math.floor(Math.random() * 60000) + 160000,
          surveyResponses: 0,
          topIssues: [
            { issue: issuesList[mainIssuesIndices[0]], percentage: Math.floor(Math.random() * 10) + 35 },
            { issue: issuesList[mainIssuesIndices[1]], percentage: Math.floor(Math.random() * 10) + 25 },
            { issue: "Inflation & Living Cost", percentage: 20 }
          ],
          approvalRating: Math.max(25, Math.min(95, baseApproval)),
          partyPreference: [
            { party: "TDP", percentage: partyWeights[0] + (Math.floor(Math.random() * 6) - 3) },
            { party: "YSRCP", percentage: partyWeights[1] + (Math.floor(Math.random() * 6) - 3) },
            { party: "JSP", percentage: partyWeights[2] + (Math.floor(Math.random() * 6) - 3) },
            { party: "INC", percentage: partyWeights[3] },
            { party: "OTH", percentage: partyWeights[4] }
          ],
          trendHistory: [
            { month: "Jan 2026", leadParty: dist.partyLeading, gap: Math.floor(Math.random() * 5) + 3 },
            { month: "Mar 2026", leadParty: dist.partyLeading, gap: Math.floor(Math.random() * 5) + 5 },
            { month: "May 2026", leadParty: dist.partyLeading, gap: Math.floor(Math.random() * 5) + 6 }
          ],
          mandalCount: Math.floor(Math.random() * 3) + 4,
          villageCount: Math.floor(Math.random() * 40) + 50,
          sittingMLA: `${mlaName.name} (${mlaParty})`,
          MLAFeedback: "Moderately active. Visible welfare focus but under criticism for local link roads.",
          swingStatus: baseApproval > 62 ? "Safe" : baseApproval > 54 ? "Leans" : baseApproval > 46 ? "Swing" : "Battleground",
          demographics: {
            age: { labels: ["18-25", "26-35", "36-50", "50+"], values: [23, 31, 29, 17] },
            gender: { labels: ["Male", "Female", "Others"], values: [49.2, 50.4, 0.4] },
            occupation: { labels: ["Agriculture", "Self-employed", "Private Sector", "Students", "Unemployed"], values: [42, 20, 15, 13, 10] }
          }
        });
      }
    }
  });

  return list;
};

export const CONSTITUENCIES = generateConstituencies();

// Tie constituencies back to districts for exact counts
DISTRICTS.forEach((d) => {
  const matchingACs = CONSTITUENCIES.filter(ac => ac.districtId === d.id);
  d.constituencyIds = matchingACs.map(ac => ac.id);
  // Re-sum responses based on dynamically generated count, preserving static baseline
  d.totalResponses = (d.totalResponses || 0) + matchingACs.reduce((acc, current) => acc + current.surveyResponses, 0);
  d.avgApprovalRating = Math.round(matchingACs.reduce((acc, current) => acc + current.approvalRating, 0) / matchingACs.length);
});

// Mock Initial Survey responses for analytics dashboard charts
export const INITIAL_MOCK_RESPONSES: SurveyResponse[] = [];

// Curated Scientific Research and opinion poll Reports
export const REPORTS: ReportItem[] = [
  {
    id: "REP-01",
    title: "Andhra Pradesh Monthly Public Sentiment - June 2026",
    category: "Monthly",
    publishDate: "June 10, 2026",
    author: "Prasad Rao (Chief Research Lead)",
    summary: "Statewide assessment of public satisfaction, highlighting performance ratings on social welfare, infrastructure development, and overall leadership popularity metrics ahead of municipal selections.",
    highlights: [
      "Welfare scheme satisfaction remains strong at 65% statewide.",
      "Industrial employment and price rise emerged as top negative parameters.",
      "North coastal region (Uttarandhra) showcases positive swing towards urban development initiatives."
    ],
    pdfSize: "2.4 MB",
    readTime: "12 mins"
  },
  {
    id: "REP-02",
    title: "Constituency Trend Report - Rayalaseema Regional Focus",
    category: "Constituency",
    publishDate: "May 25, 2026",
    author: "Dr. Lakshmi Prasad",
    summary: "In-depth micro analysis across 52 MLA constituencies in Kadapa, Chittoor, Tirupati, Ananthapuramu, and Kurnool. Highlighting swing indicators, drought response satisfaction, and district-level priorities.",
    highlights: [
      "Tomato and groundnut farm subsidies are the single most active debate point in Annamayya and Chittoor.",
      "Groundwater levels are key to constituency voter priorities, affecting 72% of rural respondents.",
      "6 swing seats highlighted with narrow leads under 4%."
    ],
    pdfSize: "4.1 MB",
    readTime: "24 mins"
  },
  {
    id: "REP-03",
    title: "Statewide Youth and Employment Opinion Poll",
    category: "Sectoral",
    publishDate: "May 12, 2026",
    author: "Youth Council Research Team",
    summary: "Analyzing opinion samples from over 18,000 respondents in the 18-30 age cohort across all 26 districts of AP, discussing skills development programs and expectations around IT/industrial clusters.",
    highlights: [
      "78% of graduating respondents prioritize local software/manufacturing jobs over relocation.",
      "Interest in start-up subsidies has increased by 18% year-on-year.",
      "High popularity for digital skills academies launched in Guntur, NTR, and Visakhapatnam."
    ],
    pdfSize: "1.8 MB",
    readTime: "8 mins"
  },
  {
    id: "REP-04",
    title: "Agricultural Sentiment & Irrigation Infrastructure",
    category: "Sectoral",
    publishDate: "April 28, 2026",
    author: "Agri-Analytics Cell",
    summary: "Comprehensive feedback study on water canal restoration, river-interlinking performance, and cold storage warehousing demand in Godavari deltas and Krishna delta.",
    highlights: [
      "Paddy farmers express high satisfaction (62%) on water release calendars.",
      "Alternative farming subsidies (oil palm, cocoa) show increasing adoption and success in West Godavari.",
      "Need for primary sorting hubs felt by 84% chili and cotton growers in Guntur and Palnadu."
    ],
    pdfSize: "3.2 MB",
    readTime: "15 mins"
  },
  {
    id: "REP-05",
    title: "Women's Safety, Health & Welfare Schemes Impact",
    category: "Sectoral",
    publishDate: "April 15, 2026",
    author: "Sunitha Amma (Social Welfare Analyst)",
    summary: "A thorough review of self-help groups (SHG) micro-finance support, specialized healthcare clinics, and mothers' allowance programs, polling some 12,500 rural and semi-urban female citizens.",
    highlights: [
      "Over 92% of sampled women acknowledge the immediate digital credit of welfare scheme payouts.",
      "Local PHC (Primary Health Center) upgrade requests noted in tribal areas of Manyam and Alluri Sitharama Raju.",
      "Self-help group digital literacy campaigns receive high praise across Nellore and Bapatla districts."
    ],
    pdfSize: "1.9 MB",
    readTime: "10 mins"
  }
];

// Media Center Articles / Updates
export const NEWS_CARDS: NewsCard[] = [
  {
    id: "NEWS-01",
    title: "Andhra Pradesh Cabinet Approves New Industrial Policy Targeting ₹1.5 Lakh Crore Investment",
    category: "Development",
    date: "July 02, 2026",
    summary: "In a major policy push, the state cabinet has approved a comprehensive industrial and electronics policy aimed at boosting manufacturing across Visakhapatnam, Anantapur, and Chittoor districts, targeting the creation of over 3 lakh new youth jobs.",
    readTime: "4 min read",
    source: "The Hindu",
    sourceUrl: "https://www.thehindu.com/news/national/andhra-pradesh/"
  },
  {
    id: "NEWS-02",
    title: "TDP-JSP-BJP Coalition Outlines Joint Manifesto Implementation Dashboard for Citizens",
    category: "Governance",
    date: "June 29, 2026",
    summary: "The ruling alliance announced a public digital registry to track progress on key welfare and infrastructure commitments. The initiative is being spearheaded to build absolute transparency and eliminate administrative friction in direct benefit transfers.",
    readTime: "5 min read",
    source: "Times of India",
    sourceUrl: "https://timesofindia.indiatimes.com/city/vijayawada"
  },
  {
    id: "NEWS-03",
    title: "YSRCP Launches State-Wide 'Jana Chaitanya' Campaign to Critique Infrastructure Delays",
    category: "Election Watch",
    date: "June 25, 2026",
    summary: "The main opposition party YSRCP has initiated a massive public outreach program across Rayalaseema and Coastal districts, focusing on road quality, housing project backlogs, and demanding immediate escalation of water management works.",
    readTime: "6 min read",
    source: "Deccan Chronicle",
    sourceUrl: "https://www.deccanchronicle.com/nation/politics"
  },
  {
    id: "NEWS-04",
    title: "Pawan Kalyan Reviews Amaravati Capital City Project Milestones and Green Belt Zoning",
    category: "Development",
    date: "June 20, 2026",
    summary: "Deputy Chief Minister Pawan Kalyan conducted high-level meetings on the master plan execution of Amaravati. Discussions focused on eco-friendly public transit channels, administrative city structures, and allocation of self-employment zones.",
    readTime: "4 min read",
    source: "The Indian Express",
    sourceUrl: "https://indianexpress.com/section/india/andhra-pradesh/"
  },
  {
    id: "NEWS-05",
    title: "Ground Sentiment: High Inflation and Fertilizer Prices Concerns Emerge in Guntur Agri-Belt",
    category: "Sentiment",
    date: "June 17, 2026",
    summary: "According to local ground reports and retail trader feedback, marginal farmers are seeking additional subsidy interventions to offset the rising cost of chemical fertilizers and diesel fuel for irrigation engines.",
    readTime: "3 min read",
    source: "Livemint",
    sourceUrl: "https://www.livemint.com/politics"
  },
  {
    id: "NEWS-06",
    title: "Congress AP Chief Y.S. Sharmila Demands Special Category Status in Upcoming Union Budget",
    category: "Trends",
    date: "June 12, 2026",
    summary: "Leading a protest in Vijayawada, the AP Congress leadership has put forward a comprehensive demand list to the central government, emphasizing that Special Category Status is vital for the long-term industrialization of Andhra Pradesh.",
    readTime: "5 min read",
    source: "NDTV News",
    sourceUrl: "https://www.ndtv.com/india-news"
  },
  {
    id: "NEWS-07",
    title: "State Government Allocates ₹8,500 Crore for Rural Drinking Water Grid and Jal Jeevan Mission",
    category: "Governance",
    date: "June 08, 2026",
    summary: "Addressing long-standing issues in dry regions, a massive funding block has been cleared for rural drinking water networks. Over 4,200 village panchayats in Prakasam, Nellore, and Kadapa are scheduled for connection in Phase 1.",
    readTime: "4 min read",
    source: "Hindustan Times",
    sourceUrl: "https://www.hindustantimes.com/india-news"
  },
  {
    id: "NEWS-08",
    title: "Polavaram Project Repairs Gain Momentum as Central Technical Committee Clears New Designs",
    category: "Development",
    date: "June 04, 2026",
    summary: "The multi-purpose Polavaram irrigation project on the Godavari river received a green signal for its revised guide-wall designs. Repair work on the damaged diaphragm wall is set to proceed on a war footing before the monsoon surges.",
    readTime: "7 min read",
    source: "The Pioneer",
    sourceUrl: "https://www.dailypioneer.com/"
  },
  {
    id: "NEWS-09",
    title: "Digital Survey Hub Celebrates 60,000 Verified Sentiments on Local MLA Performance",
    category: "Highlights",
    date: "May 30, 2026",
    summary: "Our community sentiment tracker reaches a new milestone, logging sixty thousand unique digital opinions. The transparent data assists policy researchers and district organizers in mapping localized issues with pin-point accuracy.",
    readTime: "3 min read",
    source: "People Pulse Analytics",
    sourceUrl: "#"
  }
];

// Testimonials of actual citizen voices and observers
export const TESTIMONIALS: Testimonial[] = [
  {
    id: "TES-01",
    quote: "The platform gives a clear understanding of public priorities. For once, as research observers, we can see real sentiment on the ground rather than speculative TV reports.",
    author: "Prof. Ramamurthy Naidu",
    role: "Retired Political Science Faculty",
    location: "Visakhapatnam"
  },
  {
    id: "TES-02",
    quote: "Extremely useful for understanding local issues. As block coordinators, we utilize the District Analytics dashboard to pinpoint exactly which Gram Panchayats are demanding drinking water grids.",
    author: "Malleshwari Devi",
    role: "NGO Field Director",
    location: "Kurnool"
  },
  {
    id: "TES-03",
    quote: "Excellent data visualization and transparency. Submitting surveys on local school facilities has never felt this direct. It's a true voice multiplier for Andhra citizens.",
    author: "Ravi Teja Chowdary",
    role: "Progressive Agriculturist",
    location: "Amalapuram"
  }
];

export const TRENDING_VIDEOS: NewsVideo[] = [
  {
    id: "VID-01",
    title: "Andhra Pradesh Cabinet Approves Industrial Policy Targeting 3 Lakh Youth Jobs",
    channel: "NTV Telugu News",
    publishDate: "July 02, 2026",
    youtubeId: "v_hF7U7Kjco",
    duration: "12:45",
    category: "Development",
    description: "Detailed report on Andhra Pradesh Cabinet's new electronics and manufacturing policies targeting major hubs like Visakhapatnam, Anantapur, and Chittoor.",
    videoUrl: "https://assets.mixkit.co/videos/preview/mixkit-news-broadcast-studio-with-screens-and-lights-42289-large.mp4",
    thumbnailUrl: "https://images.unsplash.com/photo-1585829365295-ab7cd400c167?auto=format&fit=crop&q=80&w=600"
  },
  {
    id: "VID-02",
    title: "CM Nara Chandrababu Naidu Announces Capital Amaravati Development Milestones",
    channel: "TV9 Telugu Live",
    publishDate: "June 28, 2026",
    youtubeId: "_78vL-7pD3Y",
    duration: "18:20",
    category: "Assembly",
    description: "Watch CM Chandrababu Naidu outline the phase-wise master plan and funding clearance from international agencies for the capital city Amaravati.",
    videoUrl: "https://assets.mixkit.co/videos/preview/mixkit-capital-city-traffic-and-buildings-at-sunset-42316-large.mp4",
    thumbnailUrl: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&q=80&w=600"
  },
  {
    id: "VID-03",
    title: "Pawan Kalyan Reviews Green Belt Zoning & Eco-Transit Corridors",
    channel: "ETV Andhra Pradesh",
    publishDate: "June 20, 2026",
    youtubeId: "H7UfGsmB_bE",
    duration: "08:15",
    category: "Analysis",
    description: "Deputy CM Pawan Kalyan in a high-level review meeting detailing sustainable public transport and green zones across central districts.",
    videoUrl: "https://assets.mixkit.co/videos/preview/mixkit-business-people-meeting-in-a-modern-office-42312-large.mp4",
    thumbnailUrl: "https://images.unsplash.com/photo-1542744173-8e18128ee56f?auto=format&fit=crop&q=80&w=600"
  },
  {
    id: "VID-04",
    title: "Special Debate: Capital Amaravati Construction Speed vs Rayalaseema Welfare Demands",
    channel: "ABN Andhra Jyothi",
    publishDate: "June 15, 2026",
    youtubeId: "D5_qK3A3B0s",
    duration: "25:10",
    category: "Debate",
    description: "Panel discussion featuring experts and representatives from TDP, YSRCP, and JSP debating balanced regional growth in Rayalaseema.",
    videoUrl: "https://assets.mixkit.co/videos/preview/mixkit-man-watching-the-news-on-tv-42291-large.mp4",
    thumbnailUrl: "https://images.unsplash.com/photo-1593789198777-f29bc259780e?auto=format&fit=crop&q=80&w=600"
  },
  {
    id: "VID-05",
    title: "Jagan Mohan Reddy Highlights Welfare Deliveries and Infrastructure Gaps",
    channel: "Sakshi TV News",
    publishDate: "June 10, 2026",
    youtubeId: "mU-68E8M87g",
    duration: "14:30",
    category: "Press Meet",
    description: "Opposition leader Y.S. Jagan Mohan Reddy speaks to the media regarding progress delays on rural housing and local road projects.",
    videoUrl: "https://assets.mixkit.co/videos/preview/mixkit-press-conference-reporter-taking-notes-42293-large.mp4",
    thumbnailUrl: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&q=80&w=600"
  }
];

