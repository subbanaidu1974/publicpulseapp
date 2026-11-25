import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useApi } from "../../api/useApi";
import { fetchCensusDistricts, fetchGeo, fetchIssueTotals, fetchTeNames, fetchAcDetail, type GeoFeature, type TeNames } from "../../api/geo";
import { useElectionYears, useStateCtx } from "../../state/StateContext";
import { useT, type Key } from "../../i18n";
import { ErrorBanner, Loading } from "../ui";
import GeoMap from "./GeoMap";
import UnitsPanel from "./UnitsPanel";
import {
  METRICS_BY_LEVEL, MIN_CELL, acsInDistrict, buildHash, buildRows, districtTally, leader, parseHash, partyInfo, populationByDistrict, sortRows,
  RESERVATION_COLORS, NO_DATA, fmtInt, nameKey,
  type MapLevel, type MapRoute, type MetricId, type Row, type SeatLite,
} from "./mapModel";

type Theme = "beige" | "dark" | "dark-beige" | "earth-yellow";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const METRIC_KEY: Record<MetricId, Key> = {
  winner: "map.m.winner", margin: "map.m.margin", turnout: "map.m.turnout", reservation: "map.m.reservation", population: "map.m.population", issues: "map.m.issues",
};

function readHash(): MapRoute | null { try { return parseHash(window.location.hash); } catch { return null; } }
function writeHash(r: MapRoute, replace = false) {
  const h = buildHash(r);
  if (window.location.hash === h) return;
  if (replace) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${h}`);
  else window.location.hash = h;
}

export default function MapPage({ theme }: { theme: Theme }) {
  const { state, config, setState } = useStateCtx();
  const { t, lang } = useT();
  const dark = theme === "dark" || theme === "dark-beige";
  const [route, setRoute] = useState<MapRoute>(() => readHash() ?? { state, level: "district" });
  const [metric, setMetric] = useState<MetricId>("winner");
  const [sort, setSort] = useState<{ by: "name" | "value"; dir: 1 | -1 }>({ by: "name", dir: 1 });
  const [active, setActive] = useState<string | null>(null);

  /* ---- hash <-> state sync ---- */
  useEffect(() => {
    const on = () => { const r = readHash(); if (r) setRoute(r); };
    window.addEventListener("hashchange", on);
    const first = readHash();
    if (first && first.state !== state) setState(first.state);
    else if (!first) writeHash({ state, level: "district" }, true);
    return () => {
      window.removeEventListener("hashchange", on);
      // leaving the map tab clears the map hash; deferred so a StrictMode remount (which re-renders the page) keeps it
      setTimeout(() => {
        if (!document.querySelector("[data-testid=map-page]") && parseHash(window.location.hash)) window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // the global state switcher changed: restart at the state view
    setRoute((r) => {
      if (r.state === state) return r;
      const n: MapRoute = { state, level: "district" };
      writeHash(n, true);
      return n;
    });
  }, [state]);

  const go = useCallback((r: MapRoute) => { setActive(null); setRoute(r); writeHash(r); }, []);
  const year = useElectionYears(state, "assembly")[0];
  const lsYear = useElectionYears(state, "ls")[0];

  /* ---- data ---- */
  const acGeo = useApi(() => fetchGeo(state, "ac"), [state]);
  const distGeo = useApi(() => fetchGeo(state, "district"), [state]);
  const pcGeo = useApi(() => (route.level === "pc" ? fetchGeo(state, "pc") : Promise.resolve(null)), [state, route.level === "pc"]);
  const seatsQ = useApi(() => api.seats(state, year, "assembly"), [state, year]);
  const lsQ = useApi(() => (route.level === "pc" ? api.seats(state, lsYear, "ls") : Promise.resolve(null)), [state, lsYear, route.level === "pc"]);
  const needCensus = metric === "population";
  const needIssues = metric === "issues";
  const censusQ = useApi(() => (needCensus ? fetchCensusDistricts(state) : Promise.resolve(undefined)), [state, needCensus]);
  const issuesQ = useApi(() => (needIssues ? fetchIssueTotals() : Promise.resolve(undefined)), [needIssues]);
  const [te, setTe] = useState<TeNames | null>(null);
  useEffect(() => { let on = true; fetchTeNames(state).then((n) => on && setTe(n)).catch(() => on && setTe(null)); return () => { on = false; }; }, [state]);

  const level: MapLevel = route.level;
  const metrics = METRICS_BY_LEVEL[level];
  const m: MetricId = metrics.includes(metric) ? metric : "winner";
  useEffect(() => { if (m !== metric) setMetric(m); }, [m, metric]);

  const seatMap = useMemo(() => {
    const src = level === "pc" ? lsQ.data?.seats : seatsQ.data?.seats;
    return new Map<number, SeatLite>((src ?? []).map((s) => [s.acNo, s]));
  }, [level, lsQ.data, seatsQ.data]);
  const acSeatMap = useMemo(() => new Map<number, SeatLite>((seatsQ.data?.seats ?? []).map((s) => [s.acNo, s])), [seatsQ.data]);

  const features: GeoFeature[] = useMemo(() => {
    if (level === "district") return distGeo.data?.features ?? [];
    if (level === "pc") return pcGeo.data?.features ?? [];
    const all = acGeo.data?.features ?? [];
    return route.district ? acsInDistrict(all, route.district) : all;
  }, [level, distGeo.data, pcGeo.data, acGeo.data, route.district]);
  const collection = useMemo(() => ({ type: "FeatureCollection" as const, features }), [features]);

  const tally = useMemo(() => districtTally(acGeo.data?.features ?? [], acSeatMap), [acGeo.data, acSeatMap]);
  const built = useMemo(
    () => buildRows(level, features, {
      metric: m, seats: seatMap, tally,
      population: censusQ.data ? populationByDistrict(censusQ.data) : null,
      issues: issuesQ.data ?? null,
      tied: t("map.tied"), noData: t("map.noData"),
    }),
    [level, features, m, seatMap, tally, censusQ.data, issuesQ.data, t],
  );

  const teName = useCallback((lv: MapLevel, f: GeoFeature): string | null => {
    if (!te) return null;
    const p = f.properties;
    return (lv === "district" ? te.districts[String(p.districtLgd)] : lv === "ac" ? te.acs[String(p.acNo)] : te.pcs[String(p.pcNo)]) ?? null;
  }, [te]);
  const keyOf = useCallback((f: GeoFeature) => String(level === "district" ? f.properties.districtLgd ?? f.properties.district : level === "pc" ? f.properties.pcNo : f.properties.acNo), [level]);
  const rows: Row[] = useMemo(() => built.rows.map((r, i) => (lang === "te" ? { ...r, name: teName(level, features[i]) ?? r.name } : r)), [built.rows, lang, level, features, teName]);
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const colorOf = useCallback((k: string) => rowByKey.get(k)?.color ?? NO_DATA, [rowByKey]);
  const tooltipOf = useCallback((k: string) => {
    const r = rowByKey.get(k);
    return r ? `<strong>${esc(r.name)}</strong>${r.sub ? ` (${esc(r.sub)})` : ""}<br/>${esc(t(METRIC_KEY[m]))}: ${esc(r.text)}` : esc(k);
  }, [rowByKey, m, t]);

  const selectedKey = level === "ac" ? (route.ac !== undefined ? String(route.ac) : null) : level === "pc" ? (route.pc !== undefined ? String(route.pc) : null) : null;
  const sortedRows = useMemo(() => sortRows(rows, sort.by, sort.dir), [rows, sort]);

  const onSelect = (key: string) => {
    if (level === "district") go({ state, level: "ac", district: key });
    else if (level === "ac") go({ ...route, level: "ac", ac: Number(key) });
    else go({ ...route, level: "pc", pc: Number(key) });
  };

  const distFeature = route.district ? distGeo.data?.features.find((f) => String(f.properties.districtLgd) === route.district) : undefined;
  const distName = distFeature ? (lang === "te" ? teName("district", distFeature) : null) ?? String(distFeature.properties.district) : route.district;
  const acFeature = route.ac !== undefined ? acGeo.data?.features.find((f) => Number(f.properties.acNo) === route.ac) : undefined;
  const acRow = route.ac !== undefined ? rowByKey.get(String(route.ac)) : undefined;
  const stateName = lang === "te" ? config.nameTe : config.name;

  const up = () => {
    if (route.ac !== undefined && route.district) go({ state, level: "ac", district: route.district });
    else if (route.pc !== undefined) go({ state, level: "pc" });
    else go({ state, level: route.ac !== undefined ? "ac" : "district" });
  };
  const setLevel = (l: MapLevel) => go({ state, level: l });
  const loadingGeo = (level === "district" ? distGeo.loading : level === "pc" ? pcGeo.loading : acGeo.loading) || seatsQ.loading;
  const geoError = (level === "district" ? distGeo.error : level === "pc" ? pcGeo.error : acGeo.error) ?? (level === "district" && m === "winner" ? acGeo.error : null);
  const geoRetry = () => { distGeo.retry(); acGeo.retry(); pcGeo.retry(); seatsQ.retry(); };

  // honest "not available" states for overlays
  const unavailable: string | null =
    m === "population" && !censusQ.loading && !censusQ.data ? t("map.unavail.population")
    : m === "issues" && !issuesQ.loading && !issuesQ.data ? t("map.unavail.issues")
    : (m === "margin" || m === "turnout") && !seatsQ.loading && built.coverage === 0 ? t("map.unavail.data")
    : null;
  const partial = !loadingGeo && !unavailable && built.coverage > 0 && built.coverage < 1 && (m === "population" || m === "issues");

  const legend = useMemo(() => {
    if (m === "winner") {
      const cats = [...new Set(rows.map((r) => r.category).filter(Boolean) as string[])].sort();
      return cats.map((c) => ({ color: partyInfo(c).color, label: `${c}` }));
    }
    if (m === "reservation") return ["GEN", "SC", "ST"].map((c) => ({ color: RESERVATION_COLORS[c], label: c }));
    const suffix = m === "margin" || m === "turnout" ? "%" : "";
    const f = (n: number) => (suffix ? n.toFixed(1) : fmtInt(n)) + suffix;
    return (built.bins ?? []).map((b) => ({ color: b.color, label: `${f(b.from)} to ${f(b.to)}` }));
  }, [m, rows, built.bins]);

  const desc = `${t("map.desc")} ${rows.length} ${t("map.areas")}, ${t("map.colouredBy")} ${t(METRIC_KEY[m]).toLowerCase()}.`;
  const toggleSort = (by: "name" | "value") => setSort((s) => (s.by === by ? { by, dir: (s.dir * -1) as 1 | -1 } : { by, dir: 1 }));
  const aria = (by: "name" | "value") => (sort.by === by ? (sort.dir === 1 ? "ascending" : "descending") : "none");

  return (
    <div data-testid="map-page" className="space-y-5">
      <div>
        <h2 className="text-3xl font-serif italic tracking-tight">{t("map.title")}</h2>
        <p className="text-sm font-serif max-w-3xl mt-1">{t("map.lead")}</p>
      </div>

      <nav aria-label={t("map.breadcrumb")} data-testid="map-breadcrumb" className="flex flex-wrap items-center gap-1 text-xs font-sans">
        <button type="button" data-testid="crumb-state" onClick={() => go({ state, level: "district" })} className={`underline cursor-pointer ${!route.district && level === "district" ? "font-black" : ""}`} aria-current={!route.district && level === "district" ? "page" : undefined}>{stateName}</button>
        {level === "ac" && !route.district && <><span aria-hidden>/</span><span aria-current="page" className="font-black">{t("map.level.ac")}</span></>}
        {level === "pc" && <><span aria-hidden>/</span><span aria-current="page" className="font-black">{t("map.level.pc")}</span></>}
        {route.district && (
          <>
            <span aria-hidden>/</span>
            <button type="button" data-testid="crumb-district" onClick={() => go({ state, level: "ac", district: route.district })} className={`underline cursor-pointer ${route.ac === undefined ? "font-black" : ""}`} aria-current={route.ac === undefined ? "page" : undefined}>{distName}</button>
          </>
        )}
        {route.ac !== undefined && (
          <>
            <span aria-hidden>/</span>
            <span data-testid="crumb-ac" aria-current="page" className="font-black">{acRow?.name ?? `#${route.ac}`}</span>
          </>
        )}
        {(route.district || route.ac !== undefined || route.pc !== undefined) && (
          <button type="button" data-testid="map-back" onClick={up} className="ml-3 border border-black px-2 py-0.5 uppercase tracking-widest text-[10px] font-black cursor-pointer">{t("map.back")}</button>
        )}
      </nav>

      <div className="flex flex-wrap gap-4 items-end font-sans text-xs">
        {!route.district && (
          <div role="group" aria-label={t("map.level")} className="flex">
            {(["district", "ac", "pc"] as MapLevel[]).map((l) => (
              <button key={l} type="button" data-testid={`map-level-${l}`} aria-pressed={level === l} onClick={() => setLevel(l)} className={`border border-black px-3 py-2 uppercase tracking-widest text-[10px] font-black cursor-pointer ${level === l ? "bg-black text-[#F9F7F2]" : "bg-transparent"}`}>{t(`map.level.${l}` as Key)}</button>
            ))}
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="uppercase tracking-widest text-[10px] font-black">{t("map.metric")}</span>
          <select data-testid="map-metric" value={m} onChange={(e) => setMetric(e.target.value as MetricId)} className="border border-black bg-[#FAF8F5] text-[#121212] px-2 py-2 min-w-[12rem]">
            {metrics.map((x) => <option key={x} value={x}>{t(METRIC_KEY[x])}</option>)}
          </select>
        </label>
        <span className="text-[11px]">{level === "pc" ? lsYear : year}</span>
      </div>

      {geoError && <ErrorBanner message={geoError} onRetry={geoRetry} />}
      {unavailable && <p data-testid="map-unavailable" role="status" className="border border-black/30 bg-[#FAF8F5] text-[#121212] p-3 text-xs font-sans">{unavailable}</p>}
      {partial && <p data-testid="map-partial" className="text-[11px] font-sans">{Math.round(built.coverage * rows.length)} / {rows.length} {t("map.areas")} {t("map.hasData")}. {m === "issues" ? `${t("map.minCell")} ${MIN_CELL}.` : t("map.censusNote")}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 space-y-2 min-w-0">
          <p id="map-desc" data-testid="map-desc" className="text-[11px] font-sans">{desc}</p>
          <div className="border border-black/30 relative">
            {loadingGeo && <div className="absolute inset-0 z-[500] flex items-center justify-center bg-[#F9F7F2]/70 text-[#121212] pointer-events-none"><Loading /></div>}
            <GeoMap
              testId="geo-map" label={`${t("map.title")}: ${stateName}`} describedBy="map-desc" dark={dark}
              collection={collection} keyOf={keyOf} colorOf={colorOf} tooltipOf={tooltipOf}
              selectedKey={selectedKey} activeKey={active} onSelect={onSelect}
            />
          </div>
          <div data-testid="map-legend" aria-label={t("map.legend")} role="group" className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-sans">
            <strong className="uppercase tracking-widest text-[10px]">{t("map.legend")}</strong>
            {legend.map((l) => (
              <span key={l.label} className="inline-flex items-center gap-1"><span aria-hidden className="inline-block w-3 h-3 border border-black/40" style={{ background: l.color }} />{l.label}</span>
            ))}
            <span className="inline-flex items-center gap-1"><span aria-hidden className="inline-block w-3 h-3 border border-black/40" style={{ background: NO_DATA }} />{m === "winner" && level === "district" ? `${t("map.noData")} / ${t("map.tied")}` : t("map.noData")}</span>
          </div>
          <p className="text-[10px] font-sans">
            {level === "district" ? `${t("map.approx")} ` : ""}{t("map.source")}
          </p>
        </div>

        <aside className="lg:col-span-4 space-y-3 min-w-0" aria-label={t("map.panel.title")} data-testid="map-panel">
          <h3 className="text-sm font-black uppercase tracking-widest font-sans">{t("map.panel.title")}</h3>
          <SidePanel
            route={route} state={state} distFeature={distFeature} distName={distName ?? ""} acFeature={acFeature} acName={acRow?.name ?? ""}
            tally={route.district ? tally.get(route.district) : undefined}
            seat={route.ac !== undefined ? acSeatMap.get(route.ac) : undefined}
            population={distFeature && censusQ.data ? populationByDistrict(censusQ.data).get(nameKey(String(distFeature.properties.district))) ?? null : null}
          />
        </aside>
      </div>

      <section aria-labelledby="map-table-h" className="space-y-2">
        <h3 id="map-table-h" className="text-sm font-black uppercase tracking-widest font-sans">{t("map.table")}</h3>
        <div className="max-h-[420px] overflow-auto border border-black/20" tabIndex={0} role="region" aria-label={t("map.table")}>
          <table data-testid="map-table" className="w-full text-xs font-sans">
            <thead className="sticky top-0 bg-[#FAF8F5] text-[#121212]">
              <tr>
                <th scope="col" aria-sort={aria("name")} className="text-left p-2">
                  <button type="button" data-testid="map-sort-name" onClick={() => toggleSort("name")} className="font-black uppercase tracking-widest text-[10px] cursor-pointer">{t("map.col.name")} {sort.by === "name" ? (sort.dir === 1 ? "▲" : "▼") : ""}</button>
                </th>
                {level === "ac" && <th scope="col" className="text-left p-2 hidden sm:table-cell">{t("map.col.district")}</th>}
                <th scope="col" aria-sort={aria("value")} className="text-left p-2">
                  <button type="button" data-testid="map-sort-value" onClick={() => toggleSort("value")} className="font-black uppercase tracking-widest text-[10px] cursor-pointer">{t(METRIC_KEY[m])} {sort.by === "value" ? (sort.dir === 1 ? "▲" : "▼") : ""}</button>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => (
                <tr key={r.key} data-testid="map-row" data-key={r.key} onMouseEnter={() => setActive(r.key)} onMouseLeave={() => setActive(null)} className={`border-t border-black/10 ${selectedKey === r.key ? "bg-[#EADCC6] text-[#121212]" : ""}`}>
                  <th scope="row" className="text-left p-2 font-normal">
                    <button type="button" onFocus={() => setActive(r.key)} onBlur={() => setActive(null)} onClick={() => onSelect(r.key)} aria-pressed={selectedKey === r.key} className="underline text-left cursor-pointer">{r.name}</button>
                  </th>
                  {level === "ac" && <td className="p-2 hidden sm:table-cell">{r.sub}</td>}
                  <td className="p-2"><span aria-hidden className="inline-block w-2.5 h-2.5 mr-1.5 border border-black/40 align-middle" style={{ background: r.color }} />{r.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function SidePanel(p: {
  route: MapRoute; state: "AP" | "TG"; distFeature?: GeoFeature; distName: string; acFeature?: GeoFeature; acName: string;
  tally?: { seats: number; tally: Record<string, number> }; seat?: SeatLite; population: number | null;
}) {
  const { t, lang } = useT();
  const [te, setTe] = useState<TeNames | null>(null);
  useEffect(() => { let on = true; fetchTeNames(p.state).then((n) => on && setTe(n)).catch(() => undefined); return () => { on = false; }; }, [p.state]);
  const acQ = useApi(() => (p.route.ac !== undefined ? fetchAcDetail(p.state, p.route.ac) : Promise.resolve(null)), [p.state, p.route.ac]);

  if (p.acFeature) {
    const a = p.acFeature.properties;
    const nameTe = te?.acs[String(a.acNo)];
    const party = p.seat?.winnerParty ? partyInfo(p.seat.winnerParty) : null;
    return (
      <div data-testid="map-panel-ac" className="border border-black/20 bg-[#FAF8F5] text-[#121212] p-4 space-y-3 text-xs font-sans">
        <div>
          <p className="text-lg font-serif italic leading-tight">{lang === "te" && nameTe ? nameTe : p.acName || a.acName}</p>
          {nameTe && lang !== "te" && <p lang="te" className="text-sm">{nameTe}</p>}
          <p>{t("map.acNo")} {a.acNo} / {a.district} / {t("map.pcNo")} {a.pcNo} / {a.reservation}</p>
        </div>
        {party && (
          <p><span aria-hidden className="inline-block w-3 h-3 mr-1 border border-black/40 align-middle" style={{ background: party.color }} />{party.code}{p.seat?.winner ? `, ${p.seat.winner}` : ""}{typeof p.seat?.marginPct === "number" ? ` (${p.seat.marginPct.toFixed(1)}%)` : ""}</p>
        )}
        <UnitsPanel state={p.state} loading={acQ.loading} error={acQ.error} detail={acQ.data} lang={lang} />
      </div>
    );
  }
  if (p.route.district) {
    const l = p.tally ? leader(p.tally.tally) : null;
    return (
      <div data-testid="map-panel-district" className="border border-black/20 bg-[#FAF8F5] text-[#121212] p-4 space-y-2 text-xs font-sans">
        <p className="text-lg font-serif italic leading-tight">{p.distName}</p>
        {p.tally ? (
          <ul className="list-disc ml-4">
            {Object.entries(p.tally.tally).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([k, v]) => <li key={k}>{k}: {v}</li>)}
          </ul>
        ) : <p>{t("map.noData")}</p>}
        {l && l !== "tied" && <p>{t("map.leading")}: {l.party}</p>}
        {p.population !== null && <p>{t("map.m.population")}: {fmtInt(p.population)}</p>}
        <p>{t("map.pickAc")}</p>
      </div>
    );
  }
  return <p data-testid="map-panel-empty" className="border border-black/20 bg-[#FAF8F5] text-[#121212] p-4 text-xs font-sans">{t("map.panel.none")}</p>;
}
