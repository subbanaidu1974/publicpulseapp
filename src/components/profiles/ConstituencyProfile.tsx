import type { ReactNode } from "react";
import { civicUnit, profiles } from "../../api/profiles";
import type { ConstituencyProfileData, IssueAgg } from "../../api/profiles";
import { useApi } from "../../api/useApi";
import { fetchPhotosPaused, fetchWinnerPhotos } from "../../api/geo";
import { STATES } from "../../lib/states";
import type { StateCode } from "../../lib/states";
import { useT } from "../../i18n";
import type { Key } from "../../i18n";
import { Bar, DemoBadge, ErrorBanner, Loading, partyColor } from "../ui";
import BoundaryThumb from "./BoundaryThumb";
import PhotoSubmitForm from "./PhotoSubmitForm";
import { ByElectionsBlock } from "../analytics/blocks";
import { Section, Sources, Stat, num, pctText, useDisplayName } from "./common";

const RES_KEY: Record<string, Key> = { GEN: "prof.res.GEN", SC: "prof.res.SC", ST: "prof.res.ST" };

export function IssuesBlock({ unit, note }: { unit: string | null; note?: string }) {
  const { t } = useT();
  const agg = useApi<IssueAgg | null>(() => (unit ? profiles.issues(unit) : Promise.resolve(null)), [unit]);
  return (
    <Section title={t("prof.issues")} testId="profile-issues">
      {agg.loading ? <Loading /> : agg.data && agg.data.total >= 30 ? (
        <dl className="grid grid-cols-3 gap-2 text-xs font-sans">
          <Stat label={t("prof.issuesTotal")} value={num(agg.data.total, t("cs.na"))} />
          <Stat label={t("prof.issuesResolved")} value={num(agg.data.resolved, t("cs.na"))} />
          <Stat label={t("prof.issuesOpen")} value={num(agg.data.open, t("cs.na"))} />
        </dl>
      ) : <p className="text-xs font-sans text-slate-700">{agg.data ? t("prof.issuesNone") : t("prof.issuesOff")}</p>}
      {note && <p className="text-[10px] text-slate-600">{note}</p>}
    </Section>
  );
}

