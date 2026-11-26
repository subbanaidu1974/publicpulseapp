import { useState } from "react";
import { analytics } from "../../api/analytics";
import { useApi } from "../../api/useApi";
import { useStateCtx } from "../../state/StateContext";
import { useAT, type AKey } from "./analyticsText";
import { fnum, fpct } from "./common";

/**
 * Browse panchayat results by place (S-214) and compare cycles (S-215). Shows nothing until a unit-level file with a stated source is loaded;
 * until then it says so. Sample data used in tests carries a loud banner. Places are listed by name, never ranked.
 */
export default function PanchayatBrowse() {
  const { a, lang } = useAT();
  const { state } = useStateCtx();
  const [election, setElection] = useState<string | undefined>();
  const [district, setDistrict] = useState<string | undefined>();
  const [mandal, setMandal] = useState<string | undefined>();
  const [q, setQ] = useState("");
  const u = useApi(() => analytics.panchayatUnits(state, { election, district, mandal, q: q.trim() || undefined }), [state, election, district, mandal, q]);
  const t = useApi(() => analytics.panchayatTrends(state), [state]);
  const na = a("an2.na");
  const k = (key: string) => a(`an2.pn.${key}` as AKey);
  const d = u.data;
  if (!d) return null;
  if (!d.loaded) return (
    <section data-testid="panchayat-browse" className="space-y-2">
      <h3 className="text-xs font-bold">{k("b.title")}</h3>
      <p data-testid="panchayat-browse-empty" role="status" className="text-sm border border-dashed border-black/40 p-3">{k("b.none")}</p>
      {d.problems.length > 0 && <ul data-testid="panchayat-browse-problems" className="text-xs list-disc pl-5">{d.problems.map((x) => <li key={x}>{x}</li>)}</ul>}
    </section>
  );
  const matchLabel = (m: string) => k(`b.m.${m}`);
  const pick = (id: string) => { setElection(id); setDistrict(undefined); setMandal(undefined); setQ(""); };
  const chip = "px-2 py-1 text-xs border border-black min-h-[32px] bg-white underline";
  return (
    <section data-testid="panchayat-browse" className="space-y-3 border-t border-black/20 pt-3">
      <h3 className="text-xs font-bold">{k("b.title")}</h3>
      {d.fixture && <p data-testid="panchayat-fixture" role="alert" className="border-2 border-red-700 bg-red-50 text-red-900 font-bold p-2 text-sm">{k("b.fixture")}</p>}

      <div className="flex flex-wrap items-end gap-3 border border-black/30 p-2 bg-slate-50">
        <label className="text-xs space-y-1">
          <span className="block font-bold">{k("b.election")}</span>
          <select data-testid="panchayat-election" value={d.election?.id} onChange={(e) => pick(e.target.value)} className="border border-black px-2 py-1 text-sm min-h-[32px] bg-white">
            {d.elections.map((e) => <option key={e.id} value={e.id}>{a(`an2.pn.level.${e.level}` as AKey)} {e.year}</option>)}
          </select>
        </label>
        <label className="text-xs space-y-1 grow min-w-[10rem]">
          <span className="block font-bold">{k("b.search")}</span>
          <input data-testid="panchayat-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={k("b.searchPh")} className="w-full border border-black px-2 py-1 text-sm min-h-[32px] bg-white" />
        </label>
      </div>

      <nav aria-label={k("b.title")} data-testid="panchayat-crumbs" className="text-xs flex flex-wrap gap-2 items-center">
        <button type="button" className={chip} onClick={() => { setDistrict(undefined); setMandal(undefined); setQ(""); }}>{k("b.all")}</button>
        {district && <><span aria-hidden="true">/</span><button type="button" className={chip} onClick={() => { setMandal(undefined); setQ(""); }}>{district}</button></>}
        {mandal && <><span aria-hidden="true">/</span><span className="font-bold">{mandal}</span></>}
      </nav>

      {d.groups && d.groups.length > 0 && (
        <div className="overflow-x-auto">
          <table data-testid="panchayat-groups" className="w-full text-left border-collapse text-xs">
            <caption className="sr-only">{d.view === "district" ? k("b.district") : k("b.mandal")}</caption>
            <thead><tr>{[d.view === "district" ? k("b.district") : k("b.mandal"), k("b.units"), k("b.posts"), k("b.unopp"), k("b.turnout"), ""].map((h, i) => <th key={i} scope="col" className="border-b border-black/30 py-1 pr-3 font-bold">{h}</th>)}</tr></thead>
            <tbody>
              {d.groups.map((g) => (
                <tr key={g.key} data-testid="panchayat-group" data-key={g.key}>
                  <th scope="row" className="border-b border-black/10 py-1 pr-3 font-bold">{g.name}</th>
                  <td className="border-b border-black/10 py-1 pr-3 font-mono">{fnum(g.units, na)}</td>
                  <td className="border-b border-black/10 py-1 pr-3 font-mono">{fnum(g.posts, na)}</td>
                  <td className="border-b border-black/10 py-1 pr-3 font-mono">{g.unopposed} ({g.unopposedPct}%)</td>
                  <td className="border-b border-black/10 py-1 pr-3 font-mono">{g.meanTurnoutPct == null ? na : fpct(g.meanTurnoutPct, na)}</td>
                  <td className="border-b border-black/10 py-1"><button type="button" className={chip} data-testid="panchayat-open" onClick={() => (d.view === "district" ? setDistrict(g.key) : setMandal(g.key))}>{k("b.open")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] mt-1">{k("b.turnoutNote")}</p>
        </div>
      )}

      {d.units && d.units.length > 0 && (
        <div className="overflow-x-auto">
          <table data-testid="panchayat-units" className="w-full text-left border-collapse text-xs">
            <caption className="sr-only">{k("b.panchayat")}</caption>
            <thead><tr>{[k("b.panchayat"), k("b.mandal"), k("b.posts"), a("an2.pn.turnout"), k("b.winner"), k("b.match")].map((h) => <th key={h} scope="col" className="border-b border-black/30 py-1 pr-3 font-bold">{h}</th>)}</tr></thead>
            <tbody>
              {d.units.map((x) => (
                <tr key={x.id} data-testid="panchayat-unit" data-match={x.match}>
                  <th scope="row" className="border-b border-black/10 py-1 pr-3 font-bold">{lang === "te" && x.nameTe ? x.nameTe : x.name}<span className="block text-[10px] font-normal">{x.district}</span></th>
                  <td className="border-b border-black/10 py-1 pr-3">{x.mandal ?? na}</td>
                  <td className="border-b border-black/10 py-1 pr-3 font-mono">{x.unopposed ? `${x.posts} (${k("b.unopp")})` : x.posts}</td>
                  <td className="border-b border-black/10 py-1 pr-3 font-mono">{x.turnoutPct == null ? na : fpct(x.turnoutPct, na)}</td>
                  <td className="border-b border-black/10 py-1 pr-3">{x.winner ? <>{x.winner.name}{x.winner.partyBacked && <span className="block text-[10px]">{k("b.backed")}: {x.winner.partyBacked}</span>}</> : na}</td>
                  <td className="border-b border-black/10 py-1 pr-3">{matchLabel(x.match)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] mt-1" role="status" data-testid="panchayat-unit-count">{k("b.showing").replace("{n}", String(d.units.length)).replace("{m}", String(d.unitTotal ?? d.units.length))}</p>
        </div>
      )}
      {d.view === "search" && (d.units?.length ?? 0) === 0 && <p data-testid="panchayat-browse-nomatch" className="text-sm border border-dashed border-black/40 p-3">{k("b.empty")}</p>}

      {d.join && (
        <div data-testid="panchayat-join" className="text-[11px] space-y-1">
          <p><strong>{k("b.join")}:</strong> {k("b.joinSummary").replace("{c}", String(d.join.byCode)).replace("{n}", String(d.join.byName)).replace("{u}", String(d.join.unmatched)).replace("{x}", String(d.join.conflicts)).replace("{t}", String(d.join.total))}</p>
          {d.join.unmatchedNames.length > 0 && <p>{k("b.unmatchedList")}: {d.join.unmatchedNames.join("; ")}</p>}
        </div>
      )}

      {t.data?.loaded && t.data.trends.length > 0 && (
        <div data-testid="panchayat-trends" className="space-y-2 border-t border-black/20 pt-3">
          <h3 className="text-xs font-bold">{k("b.trends")}</h3>
          {t.data.trends.map((tr) => (
            <div key={tr.level} data-testid="panchayat-trend" data-level={tr.level} className="space-y-1">
              <p className="text-xs font-bold">{a(`an2.pn.level.${tr.level}` as AKey)}</p>
              {tr.points.length < 2 ? <p className="text-[11px]">{k("b.trendNone")}</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead><tr>{[k("b.year"), k("b.units"), k("b.posts"), k("b.unopp"), k("b.turnout")].map((h) => <th key={h} scope="col" className="border-b border-black/30 py-1 pr-3 font-bold">{h}</th>)}</tr></thead>
                    <tbody>
                      {tr.points.map((p) => (
                        <tr key={p.id} data-testid="panchayat-trend-row">
                          <th scope="row" className="border-b border-black/10 py-1 pr-3 font-bold">{p.year}</th>
                          <td className="border-b border-black/10 py-1 pr-3 font-mono">{fnum(p.units, na)}</td>
                          <td className="border-b border-black/10 py-1 pr-3 font-mono">{fnum(p.posts, na)}</td>
                          <td className="border-b border-black/10 py-1 pr-3 font-mono">{p.unopposedPct}%</td>
                          <td className="border-b border-black/10 py-1 pr-3 font-mono">{p.meanTurnoutPct == null ? na : fpct(p.meanTurnoutPct, na)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <ul className="text-[11px] list-disc pl-5" data-testid="panchayat-trend-notes">{tr.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </div>
          ))}
        </div>
      )}
      <ul className="text-[11px] list-disc pl-5 space-y-1">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </section>
  );
}
