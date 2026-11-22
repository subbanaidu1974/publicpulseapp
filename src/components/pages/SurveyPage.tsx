import { useT } from "../../i18n";

/** Honest placeholder: no survey is collected or shown in this phase. */
export default function SurveyPage() {
  const { t } = useT();
  return (
    <section data-testid="survey-coming-soon" className="max-w-2xl mx-auto bg-[#FAF8F5] border border-black/20 p-6 sm:p-10 space-y-4">
      <span className="text-[10px] uppercase tracking-[0.25em] font-sans font-black bg-amber-200 text-amber-950 border border-amber-700 px-2 py-0.5 inline-block">{t("survey.soonBadge")}</span>
      <h2 className="text-2xl font-serif italic">{t("survey.title")}</h2>
      <p className="text-sm font-serif leading-relaxed">{t("survey.body")}</p>
      <button type="button" data-testid="survey-to-civic" onClick={() => window.dispatchEvent(new CustomEvent("pp-nav", { detail: "civic" }))} className="border border-black bg-black text-[#F9F7F2] px-5 py-2.5 text-[10px] uppercase tracking-widest font-black cursor-pointer">
        {t("survey.cta")}
      </button>
    </section>
  );
}
