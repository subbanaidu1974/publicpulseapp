import type { ReactNode } from "react";
import { api, type Forecast, type ForecastAlliance } from "../api/client";
import { useApi } from "../api/useApi";
import { useT } from "../i18n";
import type { StateCode } from "../lib/states";
import { ErrorBanner, fmt, Loading } from "./ui";

/** Display-capped chance: never shows more than ">90%" or less than "<10%" (model is overconfident in back-test). */
const pct = (p: number) => {
  const v = p <= 1 ? p * 100 : p;
  return v > 90 ? ">90%" : v < 10 ? "<10%" : `${Math.round(v)}%`;
};
const rate = (v: unknown) => (typeof v === "number" ? `${Math.round((v <= 1 ? v * 100 : v))}%` : "n/a");
const num = (v: unknown) => (typeof v === "number" ? fmt(v, 1) : "n/a");

interface Run { label: string; hit: unknown; persist: unknown; err: unknown }
function backtestRuns(b: unknown): Run[] {
  const arr = Array.isArray(b) ? b : Array.isArray((b as any)?.runs) ? (b as any).runs : [];
  return arr.map((r: any) => ({
    label: r.predictedFrom?.assembly !== undefined ? `${r.predictedFrom.assembly} → ${r.target}` : String(r.label ?? r.run ?? [r.from, r.target ?? r.to].filter(Boolean).join(" → ")),
    hit: r.winnerHitRate ?? r.hitRate, persist: r.persistenceHitRate ?? r.persistence, err: r.meanAbsSeatError,
  }));
}

