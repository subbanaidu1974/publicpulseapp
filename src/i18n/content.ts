/**
 * Long-form bilingual page content: FAQ, methodology, privacy, terms, who-sees-what.
 * Every entry carries both languages so a missing translation is a type error, and tests/i18n checks none is empty.
 *
 * reviewStatus: the Telugu below is a careful machine-assisted draft that no native-speaker reviewer has checked yet.
 * While a status is not "reviewed" the UI shows a "translation under review" note (TranslationNote). Flip a status only
 * after a named reviewer signs off, and record who in docs/BRANDING.md or the release gate.
 * The legal pages are also DRAFT pending counsel (DESIGN_2028 3.10), whatever the translation status.
 */
export type ReviewStatus = "machine-draft" | "reviewed";
export interface Bi { en: string; te: string }

export const reviewStatus: Record<"faq" | "methodology" | "privacy" | "terms" | "whoSees", ReviewStatus> = {
  faq: "machine-draft",
  methodology: "machine-draft",
  privacy: "machine-draft",
  terms: "machine-draft",
  whoSees: "machine-draft",
};

/* ------------------------------------------------------------------ FAQ */

export interface FaqItem { id: string; q: Bi; a: Bi }

export const FAQS: FaqItem[] = [
  {
    id: "data",
    q: { en: "Where do the election numbers come from?", te: "ఎన్నికల సంఖ్యలు ఎక్కడి నుంచి వస్తాయి?" },
    a: {
      // copy-lint-allow: election-results content
      en: "Assembly and Lok Sabha results for Andhra Pradesh and Telangana come from the Election Commission of India as compiled by the Trivedi Centre for Political Data (TCPD). Each page shows its provenance, and anything marked Demo data is synthetic seed data.",
      // copy-lint-allow: election-results content
      te: "ఆంధ్ర ప్రదేశ్, తెలంగాణ శాసనసభ, లోక్‌సభ ఎన్నికల ఫలితాలు భారత ఎన్నికల సంఘం నుంచి వస్తాయి; వాటిని త్రివేది సెంటర్ ఫర్ పొలిటికల్ డేటా (TCPD) సంకలనం చేసింది. ప్రతి పేజీ తన మూలాన్ని చూపుతుంది; డెమో డేటా అని గుర్తించినవి కృత్రిమ నమూనా డేటా.",
    },
  },
  {
    id: "surveys",
    q: { en: "Are there opinion surveys on this site?", te: "ఈ సైట్‌లో అభిప్రాయ సర్వేలు ఉన్నాయా?" },
    a: {
      en: "Yes. Pulse Surveys are listed in a public registry with their frozen wording. Each verified person can answer once, and answers sent from the app or web cannot be linked to you by the platform. Figures are published after a survey closes, with the method. They are opinion surveys, not elections and not forecasts.",
      te: "ఉన్నాయి. పల్స్ సర్వేలు స్థిరమైన పదాలతో బహిరంగ రిజిస్టర్‌లో ఉంటాయి. ధృవీకరించబడిన ప్రతి వ్యక్తి ఒక్కసారి సమాధానం ఇవ్వవచ్చు; యాప్ లేదా వెబ్ నుంచి పంపిన సమాధానాలను వేదిక మీకు అనుసంధానించలేదు. సర్వే ముగిసిన తర్వాత పద్ధతితో పాటు గణాంకాలు ప్రచురిస్తాము. ఇవి అభిప్రాయ సర్వేలు మాత్రమే, ఎన్నికలు కావు, ముందస్తు అంచనాలు కావు.",
    },
  },
  {
    id: "forecast",
    q: { en: "What is the outlook on the Elections page?", te: "ఎన్నికల పేజీలోని అంచనా దృశ్యం ఏమిటి?" },
    a: {
      // copy-lint-allow: describes election-results data, not a survey
      en: "It is a model projection from past results, shown with a range and a back-test. It does not say who will win, and it is withheld during an election period or whenever the election calendar is not confirmed.",
      te: "ఇది గత ఫలితాల ఆధారంగా చేసిన మోడల్ అంచనా; పరిధితో, గత ఎన్నికలపై పరీక్షతో చూపబడుతుంది. ఎవరు గెలుస్తారో ఇది చెప్పదు. ఎన్నికల కాలంలో, లేదా ఎన్నికల క్యాలెండర్ నిర్ధారణ కానప్పుడు, ఇది నిలిపివేయబడుతుంది.",
    },
  },
  {
    id: "civic",
    q: { en: "What is Civic?", te: "పౌర విభాగం అంటే ఏమిటి?" },
    a: {
      en: "Civic lets verified residents report local issues such as water or roads for their village. Reports are citizen-submitted and are not verified statistics.",
      te: "నీరు, రోడ్లు వంటి స్థానిక సమస్యలను తమ గ్రామానికి నమోదు చేయడానికి ధృవీకరించిన నివాసులకు పౌర విభాగం వీలు కల్పిస్తుంది. ఈ నివేదికలు పౌరులు ఇచ్చినవి; ధృవీకరించిన గణాంకాలు కావు.",
    },
  },
  {
    id: "privacy",
    q: { en: "What personal data do you keep?", te: "మీరు ఏ వ్యక్తిగత సమాచారం ఉంచుకుంటారు?" },
    a: {
      en: "Browsing the data pages needs no account. Civic sign-in uses a mobile number and PIN. Read the Privacy page for what is stored, who can see it and how to delete it.",
      te: "డేటా పేజీలను చూడటానికి ఖాతా అవసరం లేదు. పౌర విభాగం సైన్ ఇన్‌కు మొబైల్ నంబర్, పిన్ వాడతాము. ఏమి నిల్వ చేస్తామో, ఎవరు చూడగలరో, ఎలా తొలగించాలో గోప్యతా పేజీలో చదవండి.",
    },
  },
  {
    id: "census",
    q: { en: "Where does census context come from?", te: "జనగణన సందర్భం ఎక్కడి నుంచి వస్తుంది?" },
    a: {
      en: "District context uses Census of India 2011 Primary Census Abstract figures where loaded. If a district has no row, the page says so instead of estimating.",
      te: "జిల్లా సందర్భం భారత జనగణన 2011 ప్రాథమిక జనగణన సంగ్రహ (PCA) గణాంకాల నుంచి, అవి లోడ్ అయిన చోట. ఒక జిల్లాకు వరుస లేకపోతే, అంచనా వేయకుండా పేజీ ఆ విషయం చెబుతుంది.",
    },
  },
];

