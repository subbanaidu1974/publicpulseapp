import { useEffect, useState } from "react";
import { api, electionsProvenance, normaliseAlliances } from "../api/client";
import { useApi } from "../api/useApi";
import { ElectionType, ALLIANCES } from "../lib/states";
import { defaultYear, ELECTION_YEARS, useStateCtx } from "../state/StateContext";
import { useT } from "../i18n";
import { Bar, DemoBadge, ErrorBanner, fmt, Loading, partyColor } from "./ui";
import ConstituencySearch from "./ConstituencySearch";
import TrendCharts from "./TrendCharts";
import ForecastPanel from "./ForecastPanel";

export default function ElectionsPage() {
  const { state, config } = useStateCtx();
  const { t, lang } = useT();
  const [type, setType] = useState<ElectionType>("assembly");
  const [year, setYear] = useState<number>(() => defaultYear(state, "assembly"));
  const [alliance, setAlliance] = useState(false);
  const [sortSeats, setSortSeats] = useState(false);

  // keep year valid when state/type change
  useEffect(() => {
    if (!ELECTION_YEARS[state][type].includes(year)) setYear(defaultYear(state, type));
  }, [state, type, year]);
  useEffect(() => { setYear(defaultYear(state, type)); setAlliance(false); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const valid = true;
  const yr = ELECTION_YEARS[state][type].includes(year) ? year : defaultYear(state, type);
  const summary = useApi(() => api.summary(state, yr, type), [state, yr, type]);
  const marginal = useApi(() => api.marginal(state, yr, type, 2), [state, yr, type]);

  const status = useApi(() => api.dataStatus(), []);
  const prov = status.data ? electionsProvenance(status.data.rows) : null;
  const showDemo = prov ? !prov.real : !!summary.data?.demo;

  const s = summary.data;
  const allianceRows = normaliseAlliances(s?.alliances);
  const fallbackAlliance = ALLIANCES[`${state}-${yr}-${type}`];
  const hasAlliance = allianceRows.length > 0;

  const tallyEntries = Object.entries(s?.tally ?? {}).sort((a, b) =>
    sortSeats ? b[1] - a[1] || a[0].localeCompare(b[0]) : a[0].localeCompare(b[0]));
  const totalSeats = tallyEntries.reduce((n, [, v]) => n + v, 0);
  const maxSeats = Math.max(1, ...tallyEntries.map(([, v]) => v));
  const shareEntries = Object.entries(s?.voteShare ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const buckets = Object.entries(s?.marginBuckets ?? {});
  const maxBucket = Math.max(1, ...buckets.map(([, v]) => v));
  const source = s?.source ?? "ECI / TCPD Lok Dhaba";

  const sel = "border border-black bg-white text-xs font-sans p-2 min-w-0";

  return (
    <div className="space-y-8">
      <div className="bg-[#FAF8F5] p-6 sm:p-8 border-y border-black">
        <span className="text-[9px] uppercase tracking-[0.25em] font-sans font-black text-slate-500 block">{t("nav.elections")}</span>
        <h2 className="text-2xl font-serif italic text-black mt-1">{t("el.title")} - {lang === "te" ? config.nameTe : config.name}</h2>
        <p className="text-xs text-slate-600 mt-2 max-w-2xl font-serif">{t("el.provenanceNote")}</p>
        <div className="flex flex-wrap gap-4 mt-4 items-end">
          <label className="text-[10px] uppercase font-sans font-bold flex flex-col gap-1">
            {t("common.year")}
            <select data-testid="elections-year-select" className={sel} value={yr} onChange={(e) => setYear(Number(e.target.value))}>
              {ELECTION_YEARS[state][type].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="text-[10px] uppercase font-sans font-bold flex flex-col gap-1">
            {t("common.type")}
            <select data-testid="elections-type-select" className={sel} value={type} onChange={(e) => setType(e.target.value as ElectionType)}>
              <option value="assembly">{t("type.assembly")}</option>
              <option value="ls">{t("type.ls")}</option>
            </select>
          </label>
          <label className="text-xs font-sans flex items-center gap-2 cursor-pointer">
            <input data-testid="alliance-toggle" type="checkbox" checked={alliance} onChange={(e) => setAlliance(e.target.checked)} />
            {t("el.alliance")}
          </label>
        </div>
      </div>

      {prov && (
        <div data-testid="provenance-banner" className={`border p-3 text-xs font-sans flex flex-wrap gap-x-4 gap-y-1 items-center ${prov.real ? "border-emerald-800 bg-emerald-50 text-emerald-950" : "border-amber-700 bg-amber-50 text-amber-950"}`}>
          <strong>{prov.real ? t("prov.real") : t("prov.demo")}</strong>
          <span>{t("prov.banner")}: {s?.source ?? "ECI / TCPD Lok Dhaba"}</span>
          <span data-testid="provenance-value">{t("prov.provenance")}: {prov.provenance}</span>
          {prov.generatedAt && <span>{t("prov.updated")}: {prov.generatedAt.slice(0, 10)}</span>}
        </div>
      )}

      <ForecastPanel state={state} />

      <TrendCharts state={state} />

      {summary.error && <ErrorBanner message={summary.error} onRetry={() => { summary.retry(); marginal.retry(); }} />}
      {summary.loading && <Loading />}

      {s && valid && (
        <div className="space-y-8">
          <div className="flex flex-wrap items-center gap-3 text-xs font-sans">
            <span data-testid="elections-source" className="font-mono">{t("common.source")}: {source} &middot; {yr} {t(type === "ls" ? "type.ls" : "type.assembly")}</span>
            {showDemo && <DemoBadge />}
          </div>

          {alliance && (
            <section aria-label="Alliance view" className="border border-black p-4 bg-white space-y-3">
              {hasAlliance ? allianceRows.map((a, i) => (
                <Bar key={a.name} testId={`alliance-row-${i}`} label={a.name} value={`${a.seats} ${t("common.seats")}`} pct={(a.seats / Math.max(1, totalSeats)) * 100} color="#1f4e9c" />
              )) : (
                <p className="text-xs font-sans">{fallbackAlliance ? Object.keys(fallbackAlliance).join(", ") : t("el.noAlliance")}</p>
              )}
              <p data-testid="alliance-caveat" className="text-[11px] font-serif italic text-slate-700 border-l-2 border-amber-600 pl-3">{t("el.allianceCaveat")}</p>
            </section>
          )}

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="border border-black/20 p-4 bg-white space-y-2">
              <div className="flex justify-between items-center gap-2">
                <h3 className="text-sm font-serif italic">{t("el.tally")} ({totalSeats})</h3>
                <button type="button" onClick={() => setSortSeats(!sortSeats)} className="text-[10px] uppercase tracking-widest font-bold underline cursor-pointer">
                  {sortSeats ? t("el.sortAlpha") : t("el.sortSeats")}
                </button>
              </div>
              <div data-testid="elections-tally" className="space-y-1.5">
                {tallyEntries.length === 0 && <p className="text-xs">{t("el.empty")}</p>}
                {tallyEntries.map(([party, n]) => (
                  <Bar key={party} testId={`tally-row-${party}`} label={party} value={n} pct={(n / maxSeats) * 100} color={partyColor(party)} />
                ))}
              </div>
              <table className="sr-only">
                <caption>{t("el.tallyTable")}</caption>
                <tbody>{tallyEntries.map(([p, n]) => <tr key={p}><th>{p}</th><td>{n}</td></tr>)}</tbody>
              </table>
            </div>

            <div className="border border-black/20 p-4 bg-white space-y-2">
              <h3 className="text-sm font-serif italic">{t("el.voteShare")} (%)</h3>
              {shareEntries.map(([party, v]) => (
                <Bar key={party} label={party} value={`${fmt(v)}%`} pct={v} color={partyColor(party)} />
              ))}
            </div>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="border border-black/20 p-4 bg-white space-y-2">
              <h3 className="text-sm font-serif italic">{t("el.margins")}</h3>
              {buckets.map(([b, n]) => <Bar key={b} label={b} value={n} pct={(n / maxBucket) * 100} color="#3F5B73" />)}
            </div>

            <div className="border border-black/20 p-4 bg-white space-y-2">
              <h3 className="text-sm font-serif italic">{t("el.marginal")}</h3>
              {marginal.error && !summary.error && <ErrorBanner inline message={marginal.error} onRetry={marginal.retry} />}
              {marginal.data && marginal.data.seats.length === 0 && <p className="text-xs">{t("el.empty")}</p>}
              <ul className="text-xs font-sans divide-y divide-black/10 max-h-64 overflow-y-auto">
                {marginal.data?.seats.map((m) => (
                  <li key={m.acNo} className="flex justify-between py-1.5 gap-2">
                    <span className="min-w-0 truncate">{m.acNo}. {m.acName}</span>
                    <span className="font-mono shrink-0">{m.winnerParty} +{fmt(m.marginPct)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      )}

      <ConstituencySearch year={yr} type={type} valid={valid} />
    </div>
  );
}
