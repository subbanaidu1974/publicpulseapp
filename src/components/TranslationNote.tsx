import { useT } from "../i18n";
import type { ReviewStatus } from "../i18n/content";

/** Shown on Telugu long-form pages until a named native-speaker reviewer signs off (reviewStatus !== "reviewed"). */
export function TranslationNote({ status }: { status: ReviewStatus }) {
  const { t, lang } = useT();
  if (lang !== "te" || status === "reviewed") return null;
  return (
    <p data-testid="translation-review-note" role="note" className="text-[10px] font-sans text-slate-700 border border-slate-400 bg-slate-100 px-3 py-1.5">
      {t("i18n.review")}
    </p>
  );
}
