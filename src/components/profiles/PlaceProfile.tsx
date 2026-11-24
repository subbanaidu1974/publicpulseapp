import { civicUnit, profiles } from "../../api/profiles";
import type { PlaceProfileData } from "../../api/profiles";
import { useApi } from "../../api/useApi";
import { STATES } from "../../lib/states";
import type { StateCode } from "../../lib/states";
import { useT } from "../../i18n";
import { ErrorBanner, Loading } from "../ui";
import { IssuesBlock } from "./ConstituencyProfile";
import { Section, Sources, Stat, num, pctText, useDisplayName } from "./common";

/** Mandal, village or district profile (S-99). Census rows are joined by Census 2011 code; a missing row is shown as not available, never as zero. */
export default function PlaceProfile({ state, level, code }: { state: StateCode; level: "district" | "mandal" | "village"; code: string }) {
  const { t, lang } = useT();
  const dn = useDisplayName();
  const prof = useApi<PlaceProfileData>(() => profiles.place(state, level, code), [state, level, code]);
  const na = t("cs.na");

  if (prof.loading) return <div data-testid="place-profile"><Loading /></div>;
  if (prof.error || !prof.data) {
    return (
      <div data-testid="place-profile">
        <ErrorBanner inline message={prof.error ?? "error"} onRetry={prof.retry} />
      </div>
    );
  }
  const p = prof.data;
  const c = p.census;
  const other = lang === "te" ? p.nameEn : p.nameTe;
  const acs = p.constituencies ?? (p.constituency ? [p.constituency] : []);
  const levelLabel = t(level === "district" ? "prof.district" : level === "mandal" ? "prof.mandal" : "prof.village");

  return (
    <div data-testid="place-profile" data-level={level} className="bg-white border border-black p-4 space-y-4">
      <div>
        <p className="text-[10px] uppercase tracking-widest font-black text-slate-600">{levelLabel}</p>
        <h4 className="text-xl font-serif italic" data-testid="profile-title">{dn(p)}</h4>
        {other && <p className="text-[11px] font-sans text-slate-600" data-testid="profile-name-other">{other}</p>}
        {!p.nameTe && lang === "te" && <p className="text-[10px] text-slate-600">{t("prof.noTeluguName")}</p>}
        <p className="text-[11px] font-sans text-slate-600" data-testid="profile-path">
          {[lang === "te" ? STATES[state].nameTe : STATES[state].name, ...p.path.filter(x => x.level !== "state").map(x => dn({ nameEn: x.nameEn ?? x.name ?? "", nameTe: x.nameTe }))].join(" / ")}
        </p>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-xs font-sans">
        {level === "village" && p.category && <Stat label={t("prof.kind")} value={p.category === "R" ? t("prof.rural") : p.category === "U" ? t("prof.urban") : na} />}
        {p.mandals !== undefined && <Stat label={t("prof.mandals")} value={num(p.mandals, na)} />}
        {p.villages !== undefined && <Stat label={t("prof.villages")} value={num(p.villages, na)} />}
      </dl>

      <Section title={t("prof.constituency")} testId="profile-constituencies">
        {acs.length === 0 ? <p className="text-xs font-sans">{t("prof.noConstituency")}</p> : (
          <ul className="text-xs font-sans space-y-0.5">
            {acs.map(a => (
              <li key={a.acNo}><a className="underline" href={a.href} data-testid="constituency-link">{dn(a)} (#{a.acNo}{a.reservation && a.reservation !== "GEN" ? `, ${a.reservation}` : ""})</a></li>
            ))}
          </ul>
        )}
        {level === "mandal" && acs.length > 1 && <p className="text-[10px] text-slate-600">{t("prof.mandalSplit")}</p>}
      </Section>

      <Section title={t("prof.population")} testId="profile-census">
        {c.available ? (
          <>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-sans">
              <Stat label={t("cs.population")} value={num(c.population, na)} testId="census-population" />
              <Stat label={t("prof.households")} value={num(c.households, na)} />
              <Stat label={t("cs.sc")} value={pctText(c.scPct, na)} testId="census-sc" />
              <Stat label={t("cs.st")} value={pctText(c.stPct, na)} testId="census-st" />
              <Stat label={t("prof.sexRatio")} value={num(c.sexRatio, na)} />
              <Stat label={t("cs.literacy")} value={typeof c.literacyPct === "number" ? pctText(c.literacyPct, na) : t("prof.notAvailable")} testId="census-literacy" />
            </dl>
            {typeof c.literate === "number" && <p className="text-[10px] text-slate-600" data-testid="census-literate">{num(c.literate, na)} {t("prof.literateCount")}: {num(c.pop0to6, na)}</p>}
            {typeof c.literacyPct !== "number" && c.literacyNote && <p className="text-[10px] text-slate-600" data-testid="census-literacy-note">{c.literacyNote}</p>}
            <p className="text-[10px] text-slate-600">{t("cs.censusSource")} {c.censusYear}.</p>
          </>
        ) : <p className="text-xs font-sans" data-testid="census-unavailable">{t("prof.noCensus")}</p>}
      </Section>

      <IssuesBlock unit={civicUnit(level, p.code)} />
      <Sources sources={p.source} asOf={p.asOf} />
    </div>
  );
}
