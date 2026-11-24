import { useState } from "react";
import { analytics } from "../../api/analytics";
import type { CompareResponse, TrailsResponse } from "../../api/analytics";
import { useApi } from "../../api/useApi";
import { useStateCtx } from "../../state/StateContext";
import { partyColor } from "../../lib/parties";
import type { IncumbencySummary } from "../../lib/comparison";
import { useAT } from "./analyticsText";
import { SourceBanner, Wait, fpct } from "./common";

function IncumbencyCard({ label, s }: { label: string; s: IncumbencySummary | null }) {
  const { a } = useAT();
  const na = a("an2.na");
  if (!s) return null;
  return (
    <div data-testid="incumbency-card" className="border border-black p-3 space-y-2 text-xs">
      <h3 className="font-bold">{label} {s.year}</h3>
      {s.available ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
          <dt>{a("an2.c.contesting")}</dt><dd data-testid="inc-contesting">{s.incumbentsContesting}</dd>
          <dt>{a("an2.c.won")}</dt><dd>{s.incumbentsWon}</dd>
          <dt>{a("an2.c.winRate")}</dt><dd data-testid="inc-winrate" className="font-bold">{fpct(s.winRatePct, na)}</dd>
          <dt>{a("an2.c.otherRate")}</dt><dd>{fpct(s.nonIncumbentWinRatePct, na)}</dd>
        </dl>
      ) : <p data-testid="inc-unavailable">{s.reason}</p>}
      {s.seatRetention && (
        <p>{a("an2.c.retention")} ({a("an2.c.since")} {s.seatRetention.previousYear}): <strong>{s.seatRetention.retained} / {s.seatRetention.seats}</strong> ({fpct(s.seatRetention.retainedPct, na)})</p>
      )}
      {s.swingVsIncumbent && s.swingVsIncumbent.matched > 0 && (
        <p>{a("an2.c.swing")} ({a("an2.c.since")} {s.swingVsIncumbent.previousYear}): {s.swingVsIncumbent.matched} {a("an2.c.matched")}; {a("an2.c.mean")} <strong>{s.swingVsIncumbent.meanPp}</strong>; {a("an2.c.median")} <strong>{s.swingVsIncumbent.medianPp}</strong></p>
      )}
    </div>
  );
}

function Trails() {
  const { a } = useAT();
  const { state } = useStateCtx();
  const [type, setType] = useState<"assembly" | "ls">("assembly");
  const [q, setQ] = useState("");
  const [sent, setSent] = useState("");
  const s = useApi<TrailsResponse | null>(() => (sent.replace(/[^A-Za-z]/g, "").length >= 2 ? analytics.trails(state, type, sent) : Promise.resolve(null)), [state, type, sent]);
  return (
    <section data-testid="trails" className="space-y-2">
      <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.c.trails")}</h2>
      <p className="text-[11px] text-slate-700">{a("an2.c.trailsNote")}</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); setSent(q.trim()); }}>
        <label className="text-xs"><span className="block font-bold">{a("an2.c.search")}</span>
          <input data-testid="trail-query" className="border border-black px-2 py-1 bg-white text-[#121212]" value={q} onChange={e => setQ(e.target.value)} placeholder={a("an2.c.searchHint")} />
        </label>
        <select aria-label={a("an2.type")} data-testid="trail-type" className="border border-black bg-white text-[#121212] px-2 py-1 text-xs" value={type} onChange={e => setType(e.target.value as "assembly" | "ls")}>
          <option value="assembly">{a("an2.assembly")}</option><option value="ls">{a("an2.ls")}</option>
        </select>
        <button type="submit" data-testid="trail-go" className="border border-black bg-black text-white px-3 py-1 text-xs uppercase tracking-widest font-black">{a("an2.c.go")}</button>
      </form>
      {sent && s.loading && <p className="text-xs">{a("an2.loading")}</p>}
      {s.data && (s.data.trails.length === 0 ? <p data-testid="trail-none" className="text-xs">{a("an2.c.none")}</p> : (
        <ul data-testid="trail-list" className="space-y-2">
          {s.data.trails.slice(0, 40).map(t => (
            <li key={`${t.acNo}-${t.name}`} data-testid="trail-item" className="border border-black/30 p-2 text-xs">
              <div className="font-bold">{t.name} <span className="font-normal">({t.acName}, #{t.acNo})</span></div>
              <div data-testid="trail-confidence">{a("an2.c.confidence")}: {t.match.confidence === "high" ? a("an2.c.high") : a("an2.c.medium")}</div>
              <ul className="flex flex-wrap gap-x-4">
                {t.appearances.map(p => <li key={p.year}>{p.year}: {p.party}, {p.sharePct.toFixed(1)}%{p.won ? ` (${a("an2.c.won1")})` : ""}{p.undivided ? " *" : ""}</li>)}
              </ul>
            </li>
          ))}
        </ul>
      ))}
    </section>
  );
}