/* ------------------------------------------------------------------ Methodology */

export interface MethItem { id: string; h: Bi; p: Bi }

export const METHODOLOGY: MethItem[] = [
  {
    id: "elections",
    // copy-lint-allow: election-results content
    h: { en: "Election results", te: "ఎన్నికల ఫలితాలు" },
    p: {
      // copy-lint-allow: election-results content
      en: "Seat-level Assembly and Lok Sabha results for Andhra Pradesh and Telangana come from Election Commission of India data compiled by the Trivedi Centre for Political Data (TCPD). Vote share and margins are computed from those rows.",
      // copy-lint-allow: election-results content
      te: "ఆంధ్ర ప్రదేశ్, తెలంగాణ శాసనసభ, లోక్‌సభ నియోజకవర్గ స్థాయి ఫలితాలు భారత ఎన్నికల సంఘం డేటా నుంచి వస్తాయి; దానిని త్రివేది సెంటర్ ఫర్ పొలిటికల్ డేటా (TCPD) సంకలనం చేసింది. ఓట్ల శాతం, ఆధిక్యాలు ఆ వరుసల నుంచే లెక్కించబడతాయి.",
    },
  },
  {
    id: "census",
    h: { en: "Census context", te: "జనగణన సందర్భం" },
    p: {
      en: "District figures come from the Census of India 2011 Primary Census Abstract. Seat-to-district links use the district recorded in the election data. Where a district has no row, nothing is estimated.",
      te: "జిల్లా గణాంకాలు భారత జనగణన 2011 ప్రాథమిక జనగణన సంగ్రహం నుంచి వస్తాయి. నియోజకవర్గం-జిల్లా అనుసంధానం ఎన్నికల డేటాలో నమోదైన జిల్లా ఆధారంగా ఉంటుంది. ఒక జిల్లాకు వరుస లేకపోతే ఏదీ అంచనా వేయబడదు.",
    },
  },
  {
    id: "forecast",
    h: { en: "Outlook model", te: "అంచనా మోడల్" },
    p: {
      // copy-lint-allow: describes election-results data, not a survey
      en: "The Elections page shows a model projection from past results, with a range, a back-test against earlier elections and a calibration table. It is a mechanical extrapolation, not a survey and not an expectation of who will win. It is withheld during an election period and whenever the election calendar is not confirmed.",
      te: "ఎన్నికల పేజీ గత ఫలితాల ఆధారంగా మోడల్ అంచనాను చూపుతుంది: పరిధి, గత ఎన్నికలపై పరీక్ష, క్రమాంకన పట్టికతో. ఇది యాంత్రిక విస్తరణ మాత్రమే; సర్వే కాదు, ఎవరు గెలుస్తారన్న అంచనా కాదు. ఎన్నికల కాలంలో, లేదా ఎన్నికల క్యాలెండర్ నిర్ధారణ కానప్పుడు, ఇది నిలిపివేయబడుతుంది.",
    },
  },
  {
    id: "civic",
    h: { en: "Civic reports", te: "పౌర నివేదికలు" },
    p: {
      en: "Civic issue reports are submitted by verified residents. They are not representative statistics and are not combined with election data.",
      te: "పౌర సమస్యల నివేదికలను ధృవీకరించిన నివాసులు పంపుతారు. అవి ప్రాతినిధ్య గణాంకాలు కావు, ఎన్నికల డేటాతో కలపబడవు.",
    },
  },
  {
    id: "surveys",
    h: { en: "Surveys", te: "సర్వేలు" },
    p: {
      en: "Pulse Surveys are opinion surveys, not elections and not forecasts. Answers come from verified people who chose to take part, so this is not a random sample and no classical margin of error is printed. Figures appear once, after a survey closes and a delay, never live or in part, and always show the number of responses, the effective sample size, a verified-quality score with its parts, and the weighted and unweighted figures side by side. Weighting uses only published reference figures that exist today (the Census 2011 sex share by state and district); where none exists the two views are the same and the page says so. Areas with fewer than 30 responses are hidden and rolled into the larger area, counts are rounded to the nearest 5, and figures can be broken down by one thing at a time only. App and web answers are anonymous by design; phone and volunteer-assisted answers can be linked by the platform, so they are kept and reported separately.",
      te: "పల్స్ సర్వేలు అభిప్రాయ సర్వేలు మాత్రమే; ఇవి ఎన్నికలు కావు, ముందస్తు అంచనాలు కావు. స్వచ్ఛందంగా పాల్గొన్న ధృవీకరించబడిన వ్యక్తుల సమాధానాలు మాత్రమే ఉంటాయి, కాబట్టి ఇది యాదృచ్ఛిక నమూనా కాదు, సంప్రదాయ దోష పరిమితి ముద్రించము. సర్వే ముగిసి, ఆలస్యం గడిచాక ఒక్కసారి మాత్రమే గణాంకాలు వస్తాయి; ప్రత్యక్షంగా లేదా పాక్షికంగా ఎప్పుడూ రావు. వాటితో పాటు స్పందనల సంఖ్య, ప్రభావవంతమైన నమూనా పరిమాణం, భాగాలతో కూడిన ధృవీకరించిన నాణ్యత స్కోరు, బరువు వేసిన మరియు వేయని గణాంకాలు పక్కపక్కనే చూపబడతాయి. ఈరోజు ఉన్న ప్రచురిత ఆధార గణాంకాలనే (రాష్ట్రం, జిల్లా వారీగా జనగణన 2011 లింగ నిష్పత్తి) బరువుకు వాడతాము; ఏదీ లేకపోతే రెండూ ఒకటే అని పేజీ చెబుతుంది. 30 కంటే తక్కువ స్పందనలున్న ప్రాంతాలు దాచబడి పెద్ద ప్రాంతంలో కలుస్తాయి, సంఖ్యలు సమీప 5కు చుట్టబడతాయి, ఒక్కసారికి ఒక అంశం ప్రకారమే విభజన సాధ్యం. యాప్, వెబ్ సమాధానాలు రూపకల్పనలోనే అజ్ఞాతం; ఫోన్, వాలంటీర్ సహాయంతో వచ్చినవాటిని వేదిక అనుసంధానించగలదు కాబట్టి వాటిని వేరుగా ఉంచి వేరుగా చూపుతాము.",
    },
  },
];

