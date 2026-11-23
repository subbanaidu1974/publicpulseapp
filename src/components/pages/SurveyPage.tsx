import ConsultationsRoot from "../consultations/ConsultationsRoot";
import SurveysRoot from "../surveys/SurveysRoot";
import { useHash } from "../surveys/shared";

/** Pulse Surveys tab: registry, detail, take flow, published figures, creator console and panel (hash routes under #/surveys); also hosts #/consultations. */
export default function SurveyPage() {
  const hash = useHash();
  return /^#\/consultations(\/|$)/.test(hash) ? <ConsultationsRoot /> : <SurveysRoot />;
}
