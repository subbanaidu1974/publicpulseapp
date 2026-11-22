import { useState } from "react";
import { api } from "../../api/client";
import { useApi } from "../../api/useApi";
import { ELECTION_YEARS, useStateCtx } from "../../state/StateContext";
import { ElectionType } from "../../lib/states";
import { useT } from "../../i18n";
import { Bar, DemoBadge, ErrorBanner, fmt, Loading, partyColor } from "../ui";

const sortDesc = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]);

/** Statewide analytics from the real /api/v1 data for the selected state. No survey figures. */
export default function AnalyticsPage() {
  const { state, config } = useStateCtx();
  const { t, lang } = useT();
  const type: ElectionType = "assembly";
  const years = ELECTION_YEARS[state][type];
  const [yearSel, setYearSel] = useState<number | null>(null);
  const year = yearSel && years.includes(yearSel) ? yearSel : years[0];
  const prev = years.find((y) => y < year);

  const summary = useApi(() => api.summary(state, year, type), [state, year]);
  const marginal = useApi(() => api.marginal(state, year, type, 2), [state, year]);
  const swing = useApi(async () => (prev ? api.swing(state, type, prev, year) : null), [state, year, prev]);
  const census = useApi(() => api.census(state), [state]);

  const tally = summary.data ? sortDesc(summary.data.tally) : [];
  const share = summary.data ? sortDesc(summary.data.voteShare) : [];
  const swingRows = swing.data ? Object.entries(swing.data.swing).sort((a, b) => b[1] - a[1]) : [];
  const pct = (n: unknown) => (typeof n === "number" ? `${n.toFixed(1)}%` : "n/a");

  return (
    <div className="space-y-8" data-testid="analytics-page">
      <div className="bg-[#FAF8F5] p-6 border-y border-black flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-serif italic">{lang === "te" ? config.nameTe : config.name}: {t("an.title")}</h2>
          <p className="text-xs font-sans mt-1 max-w-2xl">{t("an.lead")}</p>
        </div>
        <label className="text-[10px] uppercase tracking-widest font-black font-sans flex items-center gap-2">
          {t("common.year")}
          <select data-testid="analytics-year" value={year} onChange={(e) => setYearSel(Number(e.target.value))} className="border border-black bg-transparent p-1.5 text-xs">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
      </div>

      <section className="bg-[#FAF8F5] border border-black/20 p-4 sm:p-6 space-y-3" aria-label={t("el.tally")}>
        <div className="flex items-center justify-between"><h3 className="text-lg font-serif italic">{t("el.tally")} ({year})</h3>{summary.data?.demo && <DemoBadge />}</div>
        {summary.error && <ErrorBanner message={summary.error} onRetry={summary.retry} />}
        {summary.loading && <Loading />}
        {tally.map(([p, n]) => <Bar key={p} testId={`an-tally-${p}`} label={p} value={`${n}`} pct={(n / (summary.data?.totalSeats || config.assemblySeats)) * 100} color={partyColor(p)} />)}
        <h4 className="text-[10px] uppercase tracking-widest font-black pt-2">{t("el.voteShare")}</h4>
        {share.slice(0, 8).map(([p, v]) => <Bar key={p} label={p} value={`${fmt(v)}%`} pct={v} color={partyColor(p)} />)}
        <p className="text-[10px] font-sans text-slate-600">{t("common.source")}: ECI / TCPD</p>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <section className="bg-[#FAF8F5] border border-black/20 p-4 sm:p-6 space-y-2">
          <h3 className="text-lg font-serif italic">{t("el.marginal")}</h3>
          {marginal.error && <ErrorBanner inline message={marginal.error} onRetry={marginal.retry} />}
          {marginal.loading && <Loading />}
          {marginal.data && (marginal.data.seats.length === 0 ? <p className="text-xs font-sans">{t("el.empty")}</p> : (
            <div className="overflow-x-auto max-h-80">
              <table className="w-full text-xs font-sans border-collapse">
                <thead><tr className="text-left border-b border-black"><th className="py-1 pr-2">{t("fc.seat")}</th><th className="pr-2">{t("tr.party")}</th><th>{t("fc.margin")}</th></tr></thead>
                <tbody>
                  {marginal.data.seats.map((s) => (
                    <tr key={s.acNo} className="border-b border-black/10"><td className="py-1 pr-2">{s.acNo}. {s.acName}</td><td className="pr-2">{s.winnerParty}</td><td>{pct(s.marginPct)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>

        <section className="bg-[#FAF8F5] border border-black/20 p-4 sm:p-6 space-y-2">
          <h3 className="text-lg font-serif italic">{t("tr.swing")}</h3>
          {!prev && <p className="text-xs font-sans">{t("tr.swingNone")}</p>}
          {swing.error && <ErrorBanner inline message={swing.error} onRetry={swing.retry} />}
          {swingRows.length > 0 && <p className="text-[10px] font-sans">{prev} to {year}</p>}
          {swingRows.slice(0, 8).map(([p, v]) => <Bar key={p} label={p} value={`${v > 0 ? "+" : ""}${fmt(v)}`} pct={Math.min(100, Math.abs(v) * 4)} color={partyColor(p)} />)}
        </section>
      </div>

      <section className="bg-[#FAF8F5] border border-black/20 p-4 sm:p-6 space-y-2" data-testid="analytics-census">
        <div className="flex items-center justify-between"><h3 className="text-lg font-serif italic">{t("cs.census")}</h3>{census.data?.demo && <DemoBadge />}</div>
        {census.error && <ErrorBanner inline message={census.error} onRetry={census.retry} />}
        {census.loading && <Loading />}
        {census.data && (census.data.rows.length === 0 ? <p className="text-xs font-sans">{t("cs.noCensus")}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-sans border-collapse">
              <thead><tr className="text-left border-b border-black"><th className="py-1 pr-2">{t("an.district")}</th><th className="pr-2">{t("an.population")}</th><th className="pr-2">{t("an.literacy")}</th><th className="pr-2">SC</th><th>ST</th></tr></thead>
              <tbody>
                {census.data.rows.map((r) => (
                  <tr key={String(r.district ?? r.name)} className="border-b border-black/10">
                    <td className="py-1 pr-2">{String(r.district ?? r.name)}</td><td className="pr-2">{r.population?.toLocaleString() ?? "n/a"}</td>
                    <td className="pr-2">{pct(r.literacyPct ?? r.literacy)}</td><td className="pr-2">{pct(r.scPct)}</td><td>{pct(r.stPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <p className="text-[10px] font-sans text-slate-600">{t("common.source")}: Census of India 2011 (PCA)</p>
      </section>
    </div>
  );
}
