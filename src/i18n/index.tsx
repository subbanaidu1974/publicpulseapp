import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Lang = "en" | "te";
const KEY = "pp-lang";

const EN = {
  "nav.home": "Home",
  "nav.analytics": "Analytics Dashboard",
  "nav.elections": "Elections",
  "nav.constituencies": "Constituencies",
  "nav.survey": "Take Survey",
  "nav.reports": "Research Reports",
  "nav.methodology": "Methodology",
  "nav.media": "Media Center",
  "nav.faq": "FAQ",
  "nav.contact": "Contact Us",
  "nav.admin": "Admin Console",
  "lang.toggle": "తెలుగు",
  "state.label": "State",
  "state.apOnly": "This page currently shows Andhra Pradesh demo data only. Telangana content is available under Elections.",
  "common.demo": "Demo data",
  "common.retry": "Retry",
  "common.loading": "Loading...",
  "common.error": "Could not load data",
  "common.source": "Source",
  "common.seats": "seats",
  "common.year": "Year",
  "common.type": "Election type",
  "type.assembly": "Assembly",
  "type.ls": "Lok Sabha",
  "el.title": "Election Results Explorer",
  "el.tally": "Seat tally",
  "el.tallyTable": "Seat tally (table)",
  "el.voteShare": "Vote share",
  "el.margins": "Winning margin buckets",
  "el.marginal": "Marginal seats (margin under 2%)",
  "el.sortSeats": "Sort by seats",
  "el.sortAlpha": "Sort A-Z",
  "el.alliance": "Show alliance view",
  "el.allianceCaveat": "Alliance totals combine the seats and votes of parties that fought together pre-poll. Votes do not transfer perfectly between allies; treat this as an arithmetic aggregation, not a prediction.",
  "el.noAlliance": "No pre-poll alliance is recorded for this election.",
  "el.empty": "No results available for this selection.",
  "el.provenanceNote": "Figures are shown with their source. Items marked Demo data are synthetic seed data.",
  "cs.title": "Find a constituency",
  "cs.placeholder": "Search by name (English or Telugu)",
  "cs.none": "No constituency matches your search.",
  "cs.history": "Election history",
  "cs.census": "Census 2011 district context",
  "cs.noCensus": "No census data for this district.",
  "cs.compare": "Add to compare",
  "cs.compareTitle": "Compare constituencies",
  "cs.clear": "Clear",
  "map.layers": "Election map layers",
  "map.layer": "Layer",
  "map.winner": "Winner (party)",
  "map.margin": "Winning margin",
  "map.turnout": "Turnout",
  "map.tableTitle": "Accessible table version of the map",
  "survey.title": "Cast Your Ballot Preference",
  "survey.thanks": "Thank you. Your response has been recorded.",
  "survey.gated": "Survey results are hidden until at least 30 responses are collected.",
  "admin.dataStatus": "Data status",
  "admin.generated": "Last generated",
  "admin.rows": "Rows",
  "admin.provenance": "Provenance",
} as const;

export type Key = keyof typeof EN;

