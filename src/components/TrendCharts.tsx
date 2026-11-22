import { useMemo } from "react";
import { api, type Summary } from "../api/client";
import { useApi } from "../api/useApi";
import { useT } from "../i18n";
import type { ElectionType, StateCode } from "../lib/states";
import { ELECTION_YEARS } from "../state/StateContext";
import { ErrorBanner, fmt, Loading, partyColor } from "./ui";

interface Election { year: number; type: ElectionType; summary: Summary }

const MAX_PARTIES = 6;

/** Parties ranked by a score map, top N, rest folded into "Others" by the caller. */
function topParties(elections: Election[], pick: (s: Summary) => Record<string, number>, n = MAX_PARTIES): string[] {
  const score: Record<string, number> = {};
  for (const e of elections) for (const [p, v] of Object.entries(pick(e.summary))) score[p] = (score[p] ?? 0) + v;
  return Object.entries(score).filter(([p]) => p !== "NOTA").sort((a, b) => b[1] - a[1]).slice(0, n).map(([p]) => p);
}

function Legend({ parties }: { parties: string[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-sans" aria-label="Legend">
      {parties.map((p) => (
        <li key={p} className="flex items-center gap-1"><span aria-hidden="true" className="inline-block w-3 h-3" style={{ background: partyColor(p) }} />{p}</li>
      ))}
    </ul>
  );
}

function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  const { t } = useT();
  return (
    <details className="text-xs font-sans">
      <summary className="cursor-pointer underline text-[11px] py-1">{t("tr.table")}</summary>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse mt-1">
          <caption className="sr-only">{caption}</caption>
          <thead><tr>{head.map((h) => <th key={h} scope="col" className="border-b border-black/30 py-1 pr-3 font-bold">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => j === 0
              ? <th key={j} scope="row" className="border-b border-black/10 py-1 pr-3 font-bold">{c}</th>
              : <td key={j} className="border-b border-black/10 py-1 pr-3 font-mono">{c}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    </details>
  );
}

/** Stacked columns: seats by party for each election. */
function SeatsChart({ elections, label }: { elections: Election[]; label: string }) {
  const { t } = useT();
  const parties = topParties(elections, (s) => s.tally);
  const totals = elections.map((e) => Object.values(e.summary.tally).reduce((a, b) => a + b, 0));
  const maxTotal = Math.max(1, ...totals);
  const W = 320, H = 200, padL = 28, padB = 24, padT = 10;
  const plotH = H - padB - padT;
  const band = (W - padL) / elections.length;
  const bw = Math.min(56, band * 0.6);
  const parts = [...parties, "OTH"];
  const seatsOf = (e: Election, p: string) =>
    p === "OTH" ? Object.entries(e.summary.tally).filter(([k]) => !parties.includes(k)).reduce((a, [, v]) => a + v, 0) : e.summary.tally[p] ?? 0;
  const summaryText = elections.map((e) => `${e.year}: ${parties.map((p) => `${p} ${seatsOf(e, p)}`).join(", ")}`).join("; ");
  return (
    <figure className="space-y-2" data-testid="trend-seats-chart">
      <figcaption className="text-sm font-serif italic">{label}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}. ${summaryText}`} className="w-full h-auto max-w-xl">
        {[0, 0.5, 1].map((f) => {
          const y = padT + plotH * (1 - f);
          return <g key={f}><line x1={padL} x2={W} y1={y} y2={y} stroke="#0002" /><text x={padL - 4} y={y + 3} textAnchor="end" fontSize="9" fill="#333">{Math.round(maxTotal * f)}</text></g>;
        })}
        {elections.map((e, i) => {
          const x = padL + band * i + (band - bw) / 2;
          let acc = 0;
          return (
            <g key={e.year}>
              {parts.map((p) => {
                const v = seatsOf(e, p);
                if (!v) return null;
                const h = (v / maxTotal) * plotH;
                const y = padT + plotH - ((acc + v) / maxTotal) * plotH;
                acc += v;
                return (
                  <g key={p}>
                    <rect x={x} y={y} width={bw} height={h} fill={p === "OTH" ? "#8a8a8a" : partyColor(p)} stroke="#fff" strokeWidth="0.5"><title>{`${e.year} ${p}: ${v} ${t("tr.seatsOf")}`}</title></rect>
                    {h > 13 && <text x={x + bw / 2} y={y + h / 2 + 3} textAnchor="middle" fontSize="9" fill="#fff" fontWeight="700">{v}</text>}
                  </g>
                );
              })}
              <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="#111">{e.year}</text>
            </g>
          );
        })}
      </svg>
      <Legend parties={[...parties, "OTH"]} />
      <DataTable caption={label} head={[t("tr.party"), ...elections.map((e) => String(e.year))]}
        rows={parts.map((p) => [p, ...elections.map((e) => seatsOf(e, p))])} />
    </figure>
  );
}

/** Lines: vote share by party across elections. */
function ShareChart({ elections, label }: { elections: Election[]; label: string }) {
  const { t } = useT();
  const parties = topParties(elections, (s) => s.voteShare, 5);
  const W = 320, H = 190, padL = 28, padB = 24, padT = 10;
  const plotH = H - padB - padT, plotW = W - padL - 16;
  const maxV = Math.max(10, Math.ceil(Math.max(...elections.flatMap((e) => parties.map((p) => e.summary.voteShare[p] ?? 0))) / 10) * 10);
  const xs = (i: number) => padL + (elections.length === 1 ? plotW / 2 : (plotW * i) / (elections.length - 1));
  const ys = (v: number) => padT + plotH * (1 - v / maxV);
  const summaryText = parties.map((p) => `${p}: ${elections.map((e) => `${e.year} ${fmt(e.summary.voteShare[p])}%`).join(", ")}`).join("; ");
  return (
    <figure className="space-y-2" data-testid="trend-share-chart">
      <figcaption className="text-sm font-serif italic">{label} (%)</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}. ${summaryText}`} className="w-full h-auto max-w-xl">
        {[0, 0.5, 1].map((f) => (
          <g key={f}><line x1={padL} x2={W} y1={ys(maxV * f)} y2={ys(maxV * f)} stroke="#0002" /><text x={padL - 4} y={ys(maxV * f) + 3} textAnchor="end" fontSize="9" fill="#333">{Math.round(maxV * f)}</text></g>
        ))}
        {parties.map((p) => {
          const pts = elections.map((e, i) => [xs(i), ys(e.summary.voteShare[p] ?? 0)] as const);
          return (
            <g key={p}>
              <polyline fill="none" stroke={partyColor(p)} strokeWidth="2" points={pts.map((q) => q.join(",")).join(" ")} />
              {pts.map((q, i) => <circle key={i} cx={q[0]} cy={q[1]} r="3" fill={partyColor(p)}><title>{`${p} ${elections[i].year}: ${fmt(elections[i].summary.voteShare[p])}%`}</title></circle>)}
            </g>
          );
        })}
        {elections.map((e, i) => <text key={e.year} x={xs(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#111">{e.year}</text>)}
      </svg>
      <Legend parties={parties} />
      <DataTable caption={label} head={[t("tr.party"), ...elections.map((e) => `${e.year} %`)]}
        rows={parties.map((p) => [p, ...elections.map((e) => fmt(e.summary.voteShare[p]))])} />
    </figure>
  );
}

/** Diverging bars for swing between the last two elections. */
function SwingChart({ state, type, years }: { state: StateCode; type: ElectionType; years: number[] }) {
  const { t } = useT();
  const from = years[years.length - 2], to = years[years.length - 1];
  const sw = useApi(() => (from && to ? api.swing(state, type, from, to) : Promise.resolve(null)), [state, type, from, to]);
  if (!from || !to) return <p className="text-xs font-sans">{t("tr.swingNone")}</p>;
  if (sw.loading) return <Loading />;
  if (sw.error) return <ErrorBanner inline message={sw.error} onRetry={sw.retry} />;
  const rows = (Object.entries(sw.data?.swing ?? {}) as [string, number][]).filter(([p]) => p !== "NOTA").sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 7);
  const max = Math.max(1, ...rows.map(([, v]) => Math.abs(v)));
  return (
    <div data-testid="trend-swing" className="space-y-1.5">
      <p className="text-xs font-sans font-bold">{from} &rarr; {to}</p>
      {rows.map(([p, v]) => (
        <div key={p} className="flex items-center gap-2 text-xs font-sans">
          <span className="w-16 shrink-0 font-bold truncate">{p}</span>
          <div className="flex-1 grid grid-cols-2 h-4 bg-black/5" aria-hidden="true">
            <div className="flex justify-end">{v < 0 && <div style={{ width: `${(Math.abs(v) / max) * 100}%`, background: partyColor(p) }} className="h-4" />}</div>
            <div>{v >= 0 && <div style={{ width: `${(v / max) * 100}%`, background: partyColor(p) }} className="h-4" />}</div>
          </div>
          <span className="w-14 shrink-0 text-right font-mono">{v > 0 ? "+" : ""}{fmt(v)}</span>
        </div>
      ))}
    </div>
  );
}

export default function TrendCharts({ state }: { state: StateCode }) {
  const { t } = useT();
  const data = useApi(async () => {
    let list: { year: number; type: ElectionType }[] = [];
    try { list = (await api.states()).find((s) => s.code === state)?.elections ?? []; } catch { /* fall back below */ }
    if (!list.length) list = (["assembly", "ls"] as ElectionType[]).flatMap((type) => ELECTION_YEARS[state][type].map((year) => ({ year, type })));
    const res = await Promise.all(list.map(async (e) => ({ ...e, summary: await api.summary(state, e.year, e.type) })));
    return res.filter((e) => e.summary.totalSeats !== 0).sort((a, b) => a.year - b.year);
  }, [state]);

  const groups = useMemo(() => {
    const all = data.data ?? [];
    return (["assembly", "ls"] as ElectionType[]).map((type) => ({ type, items: all.filter((e) => e.type === type) })).filter((g) => g.items.length > 0);
  }, [data.data]);

  return (
    <section aria-labelledby="trends-h" data-testid="trend-charts" className="space-y-6">
      <h3 id="trends-h" className="text-lg font-serif italic border-b border-black pb-1">{t("tr.title")}</h3>
      {data.loading && <Loading />}
      {data.error && <ErrorBanner inline message={data.error} onRetry={data.retry} />}
      {groups.map((g) => {
        const label = t(g.type === "ls" ? "tr.ls" : "tr.assembly");
        return (
          <div key={g.type} data-testid={`trend-group-${g.type}`} className="border border-black/20 bg-white p-4 space-y-5">
            <h4 className="text-[11px] uppercase tracking-[0.2em] font-sans font-black text-slate-700">{label}</h4>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <SeatsChart elections={g.items} label={`${label}: ${t("tr.seatsByParty")}`} />
              <ShareChart elections={g.items} label={`${label}: ${t("tr.voteShareTrend")}`} />
            </div>
            <div className="space-y-2">
              <h5 className="text-sm font-serif italic">{t("tr.swing")}</h5>
              <SwingChart state={state} type={g.type} years={g.items.map((e) => e.year)} />
            </div>
          </div>
        );
      })}
      {!data.loading && !data.error && <p className="text-[11px] font-sans text-slate-700">{t("tr.noTurnout")}</p>}
    </section>
  );
}
