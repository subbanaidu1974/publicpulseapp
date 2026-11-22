import { useT } from "../../i18n";

const EN = {
  "c.title": "Civic: report and track local issues",
  "c.intro": "Report a local issue, see what others reported. This is not an election and no result is published from it.",
  "c.signup": "Sign up", "c.login": "Log in", "c.logout": "Log out",
  "c.phone": "Mobile number (10 digits)", "c.otp": "One-time code", "c.pin": "Choose a 4 to 6 digit PIN", "c.pinLogin": "PIN",
  "c.sendOtp": "Send code", "c.next": "Continue", "c.submit": "Submit",
  "c.devOtp": "Dev code (simulation only)",
  "c.consentRead": "I have read the notice and I agree",
  "c.consentTitle": "How People Pulse uses your data",
  "c.consentPending": "The notice text is loading from the compliance module.",
  "c.grievance": "Grievance contact",
  "c.scam": "We never call or message to ask for your OTP, PIN or bank details.",
  "c.welcome": "You are signed in.",
  "c.household": "Household",
  "c.reportTitle": "Report an issue", "c.category": "Category", "c.text": "Describe the issue",
  "c.voice": "Voice note (optional)", "c.village": "Search your village", "c.villageNone": "No village found",
  "c.feed": "Recent issues", "c.feedEmpty": "No issues yet.",
  "c.sent": "Issue reported. Reference",
  "c.error": "Something went wrong. Please try again.",
  "c.cat.water": "Water", "c.cat.roads": "Roads", "c.cat.electricity": "Electricity", "c.cat.health": "Health", "c.cat.education": "School", "c.cat.other": "Other",
  "c.lite": "Lite mode: no maps, small download.",
  "c.loading": "Loading...", "c.noticeFail": "Could not load the notice",
  "c.draft": "Draft - needs legal review", "c.version": "Version",
  "c.agree": "I have read this notice and I agree", "c.accept": "Accept", "c.decline": "Decline",
  "h.title": "My household",
  "h.intro": "The household head can see who is a member, never their answers. Adults join only by accepting an invite with their own PIN.",
  "h.create": "Create household", "h.created": "Household created",
  "h.members": "Members", "h.head": "Head", "h.you": "you", "h.dependentBorn": "dependent, born",
  "h.makeHead": "Make head", "h.transferred": "Head role transferred", "h.remove": "Remove", "h.leave": "Leave", "h.removed": "Removed",
  "h.pending": "invited, waiting for their acceptance. Expires",
  "h.inviteTitle": "Invite an adult",
  "h.inviteNote": "They receive a notice by SMS first. Nothing about them is stored until they accept. The invite expires in 72 hours.",
  "h.mobile": "Mobile number", "h.relation": "Relation", "h.sendInvite": "Send invite", "h.inviteSent": "Invitation notice sent",
  "h.depTitle": "Add a child (under 18)", "h.yob": "Year of birth", "h.continue": "Continue",
  "h.parentConsent": "I consent as parent or guardian", "h.depAdded": "Dependent added",
  "s.pending": "Pending", "s.accepted": "Accepted", "s.dependent": "Dependent",
  "r.spouse": "Spouse", "r.parent": "Parent", "r.son": "Son", "r.daughter": "Daughter", "r.sibling": "Sibling", "r.relative": "Relative", "r.other": "Other", "r.grandchild": "Grandchild", "r.ward": "Ward",
} as const;
export type CivicKey = keyof typeof EN;