/* ------------------------------------------------------------------ Privacy / terms */

export interface LegalSection { id: string; h: Bi; p: Bi }

export const PRIVACY: LegalSection[] = [
  {
    id: "browse",
    h: { en: "Browsing without an account", te: "ఖాతా లేకుండా చూడటం" },
    p: {
      en: "You can read every data page without signing in. The site does not use advertising or analytics trackers. Fonts are served from this site, so no font provider is contacted. Maps are drawn from boundary data and an OpenStreetMap background map, both served by this site, so no map provider is contacted.",
      te: "సైన్ ఇన్ చేయకుండానే అన్ని డేటా పేజీలను చదవవచ్చు. ఈ సైట్ ప్రకటనలు లేదా విశ్లేషణ ట్రాకర్లను వాడదు. ఫాంట్లు ఈ సైట్ నుంచే వస్తాయి, కాబట్టి ఏ ఫాంట్ సంస్థనూ సంప్రదించము. మ్యాప్‌లు ఈ సైట్ ఇచ్చే సరిహద్దు డేటాతో, ఈ సైట్ నుంచే వచ్చే ఓపెన్‌స్ట్రీట్‌మ్యాప్ నేపథ్య మ్యాప్‌తో గీయబడతాయి, కాబట్టి ఏ మ్యాప్ సంస్థనూ సంప్రదించము.",
    },
  },
  {
    id: "what",
    h: { en: "What we store when you sign up for Civic", te: "పౌర విభాగానికి సైన్ అప్ చేసినప్పుడు మేము ఏమి నిల్వ చేస్తాము" },
    p: {
      en: "Your mobile number (kept as a keyed hash; an encrypted copy only to send one-time codes and notices), the village you declare, and a record of each consent you give with its version and date. We never store Aadhaar. A PIN you choose is stored only as a salted hash.",
      te: "మీ మొబైల్ నంబర్ (కీడ్ హాష్‌గా; ఒకసారి వాడే కోడ్‌లు, నోటీసులు పంపడానికి మాత్రమే ఎన్‌క్రిప్టెడ్ కాపీ), మీరు ప్రకటించిన గ్రామం, మీరు ఇచ్చిన ప్రతి అంగీకారం వెర్షన్, తేదీతో సహా. ఆధార్‌ను ఎప్పుడూ నిల్వ చేయము. మీరు ఎంచుకున్న పిన్‌ను సాల్ట్ చేసిన హాష్‌గా మాత్రమే నిల్వ చేస్తాము.",
    },
  },
  {
    id: "why",
    h: { en: "Why", te: "ఎందుకు" },
    p: {
      en: "To let you report local issues and, when surveys exist, to take part once per person. This is not an election. Answering anything here will not affect your pension, ration card or any benefit, and nothing here is linked to scheme eligibility.",
      te: "స్థానిక సమస్యలను నివేదించడానికి, సర్వేలు వచ్చినప్పుడు ఒక్కొక్కరు ఒక్కసారి పాల్గొనడానికి. ఇది ఎన్నిక కాదు. ఇక్కడ దేనికి సమాధానం ఇచ్చినా మీ పింఛను, రేషన్ కార్డు లేదా ఏ ప్రయోజనంపైనా ప్రభావం ఉండదు; ఇక్కడి సమాచారం పథకాల అర్హతతో అనుసంధానించబడదు.",
    },
  },
  {
    id: "who",
    h: { en: "Who can see it", te: "ఎవరు చూడగలరు" },
    p: {
      en: "Officials and public representatives see issues and totals for their own area, never individual survey answers. See the Who sees what page for each role.",
      te: "అధికారులు, ప్రజా ప్రతినిధులు తమ ప్రాంతపు సమస్యలను, మొత్తం సంఖ్యలను చూస్తారు; వ్యక్తిగత సర్వే సమాధానాలను ఎప్పుడూ చూడరు. ప్రతి పాత్రకు వివరాలు 'ఎవరు ఏమి చూస్తారు' పేజీలో ఉన్నాయి.",
    },
  },
  {
    id: "rights",
    h: { en: "Your rights", te: "మీ హక్కులు" },
    p: {
      en: "You can ask to see, correct or erase your data, or complain, through the grievance officer. Withdrawing consent deletes your account data on the schedule in the retention table. The grievance officer is not yet appointed; until then this page is a draft.",
      te: "మీ డేటాను చూడమని, సవరించమని, తొలగించమని అడగవచ్చు, లేదా ఫిర్యాదు చేయవచ్చు; ఫిర్యాదుల అధికారి ద్వారా. అంగీకారం ఉపసంహరిస్తే, నిలుపుదల పట్టిక ప్రకారం మీ ఖాతా డేటా తొలగించబడుతుంది. ఫిర్యాదుల అధికారిని ఇంకా నియమించలేదు; అప్పటివరకు ఈ పేజీ ముసాయిదా మాత్రమే.",
    },
  },
  {
    id: "children",
    h: { en: "Children", te: "పిల్లలు" },
    p: {
      en: "A parent or guardian may add a child under 18 as a dependent: only the year of birth and relation are stored, no name. The child never has an account and is never asked a survey question. The record is erased when the child turns 18, or earlier if you remove it.",
      te: "తల్లిదండ్రులు లేదా సంరక్షకులు 18 ఏళ్ల లోపు పిల్లవాడిని ఆధారితునిగా చేర్చవచ్చు: పుట్టిన సంవత్సరం, బంధుత్వం మాత్రమే నిల్వ చేస్తాము, పేరు కాదు. పిల్లవాడికి ఖాతా ఉండదు, ఏ సర్వే ప్రశ్నా అడగము. పిల్లవాడికి 18 ఏళ్లు వచ్చినప్పుడు, లేదా మీరు తొలగిస్తే ముందే, రికార్డు తొలగించబడుతుంది.",
    },
  },
];

