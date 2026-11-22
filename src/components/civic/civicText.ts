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
};

export function useCivicT(): (k: CivicKey) => string {
  const { lang } = useT();
  return (k) => (lang === "te" ? TE[k] : EN[k]);
}
export const CATEGORY_IDS = ["water", "roads", "electricity", "health", "education", "other"] as const;