const TE: Record<CivicKey, string> = {
  "c.title": "పౌర విభాగం: స్థానిక సమస్యలు నమోదు చేసి ట్రాక్ చేయండి",
  "c.intro": "స్థానిక సమస్యను నమోదు చేయండి, ఇతరులు నమోదు చేసినవి చూడండి. ఇది ఎన్నిక కాదు, దీని నుండి ఫలితం ప్రచురించబడదు.",
  "c.signup": "నమోదు", "c.login": "లాగిన్", "c.logout": "లాగౌట్",
  "c.phone": "మొబైల్ నంబర్ (10 అంకెలు)", "c.otp": "ఒకసారి వాడే కోడ్", "c.pin": "4 నుండి 6 అంకెల PIN ఎంచుకోండి", "c.pinLogin": "PIN",
  "c.sendOtp": "కోడ్ పంపు", "c.next": "కొనసాగించు", "c.submit": "సమర్పించు",
  "c.devOtp": "డెవ్ కోడ్ (అనుకరణ మాత్రమే)",
  "c.consentRead": "నేను నోటీసు చదివాను, అంగీకరిస్తున్నాను",
  "c.consentTitle": "పీపుల్ పల్స్ మీ డేటాను ఎలా ఉపయోగిస్తుంది",
  "c.consentPending": "నోటీసు పాఠ్యం కంప్లయన్స్ విభాగం నుండి లోడ్ అవుతోంది.",
  "c.grievance": "ఫిర్యాదు సంప్రదింపు",
  "c.scam": "మేము మీ OTP, PIN లేదా బ్యాంకు వివరాలు అడగడానికి ఎప్పుడూ ఫోన్ లేదా సందేశం పంపము.",
  "c.welcome": "మీరు సైన్ ఇన్ అయ్యారు.",
  "c.household": "కుటుంబం",
  "c.reportTitle": "సమస్య నమోదు", "c.category": "రకం", "c.text": "సమస్యను వివరించండి",
  "c.voice": "వాయిస్ నోట్ (ఐచ్ఛికం)", "c.village": "మీ గ్రామం వెతకండి", "c.villageNone": "గ్రామం కనబడలేదు",
  "c.feed": "ఇటీవలి సమస్యలు", "c.feedEmpty": "ఇంకా సమస్యలు లేవు.",
  "c.sent": "సమస్య నమోదైంది. రిఫరెన్స్",
  "c.error": "ఏదో తప్పు జరిగింది. దయచేసి మళ్ళీ ప్రయత్నించండి.",
  "c.cat.water": "నీరు", "c.cat.roads": "రోడ్లు", "c.cat.electricity": "విద్యుత్", "c.cat.health": "ఆరోగ్యం", "c.cat.education": "పాఠశాల", "c.cat.other": "ఇతరం",
  "c.lite": "లైట్ మోడ్: మ్యాప్‌లు లేవు, చిన్న డౌన్‌లోడ్.",
  "c.loading": "లోడ్ అవుతోంది...", "c.noticeFail": "నోటీసును లోడ్ చేయడం సాధ్యం కాలేదు",
  "c.draft": "ముసాయిదా - న్యాయ సమీక్ష అవసరం", "c.version": "వెర్షన్",
  "c.agree": "నేను ఈ నోటీసు చదివాను మరియు అంగీకరిస్తున్నాను", "c.accept": "అంగీకరిస్తున్నాను", "c.decline": "తిరస్కరిస్తున్నాను",
  "h.title": "నా కుటుంబం",
  "h.intro": "కుటుంబ పెద్దకు సభ్యులు ఎవరో మాత్రమే తెలుస్తుంది, వారి సమాధానాలు కాదు. పెద్దలు తమ సొంత పిన్‌తో ఆహ్వానాన్ని అంగీకరించి మాత్రమే చేరతారు.",
  "h.create": "కుటుంబాన్ని సృష్టించు", "h.created": "కుటుంబం సృష్టించబడింది",
  "h.members": "సభ్యులు", "h.head": "పెద్ద", "h.you": "మీరు", "h.dependentBorn": "ఆధారితుడు, పుట్టిన సంవత్సరం",
  "h.makeHead": "పెద్దగా చేయి", "h.transferred": "పెద్ద బాధ్యత బదిలీ అయింది", "h.remove": "తొలగించు", "h.leave": "వైదొలగు", "h.removed": "తొలగించబడింది",
  "h.pending": "ఆహ్వానించబడింది, వారి అంగీకారం కోసం వేచి ఉంది. ముగింపు",
  "h.inviteTitle": "పెద్దవారిని ఆహ్వానించు",
  "h.inviteNote": "ముందుగా వారికి SMS ద్వారా నోటీసు వస్తుంది. వారు అంగీకరించే వరకు వారి గురించి ఏమీ నిల్వ చేయము. ఆహ్వానం 72 గంటల్లో ముగుస్తుంది.",
  "h.mobile": "మొబైల్ నంబర్", "h.relation": "బంధుత్వం", "h.sendInvite": "ఆహ్వానం పంపు", "h.inviteSent": "ఆహ్వాన నోటీసు పంపబడింది",
  "h.depTitle": "పిల్లవాడిని చేర్చు (18 లోపు)", "h.yob": "పుట్టిన సంవత్సరం", "h.continue": "కొనసాగు",
  "h.parentConsent": "తల్లిదండ్రులు/సంరక్షకుడిగా అంగీకరిస్తున్నాను", "h.depAdded": "ఆధారితుడు చేర్చబడ్డారు",
  "s.pending": "పెండింగ్", "s.accepted": "అంగీకరించారు", "s.dependent": "ఆధారితుడు",
  "r.spouse": "భార్య/భర్త", "r.parent": "తల్లి/తండ్రి", "r.son": "కొడుకు", "r.daughter": "కూతురు", "r.sibling": "తోబుట్టువు", "r.relative": "బంధువు", "r.other": "ఇతరం", "r.grandchild": "మనవడు/మనవరాలు", "r.ward": "సంరక్షణలో ఉన్నవారు",
};

export function useCivicT(): (k: CivicKey) => string {
  const { lang } = useT();
  return (k) => (lang === "te" ? TE[k] : EN[k]);
}
/** Translate a relation or status value when a key exists, else show it as is. */
export function labelFor(c: (k: CivicKey) => string, prefix: "r" | "s", v: string): string {
  const k = `${prefix}.${v}` as CivicKey;
  return k in EN ? c(k) : v;
}
export const CATEGORY_IDS = ["water", "roads", "electricity", "health", "education", "other"] as const;
