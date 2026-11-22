import { useT } from "../../i18n";
import { METHODOLOGY, reviewStatus } from "../../i18n/content";
import DataStatusPanel from "../DataStatusPanel";
import { TranslationNote } from "../TranslationNote";

export default function MethodologyPage() {
  const { t, lang } = useT();
  return (
    <div className="space-y-8" lang={lang}>
      <div className="border-b border-black pb-4 space-y-2">
        <h2 className="text-2xl font-serif italic">{t("meth.title")}</h2>
        <p className="text-xs font-sans mt-1 max-w-2xl">{t("meth.lead")}</p>
        <TranslationNote status={reviewStatus.methodology} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {METHODOLOGY.map((i) => (
          <div key={i.id} className="bg-[#FAF8F5] border border-black/20 p-5">
            <h3 className="text-sm font-sans font-black uppercase tracking-widest mb-2">{i.h[lang]}</h3>
            <p className="text-xs font-serif leading-relaxed">{i.p[lang]}</p>
          </div>
        ))}
      </div>
      <DataStatusPanel testId="data-status-public" />
    </div>
  );
}
