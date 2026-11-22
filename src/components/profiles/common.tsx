import type { ReactNode } from "react";
import { useT } from "../../i18n";
import type { SourceInfo } from "../../api/profiles";

/** English or Telugu display name; the other language, when it exists, is shown as a quiet second line by callers. */
export function useDisplayName() {
  const { lang } = useT();
  return (x: { nameEn: string | null; nameTe?: string }) => (lang === "te" ? x.nameTe ?? x.nameEn ?? "" : x.nameEn ?? "");
}

export function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="space-y-1">
      <h3 className="text-[10px] uppercase tracking-widest font-black">{title}</h3>
      {children}
    </section>
  );
}

export function Stat({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId}>
      <dt className="text-slate-600">{label}</dt>
      <dd className="font-bold">{value}</dd>
    </div>
  );
}

export const num = (n: number | null | undefined, na: string) => (typeof n === "number" ? n.toLocaleString("en-IN") : na);
export const pctText = (n: number | null | undefined, na: string) => (typeof n === "number" ? `${n.toFixed(1)}%` : na);

/** Attribution lines from the API `source` envelope, so every figure on a profile page has a visible origin. */
export function Sources({ sources, asOf, demo }: { sources?: SourceInfo[]; asOf?: string | null; demo?: boolean }) {
  const { t } = useT();
  const seen = new Set<string>();
  const list = (sources ?? []).filter(s => !seen.has(s.attribution) && seen.add(s.attribution));
  return (
    <div data-testid="profile-sources" className="border-t border-black/10 pt-2 text-[10px] font-sans text-slate-600 space-y-0.5">
      <strong className="uppercase tracking-widest">{t("prof.sources")}</strong>
      {list.map(s => <p key={s.dataset}>{s.attribution}</p>)}
      {list.length === 0 && <p>{t("prof.sourcesNone")}</p>}
      {asOf && <p>{t("prof.asOf")} {asOf}{demo ? ` (${t("common.demo")})` : ""}</p>}
    </div>
  );
}