export default function ComparePage() {
  const { a } = useAT();
  const { state } = useStateCtx();
  const [year, setYear] = useState<number | undefined>(undefined);
  const s = useApi<CompareResponse>(() => analytics.compare(state, year), [state, year]);
  return (
    <div className="space-y-6 font-sans" data-testid="compare-page">
      <label className="text-xs space-y-1 block">
        <span className="block font-bold">{a("an2.c.year")}</span>
        <select data-testid="compare-year" className="border border-black bg-white text-[#121212] px-2 py-1" value={s.data?.year ?? ""} onChange={e => setYear(Number(e.target.value))}>
          {(s.data?.years ?? []).map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </label>
      <Wait s={s}>
        {s.data && (() => {
          const d = s.data;
          return (
            <>
              <SourceBanner source={d.source} asOf={d.asOf} preBif={d.comparability === "pre-bifurcation"} demo={d.demo} />
              <section className="space-y-2" data-testid="party-compare">
                <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.c.parties")} ({d.state} {d.year})</h2>
                <svg role="img" aria-label={a("an2.c.parties")} viewBox={`0 0 560 ${d.parties.slice(0, 8).length * 34 + 6}`} className="w-full max-w-[640px] h-auto text-[#121212]">
                  {d.parties.slice(0, 8).map((p, i) => {
                    const y = i * 34 + 2, scale = 380 / Math.max(1, ...d.parties.map(x => Math.max(x.assemblyShare, x.lsShare)));
                    return (
                      <g key={p.party}>
                        <text x="54" y={y + 22} textAnchor="end" fontSize="11" fontWeight="700" fill="currentColor">{p.party}</text>
                        <rect x="60" y={y + 2} width={p.assemblyShare * scale} height="12" fill={partyColor(p.party)} />
                        <text x={64 + p.assemblyShare * scale} y={y + 12} fontSize="10" fill="currentColor">{a("an2.c.asm")} {p.assemblyShare.toFixed(1)}%</text>
                        <rect x="60" y={y + 16} width={p.lsShare * scale} height="12" fill={partyColor(p.party)} opacity="0.55" />
                        <text x={64 + p.lsShare * scale} y={y + 26} fontSize="10" fill="currentColor">{a("an2.c.ls")} {p.lsShare.toFixed(1)}%</text>
                      </g>
                    );
                  })}
                </svg>
                <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={a("an2.c.parties")}>
                  <table data-testid="party-compare-table" className="w-full text-xs border-collapse min-w-[32rem]">
                    <thead><tr className="text-left border-b border-black"><th className="py-1 pr-2">{a("an2.c.party")}</th><th className="pr-2 text-right">{a("an2.c.asm")} %</th><th className="pr-2 text-right">{a("an2.c.ls")} %</th><th className="pr-2 text-right">{a("an2.c.diff")}</th><th className="pr-2 text-right">{a("an2.c.seatsAsm")}</th><th className="text-right">{a("an2.c.seatsLs")}</th></tr></thead>
                    <tbody>{d.parties.map(p => (
                      <tr key={p.party} data-testid="party-compare-row" className="border-b border-black/10"><td className="py-1 pr-2 font-bold">{p.party}</td>
                        <td className="pr-2 text-right">{p.assemblyShare.toFixed(2)}</td><td className="pr-2 text-right">{p.lsShare.toFixed(2)}</td>
                        <td className="pr-2 text-right">{p.diffPp > 0 ? "+" : ""}{p.diffPp.toFixed(2)}</td><td className="pr-2 text-right">{p.assemblySeats}</td><td className="text-right">{p.lsSeats}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </section>

              <section className="space-y-2" data-testid="pc-compare">
                <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.c.pc")}</h2>
                <p className="text-[11px] text-slate-700">{a("an2.c.pcNote")}</p>
                <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={a("an2.c.pc")}>
                  <table className="w-full text-xs border-collapse min-w-[36rem]">
                    <thead><tr className="text-left border-b border-black"><th className="py-1 pr-2">{a("an2.c.pcName")}</th><th className="pr-2">{a("an2.c.winner")}</th><th className="pr-2 text-right">{a("an2.c.lsShare")} %</th><th className="pr-2 text-right">{a("an2.c.asmShare")} %</th><th className="pr-2 text-right">{a("an2.c.diff")}</th><th className="text-right">{a("an2.c.split")}</th></tr></thead>
                    <tbody>{d.constituencies.map(c => (
                      <tr key={c.pcNo} data-testid="pc-compare-row" className="border-b border-black/10"><td className="py-1 pr-2">{c.pcNo}. {c.pcName}</td><td className="pr-2 font-bold">{c.lsWinnerParty}</td>
                        <td className="pr-2 text-right">{c.lsWinnerShare.toFixed(1)}</td><td className="pr-2 text-right">{c.assemblyShareOfLsWinner.toFixed(1)}</td>
                        <td className="pr-2 text-right">{c.diffPp > 0 ? "+" : ""}{c.diffPp.toFixed(1)}</td><td className="text-right">{c.splitSegments.length} / {c.segments}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </section>

              <section className="space-y-2" data-testid="incumbency">
                <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.c.inc")}</h2>
                <p className="text-[11px] text-slate-700">{a("an2.c.incNote")}</p>
                <div className="grid gap-3 md:grid-cols-2">
                  <IncumbencyCard label={a("an2.c.incAssembly")} s={d.incumbency.assembly} />
                  <IncumbencyCard label={a("an2.c.incLs")} s={d.incumbency.ls} />
                </div>
              </section>

              <section data-testid="compare-caveats" className="space-y-1">
                <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.c.caveats")}</h2>
                <ul className="list-disc pl-5 text-[11px] text-slate-700 space-y-0.5">{d.notes.map(n => <li key={n}>{n}</li>)}</ul>
              </section>
            </>
          );
        })()}
      </Wait>
      <Trails />
    </div>
  );
}
