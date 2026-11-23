import type { ReactNode } from "react";
import type { ApiState } from "../../api/useApi";
import type { SourceEnv } from "../../api/analytics";
import { ErrorBanner, Loading } from "../ui";
import { useAT } from "./analyticsText";

export const analyticsHref = (page?: string) => "#/analytics" + (page ? "/" + page : "");
export const fnum = (n: number | null | undefined, na: string, d = 0) => (typeof n === "number" ? n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) : na);
export const fpct = (n: number | null | undefined, na: string) => (typeof n === "number" ? `${n.toFixed(2)}%` : na);

export function Wait<T>({ s, children }: { s: ApiState<T>; children: ReactNode }) {
  if (s.loading) return <Loading />;
  if (s.error || !s.data) return <ErrorBanner message={s.error ?? "error"} onRetry={s.retry} />;
  return <>{children}</>;
}

/** Provenance banner shown on every analytics page: where the figures come from, licence and as-of date. */
export function SourceBanner({ source, asOf, preBif, demo }: { source: SourceEnv | null | undefined; asOf?: string | null; preBif?: boolean; demo?: boolean }) {
  const { a } = useAT();
  return (
    <aside data-testid="analytics-source" className="border border-black bg-black/5 p-3 text-[11px] font-sans space-y-1">
      <strong className="uppercase tracking-widest text-[10px]">{a("an2.source")}</strong>
      <p data-testid="analytics-attribution">{source?.attribution ?? a("an2.na")}</p>
      <p>
        {a("an2.provenance")}: {source?.provenance ?? a("an2.na")}{demo ? " (demo)" : ""} &middot; {a("an2.asOf")}: {asOf ?? source?.asOf ?? a("an2.na")}
      </p>
      {source?.urls?.length ? <p className="break-words">{source.urls.map((u, i) => <span key={u}>{i > 0 && " | "}<a className="underline" href={u} target="_blank" rel="noopener noreferrer">{u.replace(/^https?:\/\//, "")}</a></span>)}</p> : null}
      {preBif && <p data-testid="prebif-flag" className="font-bold">{a("an2.preBif")}</p>}
    </aside>
  );
}

export interface BarDatum { label: string; value: number | null; text?: string; color?: string }

/**
 * Plain SVG horizontal bar chart with a table fallback. `max` fixes the axis (default: largest value). Null values render as a label only.
 * The table is always in the DOM inside <details>, so the figures are readable without the graphic.
 */
export function SvgBars({ title, data, unit = "%", max, valueLabel, testId }: { title: string; data: BarDatum[]; unit?: string; max?: number; valueLabel: string; testId: string }) {
  const { a } = useAT();
  const rowH = 20, labelW = 150, valW = 64, W = 560, barW = W - labelW - valW;
  const top = max ?? Math.max(1, ...data.map(d => d.value ?? 0));
  const H = data.length * rowH + 4;
  return (
    <figure data-testid={testId} className="space-y-1">
      <figcaption className="text-xs font-bold">{title}</figcaption>
      <svg role="img" aria-label={title} viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[640px] h-auto text-[#121212]" style={{ fontFamily: "inherit" }}>
        {data.map((d, i) => {
          const y = i * rowH + 2;
          const w = d.value === null ? 0 : Math.max(1, (d.value / top) * barW);
          return (
            <g key={d.label}>
              <text x={labelW - 6} y={y + 13} textAnchor="end" fontSize="11" fill="currentColor">{d.label.length > 22 ? d.label.slice(0, 21) + "…" : d.label}</text>
              <rect x={labelW} y={y + 2} width={barW} height={12} fill="currentColor" opacity="0.08" />
              {d.value !== null && <rect x={labelW} y={y + 2} width={w} height={12} fill={d.color ?? "#121212"} />}
              <text x={labelW + barW + 6} y={y + 13} fontSize="11" fill="currentColor">{d.text ?? (d.value === null ? a("an2.na") : `${d.value.toFixed(1)}${unit}`)}</text>
            </g>
          );
        })}
      </svg>
      <details data-testid={`${testId}-table`} className="text-[11px]">
        <summary className="cursor-pointer underline">{a("an2.table")}</summary>
        <table className="w-full border-collapse mt-1">
          <thead><tr className="text-left border-b border-black"><th className="py-0.5 pr-2">{title}</th><th>{valueLabel}</th></tr></thead>
          <tbody>{data.map(d => <tr key={d.label} className="border-b border-black/10"><td className="py-0.5 pr-2">{d.label}</td><td>{d.text ?? (d.value === null ? a("an2.na") : `${d.value.toFixed(2)}${unit}`)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}