const TE: Partial<Record<Key, string>> = {
  "nav.home": "హోమ్",
  "nav.analytics": "విశ్లేషణ డాష్‌బోర్డ్",
  "nav.elections": "ఎన్నికలు",
  "nav.constituencies": "నియోజకవర్గాలు",
  "nav.survey": "సర్వే",
  "nav.reports": "పరిశోధన నివేదికలు",
  "nav.methodology": "పద్ధతి",
  "nav.media": "మీడియా సెంటర్",
  "nav.faq": "తరచు అడిగే ప్రశ్నలు",
  "nav.contact": "సంప్రదించండి",
  "nav.admin": "అడ్మిన్ కన్సోల్",
  "lang.toggle": "English",
  "state.label": "రాష్ట్రం",
  "state.apOnly": "ఈ పేజీ ప్రస్తుతం ఆంధ్ర ప్రదేశ్ డెమో డేటాను మాత్రమే చూపుతుంది. తెలంగాణ సమాచారం ఎన్నికలు విభాగంలో ఉంది.",
  "common.demo": "డెమో డేటా",
  "common.retry": "మళ్ళీ ప్రయత్నించండి",
  "common.loading": "లోడ్ అవుతోంది...",
  "common.error": "డేటా లోడ్ కాలేదు",
  "common.source": "మూలం",
  "common.seats": "సీట్లు",
  "common.year": "సంవత్సరం",
  "common.type": "ఎన్నికల రకం",
  "type.assembly": "శాసనసభ",
  "type.ls": "లోక్‌సభ",
  "el.title": "ఎన్నికల ఫలితాల అన్వేషణ",
  "el.tally": "సీట్ల సంఖ్య",
  "el.tallyTable": "సీట్ల పట్టిక",
  "el.voteShare": "ఓట్ల శాతం",
  "el.margins": "గెలుపు ఆధిక్యం వర్గాలు",
  "el.marginal": "స్వల్ప ఆధిక్య స్థానాలు (2% లోపు)",
  "el.sortSeats": "సీట్ల ప్రకారం",
  "el.sortAlpha": "అక్షర క్రమం",
  "el.alliance": "కూటమి వీక్షణ చూపించు",
  "el.allianceCaveat": "కూటమి మొత్తాలు ఎన్నికలకు ముందు కలిసి పోటీ చేసిన పార్టీల సీట్లు, ఓట్లను కలుపుతాయి. మిత్రుల మధ్య ఓట్లు పూర్తిగా బదిలీ కావు; ఇది అంచనా కాదు, కేవలం గణిత సమీకరణ.",
  "el.noAlliance": "ఈ ఎన్నికకు ఎన్నికల ముందు కూటమి నమోదు లేదు.",
  "el.empty": "ఈ ఎంపికకు ఫలితాలు లేవు.",
  "el.provenanceNote": "గణాంకాలు వాటి మూలంతో చూపబడతాయి. డెమో డేటా అని గుర్తించినవి కృత్రిమ నమూనా డేటా.",
  "cs.title": "నియోజకవర్గం వెతకండి",
  "cs.placeholder": "పేరుతో వెతకండి (ఇంగ్లీష్ లేదా తెలుగు)",
  "cs.none": "మీ శోధనకు సరిపోయే నియోజకవర్గం లేదు.",
  "cs.history": "ఎన్నికల చరిత్ర",
  "cs.census": "2011 జనగణన జిల్లా వివరాలు",
  "cs.noCensus": "ఈ జిల్లాకు జనగణన సమాచారం లేదు.",
  "cs.compare": "పోలికకు జోడించు",
  "cs.compareTitle": "నియోజకవర్గాల పోలిక",
  "cs.clear": "తొలగించు",
  "map.layers": "ఎన్నికల మ్యాప్ పొరలు",
  "map.layer": "పొర",
  "map.winner": "విజేత (పార్టీ)",
  "map.margin": "గెలుపు ఆధిక్యం",
  "map.turnout": "పోలింగ్ శాతం",
  "map.tableTitle": "మ్యాప్ యొక్క పట్టిక రూపం",
  "survey.title": "మీ ఓటు ప్రాధాన్యత నమోదు చేయండి",
  "survey.thanks": "ధన్యవాదాలు. మీ స్పందన నమోదైంది.",
  "survey.gated": "కనీసం 30 స్పందనలు వచ్చే వరకు సర్వే ఫలితాలు దాచబడతాయి.",
  "admin.dataStatus": "డేటా స్థితి",
  "admin.generated": "చివరిగా రూపొందించినది",
  "admin.rows": "వరుసలు",
  "admin.provenance": "మూలం రకం",
};

export function translate(key: Key, lang: Lang): string {
  return (lang === "te" ? TE[key] : undefined) ?? EN[key];
}

interface Ctx { lang: Lang; setLang: (l: Lang) => void; t: (k: Key) => string }
const LangCtx = createContext<Ctx | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    try { return localStorage.getItem(KEY) === "te" ? "te" : "en"; } catch { return "en"; }
  });
  useEffect(() => {
    try { localStorage.setItem(KEY, lang); } catch { /* ignore */ }
    document.documentElement.lang = lang;
  }, [lang]);
  const t = useCallback((k: Key) => translate(k, lang), [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, t]);
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

export function useT(): Ctx {
  const c = useContext(LangCtx);
  if (!c) throw new Error("useT outside LangProvider");
  return c;
}
