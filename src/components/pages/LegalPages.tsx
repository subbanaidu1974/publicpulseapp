import type { ReactNode } from "react";
import { useT } from "../../i18n";
import { PRIVACY, ROLES, ROLE_LABELS, TERMS, WHO_NOTES, WHO_SEES, reviewStatus } from "../../i18n/content";
import type { LegalSection, ReviewStatus } from "../../i18n/content";
import { TranslationNote } from "../TranslationNote";

const DRAFT_VERSION = "draft-1";

function DraftBanner() {
  const { t } = useT();
  return (
    <p data-testid="legal-draft" role="note" className="text-[10px] uppercase tracking-widest font-sans font-black bg-amber-200 text-amber-950 border border-amber-700 px-3 py-2">
      {t("legal.draft")}
    </p>
  );
}

function Sections({ items, testId }: { items: LegalSection[]; testId: string }) {
  const { lang } = useT();
  return (
    <div data-testid={testId} lang={lang} className="space-y-5">
      {items.map((s) => (
        <section key={s.id} aria-labelledby={`${testId}-${s.id}`} className="bg-[#FAF8F5] border border-black/20 p-5">
          <h3 id={`${testId}-${s.id}`} className="text-sm font-sans font-black uppercase tracking-widest mb-2">{s.h[lang]}</h3>
          <p className="text-sm font-serif leading-relaxed">{s.p[lang]}</p>
        </section>
      ))}
    </div>
  );
}

function Shell({ title, lead, status, children, testId }: { title: string; lead: string; status: ReviewStatus; children: ReactNode; testId: string }) {
  const { t } = useT();
  return (
    <div data-testid={testId} className="max-w-3xl mx-auto space-y-5">
      <div className="border-b border-black pb-4 space-y-2">
        <h2 className="text-2xl font-serif italic">{title}</h2>
        <p className="text-xs font-sans max-w-2xl">{lead}</p>
        <p className="text-[10px] font-sans text-slate-600">{t("legal.version")}: {DRAFT_VERSION}</p>
      </div>
      <DraftBanner />
      <TranslationNote status={status} />
      {children}
    </div>
  );
}

export function PrivacyPage() {
  const { t } = useT();
  return (
    <Shell testId="privacy-page" title={t("legal.privacyTitle")} lead={t("legal.privacyLead")} status={reviewStatus.privacy}>
      <Sections items={PRIVACY} testId="privacy-sections" />
    </Shell>
  );
}

export function TermsPage() {
  const { t } = useT();
  return (
    <Shell testId="terms-page" title={t("legal.termsTitle")} lead={t("legal.termsLead")} status={reviewStatus.terms}>
      <Sections items={TERMS} testId="terms-sections" />
    </Shell>
  );
}

export function WhoSeesPage() {
  const { t, lang } = useT();
  return (
    <Shell testId="who-sees-page" title={t("legal.whoTitle")} lead={t("legal.whoLead")} status={reviewStatus.whoSees}>
      <div lang={lang} tabIndex={0} role="region" aria-label={t("legal.whoTitle")} className="overflow-x-auto bg-[#FAF8F5] border border-black/20">
        <table data-testid="who-sees-table" className="w-full text-xs font-sans border-collapse min-w-[720px]">
          <caption className="sr-only">{t("legal.whoTitle")}</caption>
          <thead>
            <tr className="text-left border-b border-black">
              <th scope="col" className="p-2">{t("legal.dataType")}</th>
              {ROLES.map((r) => <th key={r} scope="col" className="p-2 align-bottom">{ROLE_LABELS[r][lang]}</th>)}
            </tr>
          </thead>
          <tbody>
            {WHO_SEES.map((row) => (
              <tr key={row.id} data-testid={`who-row-${row.id}`} className="border-b border-black/10 align-top">
                <th scope="row" className="p-2 text-left font-bold">{row.label[lang]}</th>
                {ROLES.map((r) => <td key={r} className="p-2">{row.cells[r][lang]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="text-[11px] font-serif space-y-1 list-disc pl-5" lang={lang}>
        {WHO_NOTES.map((n, i) => <li key={i}>{n[lang]}</li>)}
      </ul>
    </Shell>
  );
}