export const TERMS: LegalSection[] = [
  {
    id: "what",
    h: { en: "What this site is", te: "ఈ సైట్ ఏమిటి" },
    p: {
      en: "A public-data site for Andhra Pradesh and Telangana: past election data, census context, a clearly labelled model projection, and citizen-reported local issues. It is not run by, endorsed by or connected to any political party, government body or the Election Commission.",
      te: "ఆంధ్ర ప్రదేశ్, తెలంగాణ కోసం ప్రజా సమాచార సైట్: గత ఎన్నికల డేటా, జనగణన సందర్భం, స్పష్టంగా గుర్తించిన మోడల్ అంచనా, పౌరులు నివేదించిన స్థానిక సమస్యలు. దీనిని ఏ రాజకీయ పార్టీ, ప్రభుత్వ సంస్థ లేదా ఎన్నికల సంఘం నడపడం లేదు, సమర్థించడం లేదు, దానితో సంబంధం లేదు.",
    },
  },
  {
    id: "not-election",
    h: { en: "Not an election, not advice", te: "ఎన్నిక కాదు, సలహా కాదు" },
    p: {
      // copy-lint-allow: disclaimer that this is not an election
      en: "Nothing here is an official election, a binding vote or an official count. The outlook is a mechanical projection from past data, not a poll and not a prediction. Do not rely on it for any decision.",
      te: "ఇక్కడ ఏదీ అధికారిక ఎన్నిక, కట్టుబడే ఓటింగ్, లేదా అధికారిక లెక్కింపు కాదు. అంచనా గత డేటా ఆధారంగా యాంత్రికంగా చేసిన ప్రక్షేపణ మాత్రమే; అది పోల్ కాదు, ముందస్తు ప్రకటన కాదు. ఏ నిర్ణయానికీ దానిపై ఆధారపడకండి.",
    },
  },
  {
    id: "reports",
    h: { en: "Reports you submit", te: "మీరు పంపే నివేదికలు" },
    p: {
      en: "Report only what you know. Do not name private individuals or post abuse, threats or false claims. We may hide or remove reports that break these rules, and you can ask for a review.",
      te: "మీకు తెలిసినదే నివేదించండి. వ్యక్తులను పేరు పెట్టి ప్రస్తావించవద్దు; దూషణలు, బెదిరింపులు, తప్పుడు ఆరోపణలు పోస్ట్ చేయవద్దు. ఈ నియమాలను ఉల్లంఘించే నివేదికలను మేము దాచవచ్చు లేదా తొలగించవచ్చు; సమీక్ష కోరే హక్కు మీకు ఉంది.",
    },
  },
  {
    id: "accuracy",
    h: { en: "Accuracy", te: "కచ్చితత్వం" },
    p: {
      en: "We show the source and date of every figure and mark synthetic demo data. Data can contain errors from its sources. Citizen reports are not verified statistics.",
      te: "ప్రతి సంఖ్యకు మూలం, తేదీ చూపుతాము; కృత్రిమ డెమో డేటాను గుర్తిస్తాము. మూల డేటాలో పొరపాట్లు ఉండవచ్చు. పౌర నివేదికలు ధృవీకరించిన గణాంకాలు కావు.",
    },
  },
  {
    id: "changes",
    h: { en: "Changes and contact", te: "మార్పులు, సంప్రదింపు" },
    p: {
      en: "These terms may change; the version and date will be shown here. Contact details for the grievance officer will be published here once appointed.",
      te: "ఈ నిబంధనలు మారవచ్చు; వెర్షన్, తేదీ ఇక్కడ చూపబడతాయి. ఫిర్యాదుల అధికారి నియమితులయ్యాక వారి సంప్రదింపు వివరాలు ఇక్కడ ప్రచురిస్తాము.",
    },
  },
];

