import { ReactNode } from "react";
import { useT } from "../i18n";
import { isErrKey } from "../i18n/errors";

export function DemoBadge({ className = "", testId = "demo-badge" }: { className?: string; testId?: string }) {
  const { t } = useT();
  return (
    <span data-testid={testId} className={`inline-block text-[9px] font-sans font-black uppercase tracking-widest bg-amber-200 text-amber-950 border border-amber-700 px-2 py-0.5 ${className}`}>
      {t("common.demo")}
    </span>
  );
}

export function ErrorBanner({ message, onRetry, inline = false }: { message: string; onRetry: () => void; inline?: boolean }) {
  const { t } = useT();
  return (
    <div data-testid={inline ? "error-banner-inline" : "error-banner"} role="alert" className="border border-red-700 bg-red-50 text-red-900 p-4 flex flex-wrap items-center justify-between gap-3 font-sans text-xs">
      <span><strong>{t("common.error")}.</strong> {isErrKey(message) ? t(message) : message}</span>
      <button data-testid={inline ? "retry-button-inline" : "retry-button"} type="button" onClick={onRetry} className="border border-red-800 bg-red-800 text-white px-4 py-1.5 uppercase tracking-widest text-[10px] font-black cursor-pointer">
        {t("common.retry")}
      </button>
    </div>
  );
}

export function Loading() {
  const { t } = useT();
  return <p role="status" className="text-xs text-slate-600 font-sans py-4">{t("common.loading")}</p>;
}

/** Horizontal CSS bar. `label` is shown left, `value` text right. */
export function Bar({ label, value, pct, color = "#121212", testId }: { label: ReactNode; value: ReactNode; pct: number; color?: string; testId?: string; key?: string }) {
  return (
    <div data-testid={testId} className="flex items-center gap-2 text-xs font-sans">
      <span className="w-20 shrink-0 font-bold truncate" title={typeof label === "string" ? label : undefined}>{label}</span>
      <div className="flex-1 bg-black/10 h-4 min-w-0" aria-hidden="true">
        <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} className="h-4" />
      </div>
      <span className="w-20 shrink-0 text-right font-mono">{value}</span>
    </div>
  );
}

/** Party colours come from the hand-curated registry (data/reference/parties.json, >= 3:1 on white); unknown parties get the Others colour. */
export { partyColor } from "../lib/parties";

export const fmt = (n: number | undefined, d = 1) => (n === undefined || n === null || Number.isNaN(n) ? "n/a" : n.toFixed(d));