function describe(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(describe).filter(Boolean).join(", ");
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${describe(x)}`).join("; ");
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : fmt(v, 2);
  return String(v);
}

function RangeRow({ a, total }: { a: ForecastAlliance; total: number; key?: string }) {
  const { t } = useT();
  const sc = (n: number) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
  return (
    <li data-testid="forecast-alliance" className="space-y-1 text-xs font-sans">
      <div className="flex justify-between gap-2">
        <span className="font-bold">{a.alliance}</span>
        <span className="font-mono">{a.seatsP10}&ndash;{a.seatsP90} ({a.seatsMedian})</span>
      </div>
      <div className="relative h-4 bg-black/10" aria-hidden="true">
        <div className="absolute h-4 bg-[#3F5B73]/40" style={{ left: sc(a.seatsP10), width: `calc(${sc(a.seatsP90)} - ${sc(a.seatsP10)})` }} />
        <div className="absolute h-4 w-1 bg-[#1f4e9c]" style={{ left: sc(a.seatsMedian) }} />
        <div className="absolute h-4 w-px bg-black" style={{ left: "50%" }} />
      </div>
      <div className="text-[11px] text-slate-700">{t("fc.majority")}: <strong className="font-mono">{pct(a.majorityProb)}</strong></div>
    </li>
  );
}

export default function ForecastPanel({ state }: { state: StateCode }) {
  const { t } = useT();
  const fc = useApi<Forecast | null>(() => api.forecast(state), [state]);
  const f = fc.data;

  const shell = (children: ReactNode) => (
    <section aria-labelledby="fc-h" data-testid="forecast-panel" className="border-2 border-black bg-[#FAF8F5] p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="fc-h" className="text-lg font-serif italic">{t("fc.title")}</h3>
        <span className="text-[10px] uppercase tracking-widest font-sans font-black bg-slate-800 text-white px-2 py-0.5">{t("fc.badge")}</span>
      </div>
      {children}
    </section>
  );

  if (fc.loading) return shell(<Loading />);
  if (fc.error) return shell(<ErrorBanner inline message={fc.error} onRetry={fc.retry} />);
  if (!f) return shell(<p data-testid="forecast-unavailable" className="text-xs font-sans">{t("fc.unavailable")}</p>);
  if (f.blackout) return shell(<p data-testid="forecast-blackout" role="status" className="text-sm font-serif border-l-4 border-amber-600 pl-3">{t("fc.blackout")}</p>);

  const seats = f.seats ?? [];
  const alliances = f.alliances ?? [];
  const total = Math.max(1, seats.length, ...alliances.map((a) => a.seatsP90));
  const count = (c: string) => seats.filter((s) => s.class === c).length;
  const toss = seats.filter((s) => s.class === "toss-up").sort((a, b) => a.marginPct - b.marginPct);
  const runs = backtestRuns(f.backtest);

  return shell(
    <>
      <p data-testid="forecast-disclaimer" className="text-sm font-serif border-l-4 border-amber-600 pl-3 bg-amber-50 py-2 pr-2">
        {f.disclaimer || t("fc.fallbackDisclaimer")}
      </p>
      <p className="text-[11px] font-sans text-slate-700">
        {f.basedOn !== undefined && <span>{t("fc.basedOn")}: {describe(f.basedOn)}. </span>}
        {f.method && <span>{t("fc.method")}: {f.method}</span>}
      </p>

      <div className="space-y-2">
        <h4 className="text-sm font-serif italic">{t("fc.expected")}</h4>
        <ul className="space-y-3">{alliances.map((a) => <RangeRow key={a.alliance} a={a} total={total} />)}</ul>
        <div className="sr-only"><table>
          <caption>{t("fc.expected")}</caption>
          <thead><tr><th scope="col">{t("tr.party")}</th><th scope="col">P10</th><th scope="col">50%</th><th scope="col">P90</th><th scope="col">{t("fc.majority")}</th></tr></thead>
          <tbody>{alliances.map((a) => <tr key={a.alliance}><th scope="row">{a.alliance}</th><td>{a.seatsP10}</td><td>{a.seatsMedian}</td><td>{a.seatsP90}</td><td>{pct(a.majorityProb)}</td></tr>)}</tbody>
        </table></div>
      </div>

      <div data-testid="forecast-backtest" className="space-y-2 border border-red-800 bg-red-50 p-3">
        <h4 className="text-sm font-serif italic">{t("fc.backtest")}</h4>
        <p data-testid="forecast-backtest-sentence" className="text-xs font-sans font-bold text-red-950">{t("fc.btSentence")}</p>
        {runs.length > 0 && (
          <div className="overflow-x-auto">
            <table data-testid="forecast-backtest-table" className="w-full text-xs font-sans text-left border-collapse bg-white">
              <thead><tr>
                <th scope="col" className="p-1.5 border-b border-black">{t("fc.btFrom")}</th>
                <th scope="col" className="p-1.5 border-b border-black text-right">{t("fc.btHit")}</th>
                <th scope="col" className="p-1.5 border-b border-black text-right">{t("fc.btPersist")}</th>
                <th scope="col" className="p-1.5 border-b border-black text-right">{t("fc.btErr")}</th>
              </tr></thead>
              <tbody>{runs.map((r, i) => (
                <tr key={i} className="border-b border-black/10">
                  <th scope="row" className="p-1.5 font-bold">{r.label}</th>
                  <td className="p-1.5 text-right font-mono">{rate(r.hit)}</td>
                  <td className="p-1.5 text-right font-mono">{rate(r.persist)}</td>
                  <td className="p-1.5 text-right font-mono">{num(r.err)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] font-sans text-slate-800">{t("fc.capNote")}</p>
      </div>

      <div data-testid="forecast-classes" className="space-y-1">
        <h4 className="text-sm font-serif italic">{t("fc.modelClass")}</h4>
        <dl className="grid grid-cols-3 gap-2 text-center font-sans">
          {([["safe", "fc.safe"], ["lean", "fc.lean"], ["toss-up", "fc.toss"]] as const).map(([c, k]) => (
            <div key={c} className="border border-black/30 bg-white p-2">
              <dt className="text-[10px] uppercase tracking-widest font-bold">{t(k)}</dt>
              <dd className="text-xl font-mono">{count(c)}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-serif italic">{t("fc.tossTable")} ({toss.length})</h4>
        {toss.length === 0 ? <p className="text-xs font-sans">{t("fc.noTossUps")}</p> : (
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table data-testid="forecast-toss-table" className="w-full text-xs font-sans text-left border-collapse bg-white">
              <thead className="sticky top-0 bg-white"><tr>
                <th scope="col" className="p-1.5 border-b border-black">{t("fc.seat")}</th>
                <th scope="col" className="p-1.5 border-b border-black">{t("fc.leader")}</th>
                <th scope="col" className="p-1.5 border-b border-black">{t("fc.runnerUp")}</th>
                <th scope="col" className="p-1.5 border-b border-black text-right">{t("fc.margin")}</th>
                <th scope="col" className="p-1.5 border-b border-black text-right">{t("fc.prob")}</th>
              </tr></thead>
              <tbody>{toss.map((s) => (
                <tr key={s.acNo} className="border-b border-black/10">
                  <th scope="row" className="p-1.5 font-bold">{s.acNo}. {s.acName}</th>
                  <td className="p-1.5">{s.leader}</td><td className="p-1.5">{s.runnerUp}</td>
                  <td className="p-1.5 text-right font-mono">{fmt(s.marginPct)}%</td>
                  <td className="p-1.5 text-right font-mono">{pct(s.winProbLeader)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>

    </>,
  );
}