/* ------------------------------------------------------------------ Who sees what (DESIGN_2028 section 5) */

export const ROLES = ["citizen", "volunteer", "politician", "journalist", "officer", "admin"] as const;
export type RoleId = (typeof ROLES)[number];

export const ROLE_LABELS: Record<RoleId, Bi> = {
  citizen: { en: "You and your household head", te: "మీరు, మీ కుటుంబ పెద్ద" },
  volunteer: { en: "Village volunteer", te: "గ్రామ స్వచ్ఛంద కార్యకర్త" },
  politician: { en: "MLA, MP or ward member", te: "ఎమ్మెల్యే, ఎంపీ లేదా వార్డు సభ్యుడు" },
  journalist: { en: "Verified journalist", te: "ధృవీకరించిన పాత్రికేయుడు" },
  officer: { en: "Officer or department", te: "అధికారి లేదా శాఖ" },
  admin: { en: "Platform administrator", te: "ప్లాట్‌ఫామ్ నిర్వాహకుడు" },
};

export interface WhoRow { id: string; label: Bi; cells: Record<RoleId, Bi> }

const NO: Bi = { en: "No", te: "లేదు" };

export const WHO_SEES: WhoRow[] = [
  {
    id: "phone",
    label: { en: "Your mobile number", te: "మీ మొబైల్ నంబర్" },
    cells: {
      citizen: { en: "Yes, your own", te: "అవును, మీదే" },
      volunteer: NO, politician: NO, journalist: NO, officer: NO,
      admin: { en: "Not readable: stored as a keyed hash, keys held in a key vault", te: "చదవలేరు: కీడ్ హాష్‌గా నిల్వ, కీలు కీ వాల్ట్‌లో" },
    },
  },
  {
    id: "household",
    label: { en: "Your household members", te: "మీ కుటుంబ సభ్యులు" },
    cells: {
      citizen: { en: "Yes, your own household", te: "అవును, మీ కుటుంబం మాత్రమే" },
      volunteer: { en: "Only to help an adult without a phone, with that person's consent", te: "ఫోన్ లేని పెద్దవారికి సహాయం చేయడానికి మాత్రమే, వారి అంగీకారంతో" },
      politician: NO, journalist: NO, officer: NO, admin: NO,
    },
  },
  {
    id: "issues",
    label: { en: "Local issues you report", te: "మీరు నివేదించే స్థానిక సమస్యలు" },
    cells: {
      citizen: { en: "Yes, your own reports", te: "అవును, మీ నివేదికలు" },
      volunteer: { en: "Yes, to sort and route them", te: "అవును, క్రమబద్ధీకరించి పంపడానికి" },
      politician: { en: "Issues and totals for their own area, not who you are", te: "తమ ప్రాంతపు సమస్యలు, మొత్తాలు; మీరెవరో కాదు" },
      journalist: { en: "The same open issue feed as everyone", te: "అందరికీ ఉన్న బహిరంగ సమస్యల జాబితానే" },
      officer: { en: "Issues assigned to them; can update status, cannot edit or delete a report", te: "తమకు కేటాయించినవి; స్థితి మార్చవచ్చు, నివేదికను మార్చలేరు, తొలగించలేరు" },
      admin: { en: "Runs the servers only", te: "సర్వర్లను నడపడం మాత్రమే" },
    },
  },
  {
    id: "answers",
    label: { en: "Your survey answers (when surveys exist)", te: "మీ సర్వే సమాధానాలు (సర్వేలు వచ్చినప్పుడు)" },
    cells: {
      citizen: { en: "Only your own", te: "మీవి మాత్రమే" },
      volunteer: NO,
      politician: { en: "Totals only, never individuals", te: "మొత్తాలు మాత్రమే, వ్యక్తులను కాదు" },
      journalist: { en: "Open totals only", te: "బహిరంగ మొత్తాలు మాత్రమే" },
      officer: { en: "Totals only; cannot hide them", te: "మొత్తాలు మాత్రమే; వాటిని దాచలేరు" },
      admin: { en: "No. Keys sit in a key vault; emergency access needs two people and is logged", te: "లేదు. కీలు కీ వాల్ట్‌లో; అత్యవసర ప్రవేశానికి ఇద్దరు కావాలి, నమోదవుతుంది" },
    },
  },
  {
    id: "totals",
    label: { en: "Published totals and election data", te: "ప్రచురించిన మొత్తాలు, ఎన్నికల డేటా" },
    cells: {
      citizen: { en: "Yes", te: "అవును" }, volunteer: { en: "Yes", te: "అవును" }, politician: { en: "Yes", te: "అవును" },
      journalist: { en: "Yes, no early access", te: "అవును, ముందస్తు ప్రవేశం లేదు" }, officer: { en: "Yes", te: "అవును" }, admin: { en: "Yes", te: "అవును" },
    },
  },
];

export const WHO_NOTES: Bi[] = [
  {
    en: "Every privileged read of personal data is written to a tamper-evident audit log.",
    te: "వ్యక్తిగత డేటాను ప్రత్యేక అనుమతితో చదివిన ప్రతిసారీ ఒక ఆడిట్ లాగ్‌లో నమోదవుతుంది; గుర్తించకుండా దాన్ని మార్చలేరు.",
  },
  {
    en: "This table is a draft of the design in DESIGN_2028 section 5. Roles other than residents are not live yet.",
    te: "ఈ పట్టిక DESIGN_2028 లోని 5వ విభాగపు రూపకల్పన ముసాయిదా. నివాసులు కాకుండా ఇతర పాత్రలు ఇంకా అమలులో లేవు.",
  },
];
