/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export enum UserRole {
  Citizen = "Citizen",
  SurveyVolunteer = "Survey Volunteer",
  FieldCoordinator = "Field Coordinator",
  DistrictCoordinator = "District Coordinator",
  StateAdministrator = "State Administrator",
  ResearchAnalyst = "Research Analyst",
  SuperAdmin = "Super Admin"
}

export enum SurveyCategory {
  GovernmentPerformance = "Government Performance",
  PublicServices = "Public Services",
  Education = "Education",
  Healthcare = "Healthcare",
  Employment = "Employment",
  Agriculture = "Agriculture",
  Infrastructure = "Infrastructure",
  WomenWelfare = "Women Welfare",
  YouthIssues = "Youth Issues",
  LocalGovernance = "Local Governance",
  LeadershipPreference = "Leadership Preference",
  ElectionPreference = "Election Preference"
}

export interface Constituency {
  id: string;
  name: string;
  districtId: string;
  districtName: string;
  population: number;
  voters: number;
  surveyResponses: number;
  topIssues: { issue: string; percentage: number }[];
  approvalRating: number; // percentage approval of current MLA
  partyPreference: { party: string; percentage: number }[];
  trendHistory: { month: string; leadParty: string; gap: number }[];
  demographics: {
    age: { labels: string[]; values: number[] };
    gender: { labels: string[]; values: number[] };
    occupation: { labels: string[]; values: number[] };
  };
  mandalCount: number;
  villageCount: number;
  sittingMLA: string;
  MLAFeedback: string;
  swingStatus: "Safe" | "Leans" | "Swing" | "Battleground";
}

export interface District {
  id: string;
  name: string;
  region: "Coastal" | "Rayalaseema" | "Uttarandhra";
  constituencyIds: string[];
  population: number;
  totalResponses: number;
  avgApprovalRating: number;
  topIssueSelected: string;
  partyLeading: string;
  seatsCount: number;
  coordinates: { x: number; y: number }; // Relative coordinates for our custom SVG map
}

export interface SurveyResponse {
  id: string;
  timestamp: string;
  districtId: string;
  constituencyId: string;
  ageGroup: string;
  gender: string;
  occupation: string;
  primaryIssue: string;
  govtRating: number; // 1 to 5
  mlaRating: number;  // 1 to 5
  favLeader: string;
  votePreference: string;
  customFeedback: string;
  status: "Pending" | "Approved" | "Flagged";
  verifiedByVolunteer?: string;
  categoryScores: Record<string, number>; // ratings for different index.css categories
}

export interface ReportItem {
  id: string;
  title: string;
  category: "Monthly" | "Constituency" | "District" | "Sectoral" | "Special";
  publishDate: string;
  author: string;
  summary: string;
  highlights: string[];
  pdfSize: string;
  readTime: string;
}

export interface NewsCard {
  id: string;
  title: string;
  category: "Sentiment" | "Trends" | "Development" | "Highlights" | "Election Watch" | "Governance";
  date: string;
  summary: string;
  readTime: string;
  source?: string;
  sourceUrl?: string;
}

export interface Testimonial {
  id: string;
  quote: string;
  author: string;
  role: string;
  location: string;
}

export interface NewsVideo {
  id: string;
  title: string;
  channel: string;
  publishDate: string;
  youtubeId: string;
  duration: string;
  category: "Debate" | "Analysis" | "Assembly" | "Development" | "Press Meet";
  description: string;
  videoUrl?: string;
  thumbnailUrl?: string;
}
