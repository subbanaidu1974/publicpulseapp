import { useMemo, useState } from "react";
import { analytics } from "../../api/analytics";
import type { TurnoutResponse } from "../../api/analytics";
import { useApi } from "../../api/useApi";
import { useStateCtx } from "../../state/StateContext";
import type { ElectionType } from "../../lib/states";
import { useAT } from "./analyticsText";
import { SourceBanner, SvgBars, Wait, fnum, fpct } from "./common";

type Sort = "no" | "turnout" | "turnoutAsc" | "nota" | "margin";

export default function TurnoutPage() {
  const { a, lang } = useAT();
  const { state } = useStateCtx();
  const [type, setType] = useState<ElectionType>("assembly");
  const [year, setYear] = useState<number | undefined>(undefined);
  const [sort, setSort] = useState<Sort>("no");
  const s = useApi<TurnoutResponse>(() => analytics.turnout(state, year, type), [state, year, type]);
  const na = a("an2.na");

  const seats = useMemo(() => {
    const list = [...(s.data?.seats ?? [])];
    const by: Record<Sort, (x: typeof list[number], y: typeof list[number]) => number> = {
      no: (x, y) => x.acNo - y.acNo,
      turnout: (x, y) => (y.turnoutPct ?? -1) - (x.turnoutPct ?? -1),
      turnoutAsc: (x, y) => (x.turnoutPct ?? 999) - (y.turnoutPct ?? 999),
      nota: (x, y) => (y.notaSharePct ?? -1) - (x.notaSharePct ?? -1),
      margin: (x, y) => x.marginPct - y.marginPct,
    };
    return list.sort(by[sort]);
  }, [s.data, sort]);

  return (
    <div className="space-y-6 font-sans" data-testid="turnout-page">
      <div className="flex flex-wrap gap-4 items-end">
        <label className="text-xs space-y-1">
          <span className="block font-bold">{a("an2.type")}</span>
          <select data-testid="turnout-type" className="border border-black bg-white text-[#121212] px-2 py-1" value={type} onChange={e => { setType(e.target.value as ElectionType); setYear(undefined); }}>
            <option value="assembly">{a("an2.assembly")}</option><option value="ls">{a("an2.ls")}</option>
          </select>
        </label>
        <label className="text-xs space-y-1">
          <span className="block font-bold">{a("an2.year")}</span>
          <select data-testid="turnout-year" className="border border-black bg-white text-[#121212] px-2 py-1" value={s.data?.year ?? ""} onChange={e => setYear(Number(e.target.value))}>
            {(s.data?.years ?? []).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
      </div>
      <Wait s={s}>
        {s.data && (() => {
          const d = s.data;
          const t = d.statewide;
          const districtName = (x: string) => x;
          return (
            <>
              <SourceBanner source={d.source} asOf={d.asOf} preBif={d.comparability === "pre-bifurcation"} demo={d.demo} />
              <section data-testid="turnout-state" className="space-y-2">
                <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.t.state")} ({d.state} {d.year})</h2>
                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div><dt className="text-slate-600">{a("an2.t.turnout")}</dt><dd data-testid="state-turnout" className="font-bold text-lg">{fpct(t.turnoutPct, na)}</dd></div>
                  <div><dt className="text-slate-600">{a("an2.t.electors")}</dt><dd className="font-bold text-lg">{fnum(t.electors, na)}</dd></div>
                  <div><dt className="text-slate-600">{a("an2.t.valid")}</dt><dd className="font-bold text-lg">{fnum(t.validVotes, na)}</dd></div>
                  <div><dt className="text-slate-600">{a("an2.t.notaShare")}</dt><dd data-testid="state-nota" className="font-bold text-lg">{d.notaAvailable ? fpct(t.notaSharePct, na) : na}</dd></div>
                </dl>
                {!d.notaAvailable && <p className="text-[11px]">{a("an2.t.notaNone")}</p>}
                <p className="text-[11px] text-slate-700"><strong>{a("an2.t.basis")}:</strong> {a("an2.t.basisText")} ({t.seatsWithElectors}/{t.seats} {a("an2.t.seatsCovered")})</p>
              </section>

              {d.districts.length > 0 && (
                <section className="grid gap-6 lg:grid-cols-2">
                  <SvgBars testId="chart-district-turnout" title={a("an2.t.byDistrict")} valueLabel={a("an2.t.turnout")} max={100}
                    data={d.districts.map(x => ({ label: districtName(x.district), value: x.turnoutPct }))} />
                  {d.notaAvailable && <SvgBars testId="chart-district-nota" title={a("an2.t.notaByDistrict")} valueLabel={a("an2.t.notaShare")}
                    data={d.districts.map(x => ({ label: districtName(x.district), value: x.notaSharePct }))} />}
                </section>
              )}

              <section data-testid="turnout-gender" className="space-y-2">
                <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.t.gender")}</h2>
                <p data-testid="gender-turnout-na" className="text-xs border border-black p-2">{a("an2.t.genderNone")}</p>
                <h3 className="text-xs font-bold">{a("an2.t.candSex")}</h3>
                {d.sex.available ? (
                  <dl data-testid="cand-sex-summary" className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div><dt className="text-slate-600">{a("an2.t.women")}</dt><dd className="font-bold text-lg">{d.sex.women} / {d.sex.candidates}</dd></div>
                    <div><dt className="text-slate-600">{a("an2.t.womenShare")}</dt><dd className="font-bold text-lg">{fpct(d.sex.womenSharePct, na)}</dd></div>
                    <div><dt className="text-slate-600">{a("an2.t.womenWon")}</dt><dd className="font-bold text-lg">{d.sex.womenWinners} / {d.sex.seats}</dd></div>
                  </dl>
                ) : <p className="text-xs">{a("an2.t.candSexNone")}</p>}
                <p className="text-[11px] text-slate-700">{a("an2.t.candSexNote")}</p>
              </section>

              <section className="space-y-2">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <h2 className="text-xs font-black uppercase tracking-[0.2em]">{a("an2.t.seats")} ({d.seats.length})</h2>
                  <label className="text-xs">
                    <span className="mr-2 font-bold">{a("an2.t.sortSeat")}</span>
                    <select data-testid="turnout-sort" className="border border-black bg-white text-[#121212] px-2 py-1" value={sort} onChange={e => setSort(e.target.value as Sort)}>
                      <option value="no">{a("an2.t.sort.no")}</option><option value="turnout">{a("an2.t.sort.turnout")}</option>
                      <option value="turnoutAsc">{a("an2.t.sort.turnoutAsc")}</option>
                      {d.notaAvailable && <option value="nota">{a("an2.t.sort.nota")}</option>}<option value="margin">{a("an2.t.sort.margin")}</option>
                    </select>
                  </label>
                </div>
                <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={a("an2.t.turnout")}>
                  <table data-testid="turnout-seat-table" className="w-full text-xs border-collapse min-w-[40rem]">
                    <thead><tr className="text-left border-b border-black">
                      <th className="py-1 pr-2">#</th><th className="pr-2">{a("an2.t.seat")}</th><th className="pr-2">{a("an2.t.district")}</th>
                      <th className="pr-2 text-right">{a("an2.t.electors")}</th><th className="pr-2 text-right">{a("an2.t.turnout")}</th>
                      <th className="pr-2 text-right">{a("an2.t.notaShare")}</th><th className="text-right">{a("an2.t.margin")}</th>
                    </tr></thead>
                    <tbody>
                      {seats.map(x => (
                        <tr key={x.acNo} data-testid="turnout-seat-row" className="border-b border-black/10">
                          <td className="py-1 pr-2">{x.acNo}</td><td className="pr-2">{lang === "te" && x.acNameTe ? x.acNameTe : x.acName}</td><td className="pr-2">{x.district ?? na}</td>
                          <td className="pr-2 text-right">{fnum(x.electors, na)}</td><td className="pr-2 text-right">{fpct(x.turnoutPct, na)}</td>
                          <td className="pr-2 text-right">{x.notaSharePct === null ? na : fpct(x.notaSharePct, na)}</td><td className="text-right">{fnum(x.margin, na)} ({x.marginPct.toFixed(1)}%)</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <ul data-testid="analytics-caveats" className="list-disc pl-5 text-[11px] text-slate-700 space-y-0.5">{d.caveats.map(c => <li key={c}>{c}</li>)}</ul>
            </>
          );
        })()}
      </Wait>
    </div>
  );
}
