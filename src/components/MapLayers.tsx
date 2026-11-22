import { useMemo, useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { defaultYear, useStateCtx } from "../state/StateContext";
import { useT } from "../i18n";
import { DemoBadge, ErrorBanner, fmt, Loading, partyColor } from "./ui";

type Layer = "winner" | "margin" | "turnout";

interface DistrictAgg { district: string; seats: number; party: string; margin: number | null; turnout: number | null }

/** Election layers per district: winner / margin / turnout, as keyboard-focusable tiles plus a table fallback. */
export default function MapLayers() {
  const { state, config } = useStateCtx();
  const { t, lang } = useT();
  const [layer, setLayer] = useState<Layer>("winner");
  const year = defaultYear(state, "assembly");
  const res = useApi(() => api.seats(state, year, "assembly"), [state, year]);

  const aggs: DistrictAgg[] = useMemo(() => {
    const by = new Map<string, any[]>();
    for (const s of res.data?.seats ?? []) {
      const d = s.district || "Unassigned";
      by.set(d, [...(by.get(d) ?? []), s]);
    }
    return [...by.entries()].map(([district, list]) => {
      const tally: Record<string, number> = {};
      list.forEach((s) => { tally[s.winnerParty] = (tally[s.winnerParty] ?? 0) + 1; });
      const party = Object.entries(tally).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "n/a";
      const m = list.filter((s) => typeof s.marginPct === "number");
      const tv = list.map((s) => (typeof s.turnout === "number" ? s.turnout : s.electors && s.validVotes ? (s.validVotes / s.electors) * 100 : null)).filter((x): x is number => x !== null);
      return {
        district, seats: list.length, party,
        margin: m.length ? m.reduce((n, s) => n + s.marginPct, 0) / m.length : null,
        turnout: tv.length ? tv.reduce((n, x) => n + x, 0) / tv.length : null,
      };
    }).sort((a, b) => a.district.localeCompare(b.district));
  }, [res.data]);

  const shade = (v: number | null, max: number, hue: string) =>
    v === null ? "#d6d3cb" : `color-mix(in srgb, ${hue} ${Math.round(25 + Math.min(1, v / max) * 70)}%, white)`;
  const colorFor = (a: DistrictAgg) =>
    layer === "winner" ? partyColor(a.party) : layer === "margin" ? shade(a.margin, 25, "#3F5B73") : shade(a.turnout, 90, "#2E4A3F");
  const valueFor = (a: DistrictAgg) =>
    layer === "winner" ? a.party : layer === "margin" ? `${fmt(a.margin ?? undefined)}%` : `${fmt(a.turnout ?? undefined)}%`;
  const parties = [...new Set(aggs.map((a) => a.party))].sort();

  return (
    <section className="bg-[#FAF8F5] border border-black/15 p-4 sm:p-6 space-y-4" aria-label={t("map.layers")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-serif italic">{t("map.layers")} - {lang === "te" ? config.nameTe : config.name} {year}</h3>
        <div className="flex items-center gap-3">
          {res.data?.demo && <DemoBadge />}
          <label className="text-[10px] uppercase font-bold font-sans flex items-center gap-2">
            {t("map.layer")}
            <select data-testid="map-layer-select" value={layer} onChange={(e) => setLayer(e.target.value as Layer)} className="border border-black bg-white p-2 text-xs normal-case">
              <option value="winner">{t("map.winner")}</option>
              <option value="margin">{t("map.margin")}</option>
              <option value="turnout">{t("map.turnout")}</option>
            </select>
          </label>
        </div>
      </div>

      {res.error && <ErrorBanner message={res.error} onRetry={res.retry} />}
      {res.loading && <Loading />}

      {res.data && (
        <>
          <div role="group" aria-label={t(layer === "winner" ? "map.winner" : layer === "margin" ? "map.margin" : "map.turnout")} className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-8 gap-1.5">
            {aggs.map((a) => (
              <button key={a.district} type="button" title={`${a.district}: ${valueFor(a)}`}
                aria-label={`${a.district}: ${valueFor(a)}`}
                style={{ background: colorFor(a) }}
                className="h-14 border border-black/30 text-[10px] font-sans font-bold text-black p-1 text-left leading-tight overflow-hidden cursor-pointer focus:outline-2 focus:outline-black focus:outline-offset-2">
                <span className="block truncate bg-white/70 px-0.5">{a.district}</span>
                <span className="block bg-white/70 px-0.5 mt-0.5 w-fit">{valueFor(a)}</span>
              </button>
            ))}
          </div>

          <div data-testid="map-legend" className="flex flex-wrap gap-3 text-[10px] font-sans items-center">
            {layer === "winner" ? parties.map((p) => (
              <span key={p} className="flex items-center gap-1"><i className="w-3 h-3 inline-block border border-black/30" style={{ background: partyColor(p) }} />{p}</span>
            )) : (
              <span className="flex items-center gap-2">
                {layer === "margin" ? "Avg margin: low" : "Turnout: low"}
                <i className="w-24 h-3 inline-block border border-black/30" style={{ background: `linear-gradient(90deg, ${shade(0, 1, layer === "margin" ? "#3F5B73" : "#2E4A3F")}, ${shade(1, 1, layer === "margin" ? "#3F5B73" : "#2E4A3F")})` }} />
                high
              </span>
            )}
            <span className="text-slate-500">n/a = no data</span>
          </div>

          <div className="overflow-x-auto">
            <table data-testid="map-table-fallback" className="w-full text-xs font-sans border-collapse">
              <caption className="text-left text-[10px] uppercase tracking-widest font-black py-1">{t("map.tableTitle")}</caption>
              <thead><tr className="border-b border-black text-left"><th className="py-1 pr-2">District</th><th className="pr-2">Seats</th><th className="pr-2">{t("map.winner")}</th><th className="pr-2">{t("map.margin")}</th><th>{t("map.turnout")}</th></tr></thead>
              <tbody>
                {aggs.map((a) => (
                  <tr key={a.district} className="border-b border-black/10">
                    <td className="py-1 pr-2">{a.district}</td><td className="pr-2">{a.seats}</td><td className="pr-2">{a.party}</td>
                    <td className="pr-2">{fmt(a.margin ?? undefined)}%</td><td>{fmt(a.turnout ?? undefined)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