export default function ConstituencyProfile({ state, acNo, actions }: { state: StateCode; acNo: number; actions?: ReactNode }) {
  const { t, lang } = useT();
  const dn = useDisplayName();
  const prof = useApi<ConstituencyProfileData>(() => profiles.constituency(state, acNo), [state, acNo]);
  const member = useApi(() => profiles.member(state, acNo), [state, acNo]);
  const photos = useApi(() => fetchWinnerPhotos().catch(() => []), []);
  const paused = useApi(() => fetchPhotosPaused(state).catch(() => false), [state]);
  const na = t("cs.na");

  if (prof.loading) return <div data-testid="constituency-profile"><Loading /></div>;
  if (prof.error || !prof.data) return <div data-testid="constituency-profile"><ErrorBanner inline message={prof.error ?? "error"} onRetry={prof.retry} /></div>;
  const p = prof.data;
  const name = dn(p);
  const other = lang === "te" ? p.nameEn : p.nameTe;
  const hist = p.history;
  const latest = hist[hist.length - 1];
  const photo = latest ? (photos.data ?? []).find((x) => x.state === state && x.acNo === acNo && x.year === latest.year) : undefined;
  const recorded = [...new Set(hist.map(h => h.name))].filter(n => n !== p.nameEn);

  return (
    <div data-testid="constituency-profile" className="bg-white border border-black p-4 space-y-4">
      <div className="flex flex-wrap justify-between items-start gap-2">
        <div>
          <h4 className="text-xl font-serif italic" data-testid="profile-title">{name}</h4>
          {other && <p className="text-[11px] font-sans text-slate-600">{other}</p>}
          {recorded.length > 0 && <p className="text-[10px] font-sans text-slate-600" data-testid="profile-recorded">{t("prof.recordedAs")} {recorded.join(", ")}</p>}
          <p className="text-[11px] font-sans text-slate-600">
            #{p.acNo} &middot; {p.district ? dn(p.district) : na} &middot; {lang === "te" ? STATES[state].nameTe : STATES[state].name}
          </p>
        </div>
        <div className="flex items-center gap-2">{p.demo && <DemoBadge testId="demo-badge-inline" />}{actions}</div>
      </div>

      <div className="flex flex-wrap gap-4">
        <BoundaryThumb state={state} acNo={acNo} label={`${t("prof.boundary")}: ${name}`} />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs font-sans content-start flex-1 min-w-[12rem]">
          <Stat label={t("prof.reservation")} value={p.reservation ? t(RES_KEY[p.reservation] ?? "prof.res.GEN") : na} testId="profile-reservation" />
          <Stat label={t("prof.district")} value={p.district ? <a className="underline" href={p.district.href}>{dn(p.district)}</a> : na} />
          <Stat label={t("prof.pc")} value={p.pc ? <span data-testid="profile-pc">{dn({ nameEn: p.pc.nameEn, nameTe: p.pc.nameTe })} (#{p.pc.pcNo}{p.pc.reservation && p.pc.reservation !== "GEN" ? `, ${p.pc.reservation}` : ""})</span> : na} />
          <Stat label={t("prof.units")} testId="profile-units" value={p.units ? `${num(p.units.mandals, na)} ${t("prof.mandals")}, ${num(p.units.villages, na)} ${t("prof.villages")}${p.units.wards ? `, ${num(p.units.wards, na)} ${t("prof.wards")}` : ""}` : na} />
          <Stat label={t("prof.electors")} testId="profile-electors" value={p.electors ? `${num(p.electors, na)} (${p.electorsYear})` : t("prof.notAvailable")} />
          {member.data && <Stat label={t("prof.member")} testId="profile-member" value={`${member.data.name}${member.data.party ? ` (${member.data.party})` : ""}`} />}
        </dl>
      </div>

      {p.electorsRoll && (
        <Section title={t("prof.rollGe2024")} testId="profile-electors-roll">
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-sans">
            <Stat label={t("prof.electors")} value={num(p.electorsRoll.total, na)} testId="roll-total" />
            <Stat label={t("prof.male")} value={num(p.electorsRoll.male, na)} testId="roll-male" />
            <Stat label={t("prof.female")} value={num(p.electorsRoll.female, na)} testId="roll-female" />
            <Stat label={t("prof.thirdGender")} value={num(p.electorsRoll.thirdGender, na)} testId="roll-third" />
          </dl>
          <p className="text-[10px] text-slate-600">{p.electorsRoll.note}</p>
        </Section>
      )}

      <Section title={t("prof.population")} testId="profile-census">
        {p.census ? (
          <>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-sans">
              <Stat label={t("cs.population")} value={num(p.census.population, na)} />
              <Stat label={t("cs.sc")} value={pctText(p.census.scPct, na)} />
              <Stat label={t("cs.st")} value={pctText(p.census.stPct, na)} />
              <Stat label={t("cs.literacy")} value={typeof p.census.literacy?.literacyPct === "number" ? `${t("prof.approx")} ${pctText(p.census.literacy.literacyPct, na)}` : t("prof.notAvailable")} testId="ac-literacy" />
            </dl>
            <p className="text-[10px] text-slate-600">{t("prof.censusRural")} {num(p.census.villagesWithCensus, na)} {t("prof.of")} {num(p.census.villagesTotal, na)} {t("prof.villages")}. {t("cs.censusSource")} 2011.</p>
            {p.census.literacy && <p className="text-[10px] text-slate-600" data-testid="ac-literacy-note">{t("prof.litApprox")} {num(p.census.literacy.unitsMapped, na)} ({num(p.census.literacy.townUnits, na)} {t("prof.towns")}). {t("prof.litCoverage")} {pctText(p.census.literacy.literacyCoveragePct, na)}. {p.census.literacy.reasons.join(" ")}</p>}
          </>
        ) : <p className="text-xs font-sans">{t("prof.noCensus")}</p>}
      </Section>

      {photo && (
        <figure data-testid="winner-photo" className="flex items-end gap-3 font-sans">
          <img src={`/api/v1/photos/${photo.file}`} alt={`${photo.candidate}, ${latest!.year}`} width={96} height={120} loading="lazy" className="w-24 h-auto border border-black object-cover" />
          <figcaption className="text-[10px] text-slate-600">
            {photo.candidate} ({latest!.year}). {photo.origin === "upload"
              ? <>{t("prof.photoSupplied")} {photo.author ?? t("prof.photoUnknown")}.</>
              : <>{t("prof.photoBy")} {photo.author ?? t("prof.photoUnknown")}, <a className="underline" href={photo.licenceUrl ?? photo.source} rel="noopener noreferrer" target="_blank">{photo.licence}</a>, <a className="underline" href={photo.source} rel="noopener noreferrer" target="_blank">{t("prof.photoSource")}</a>. {t("prof.photoNote")}</>}
          </figcaption>
        </figure>
      )}

      {latest && photos.data && !paused.data && <PhotoSubmitForm state={state} acNo={acNo} />}
      {!photo && latest && photos.data && (
        <p data-testid="winner-photo-missing" className="text-[10px] text-slate-600 font-sans">{paused.data ? t("prof.photoPaused") : t("prof.photoMissing")}</p>
      )}

      <Section title={t("prof.history")} testId="profile-history">
        {hist.length === 0 ? <p className="text-xs font-sans">{t("prof.noHistory")}</p> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-sans border-collapse">
                <thead><tr className="text-left border-b border-black">
                  <th className="py-1 pr-2">{t("common.year")}</th><th className="pr-2">{t("cs.winner")}</th><th className="pr-2">{t("cs.party")}</th>
                  <th className="pr-2">{t("cs.margin")}</th><th className="pr-2">{t("prof.turnout")}</th>
                </tr></thead>
                <tbody>
                  {hist.map(h => (
                    <tr key={h.year} className="border-b border-black/10" data-testid="history-row">
                      <td className="py-1 pr-2">{h.year}</td><td className="pr-2">{h.winner}</td><td className="pr-2">{h.winnerParty}</td>
                      <td className="pr-2">{pctText(h.marginPct, na)}</td><td className="pr-2">{pctText(h.turnoutPct, na)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-1 pt-1" aria-label={t("prof.winnerShare")}>
              {hist.map(h => {
                const share = h.candidates[0] && h.validVotes ? (h.candidates[0].votes / h.validVotes) * 100 : 0;
                return <Bar key={String(h.year)} label={h.year} value={`${h.winnerParty} ${share.toFixed(1)}%`} pct={share} color={partyColor(h.winnerParty)} />;
              })}
            </div>
            {latest && <p className="text-[10px] text-slate-600">{t("prof.runnerUp")} {latest.year}: {latest.candidates[1] ? `${latest.candidates[1].name} (${latest.candidates[1].party})` : na}</p>}
          </>
        )}
      </Section>

      <ByElectionsBlock state={state} acNo={acNo} />

      {p.pc && p.pc.history.length > 0 && (
        <Section title={t("prof.pcHistory")} testId="profile-pc-history">
          <ul className="text-xs font-sans">
            {p.pc.history.map(h => <li key={h.year}>{h.year}: {h.winner} ({h.winnerParty}), {t("cs.margin")} {pctText(h.marginPct, na)}</li>)}
          </ul>
        </Section>
      )}

      {p.mandals.length > 0 && (
        <Section title={t("prof.mandalList")} testId="profile-mandals">
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-sans">
            {p.mandals.map(m => <li key={m.code}><a className="underline" href={m.href} data-testid="mandal-link">{dn(m)}</a></li>)}
          </ul>
        </Section>
      )}

      <IssuesBlock unit={p.district ? civicUnit("district", p.district.code) : null} note={p.district ? `${t("prof.issuesUnitNote")} ${dn(p.district)}.` : undefined} />
      <Sources sources={p.source} asOf={p.asOf} demo={p.demo} />
    </div>
  );
}
