import { useState } from "react";
import { analytics } from "../../api/analytics";
import type { HistoryResponse } from "../../api/analytics";
import { useApi } from "../../api/useApi";
import { useStateCtx } from "../../state/StateContext";
import { partyColor } from "../../lib/parties";
import type { ElectionType } from "../../lib/states";
import { useAT } from "./analyticsText";
import { ByElectionItem, PartySwitchItem } from "./blocks";
import { SourceBanner, SvgBars, Wait } from "./common";

function Tally({ year, type }: { year: number; type: ElectionType }) {
  const { state } = useStateCtx();
  const { a } = useAT();
  const s = useApi(() => analytics.seats(state, year, type), [state, year, type]);
  return (
    <div data-testid="history-tally">
      {s.data && (
        <SvgBars testId="chart-history-tally" title={`${a("an2.h.tally")} (${state} ${year})`} valueLabel={a("an2.h.seats")} unit="" max={Math.max(...Object.values(s.data.tally))}
          data={Object.entries(s.data.tally).sort((x, y) => y[1] - x[1]).map(([p, n]) => ({ label: p, value: n, text: String(n), color: partyColor(p) }))} />
      )}
    </div>
  );
}

export default function HistoryPage() {
  const { a } = useAT();
  const { state } = useStateCtx();
  const h = useApi<HistoryResponse>(() => analytics.history(state), [state]);
  const by = useApi(() => analytics.byelections({ state }), [state]);
  const sw = useApi(() => analytics.partySwitches({ state }), [state]);
  const [pick, setPick] = useState<string>("");
  const first = h.data?.elections.find(e => e.comparability === "pre-bifurcation");
  const sel = pick || (first ? `${first.year}|${first.type}` : "");
  const [py, pt] = sel ? sel.split("|") : ["", ""];
  return (
    <div className="space-y-6 font-sans" data-testid="history-page">
      <Wait s={h}>
        {h.data && (
          <>
            <SourceBanner source={h.data.source} asOf={h.data.asOf} preBif />
            <section className="space-y-2">
              <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.h.undivided")}</h2>
              <ul data-testid="history-notes" className="list-disc pl-5 text-[11px] text-slate-700 space-y-0.5">{h.data.notes.map(n => <li key={n}>{n}</li>)}</ul>
            </section>
            <section className="space-y-2">
              <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.h.elections")}</h2>
              <ul className="grid gap-1 sm:grid-cols-2 text-xs" data-testid="history-elections">
                {h.data.elections.map(e => (
                  <li key={`${e.year}${e.type}`} data-testid="history-election" data-comparability={e.comparability} className="border border-black/30 p-2">
                    <strong>{e.year} {e.type === "ls" ? a("an2.ls") : a("an2.assembly")}</strong> &middot; {e.seats} {a("an2.h.seats")} &middot; {a("an2.h.comparability")}: {e.comparability === "pre-bifurcation" ? a("an2.h.pre") : a("an2.h.current")}
                    {e.note && <p className="text-[11px] text-slate-700">{e.note}</p>}
                  </li>
                ))}
              </ul>
              <label className="text-xs block">
                <span className="mr-2 font-bold">{a("an2.h.pick")}</span>
                <select data-testid="history-pick" className="border border-black bg-white text-[#121212] px-2 py-1" value={sel} onChange={e => setPick(e.target.value)}>
                  {h.data.elections.map(e => <option key={`${e.year}|${e.type}`} value={`${e.year}|${e.type}`}>{e.year} {e.type === "ls" ? a("an2.ls") : a("an2.assembly")}{e.comparability === "pre-bifurcation" ? ` (${a("an2.h.pre")})` : ""}</option>)}
                </select>
              </label>
              {py && <Tally year={Number(py)} type={pt as ElectionType} />}
            </section>
          </>
        )}
      </Wait>
      <section className="space-y-2" data-testid="byelections">
        <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.h.by")}</h2>
        <p className="text-[11px] text-slate-700">{a("an2.h.byNote")}</p>
        {by.data && <ul className="space-y-1">{by.data.records.map(r => <ByElectionItem key={r.id} r={r} showSeat />)}</ul>}
      </section>
      <section className="space-y-2" data-testid="partychanges-all">
        <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.pc.all")}</h2>
        <p className="text-[11px] text-slate-700">{a("an2.pc.note")}</p>
        {sw.data?.blackout ? <p className="text-xs">{a("an2.pc.paused")}</p> : sw.data && sw.data.records.length ? <ul className="space-y-1">{sw.data.records.map(r => <PartySwitchItem key={r.id} r={r} />)}</ul> : <p className="text-xs">{a("an2.pc.none")}</p>}
      </section>
    </div>
  );
}
