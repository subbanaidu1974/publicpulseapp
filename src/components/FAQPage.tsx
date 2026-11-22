import { useState } from "react";
import { useT } from "../i18n";
import { FAQS, reviewStatus } from "../i18n/content";
import { TranslationNote } from "./TranslationNote";

/** Honest FAQ: only what the product does today. Text lives in src/i18n/content.ts (EN and TE together). */
export default function FAQPage() {
  const { t, lang } = useT();
  const [openId, setOpenId] = useState<string | null>(FAQS[0].id);
  return (
    <div className="max-w-3xl mx-auto space-y-4" lang={lang}>
      <h2 className="text-2xl font-serif italic">{t("nav.faq")}</h2>
      <TranslationNote status={reviewStatus.faq} />
      <div className="space-y-2">
        {FAQS.map((f) => {
          const open = openId === f.id;
          return (
            <div key={f.id} className="bg-[#FAF8F5] border border-black/20">
              <h3>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={`faq-${f.id}`}
                  onClick={() => setOpenId(open ? null : f.id)}
                  className="w-full text-left px-4 py-3 font-serif font-bold text-sm cursor-pointer"
                >
                  {f.q[lang]}
                </button>
              </h3>
              {open && <p id={`faq-${f.id}`} className="px-4 pb-4 text-xs font-serif leading-relaxed">{f.a[lang]}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
