import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { DEGRADED_TEXT, onShed, useCountdown, useDegraded, type ShedInfo } from "../lib/degraded";

/** Server notice for a shed action with a live retry countdown (from Retry-After). Used by the banner and by screens that hit a shed 503. */
export function ShedNotice({ shed, onRetry, testid = "shed-notice", live = "alert" }: { shed: ShedInfo; onRetry?: () => void; testid?: string; live?: "alert" | "status" }) {
  const { lang } = useT();
  const x = DEGRADED_TEXT[lang === "te" ? "te" : "en"];
  const left = useCountdown(shed.retry_after_s, shed.at);
  return (
    <div role={live} lang={lang} data-testid={testid} data-shed={shed.shed ?? ""} className="border-2 border-black bg-[#F4EBD0] text-[#121212] p-3 space-y-1 text-sm">
      <p className="font-bold">{x.shedTitle}</p>
      <p data-testid={`${testid}-text`}>{lang === "te" ? shed.notice_te : shed.notice_en}</p>
      <p data-testid={`${testid}-countdown`} data-left={left}>{left > 0 ? x.retryIn.replace("{n}", String(left)) : x.retryNow}</p>
      {onRetry && <button type="button" data-testid={`${testid}-retry`} disabled={left > 0} onClick={onRetry} className="min-h-[44px] min-w-[44px] px-4 py-2 text-sm font-bold border border-black bg-white text-black disabled:opacity-60">{x.retry}</button>}
    </div>
  );
}

/** OTP queue answer (200 queued:true, expected_delay_s): a friendly wait state with a countdown, never an error. */
export function QueuedNotice({ seconds, startedAt }: { seconds: number; startedAt: number }) {
  const { lang } = useT();
  const x = DEGRADED_TEXT[lang === "te" ? "te" : "en"];
  const left = useCountdown(seconds, startedAt);
  return (
    <div role="status" lang={lang} data-testid="otp-queued" data-seconds={seconds} className="border-2 border-black bg-[#F4EBD0] text-[#121212] p-3 space-y-1 text-sm">
      <p className="font-bold">{x.queuedTitle}</p>
      <p>{x.queuedBody.replace("{n}", String(Math.max(left, 1)))}</p>
    </div>
  );
}

/**
 * Site-wide banner (mounted once in App). Shows the server's bilingual banner while GET /api/v1/degraded says degraded, what is paused,
 * what still works, and the latest shed answer any screen received. It shows nothing when the platform is healthy.
 */
export default function DegradedBanner() {
  const { lang } = useT();
  const x = DEGRADED_TEXT[lang === "te" ? "te" : "en"];
  const { status, failed, refresh } = useDegraded();
  const [shed, setShed] = useState<ShedInfo | null>(null);
  // A shed answer is news: remember it and re-check the platform state now rather than at the next poll.
  useEffect(() => onShed((s) => { setShed(s); refresh(); }), [refresh]);
  const on = !!status?.degraded && !!status.banner;
  if (!on && !shed) return null;
  const b = status?.banner;
  const q = status?.queue;
  return (
    <div lang={lang} data-testid="degraded-banner" data-degraded={on ? "1" : "0"} data-read-only={status?.read_only ? "1" : "0"} className="w-full border-b-2 border-black bg-[#F4EBD0] text-[#121212] px-4 sm:px-6 py-3 text-sm space-y-2">
      <div role="status" aria-live="polite" className="space-y-1">
        {on && b && (<>
          <p className="font-bold" data-testid="degraded-title">{lang === "te" ? b.title_te : b.title_en}{status?.read_only ? ` (${x.readOnly})` : ""}</p>
          <p data-testid="degraded-body">{lang === "te" ? b.body_te : b.body_en}</p>
          {status?.since && <p className="text-xs">{x.since} {status.since.slice(11, 16)} UTC{q && q.depth > 0 ? ` | ${x.queue}: ${q.depth} ${x.of} ${q.max}` : ""}</p>}
        </>)}
        {failed && <p className="text-xs" data-testid="degraded-stale">{x.stale}</p>}
      </div>
      {on && (
        <details data-testid="degraded-works" className="text-xs">
          <summary className="cursor-pointer font-bold underline min-h-[44px] inline-flex items-center">{x.works}</summary>
          <div className="grid sm:grid-cols-2 gap-3 pt-2">
            <div><strong>{x.paused}</strong><ul className="list-disc pl-5" data-testid="degraded-paused">{x.pausedList.map((s) => <li key={s}>{s}</li>)}</ul></div>
            <div><strong>{x.works}</strong><ul className="list-disc pl-5" data-testid="degraded-works-list">{x.worksList.map((s) => <li key={s}>{s}</li>)}</ul></div>
          </div>
        </details>
      )}
      {shed && <ShedNotice shed={shed} live="status" testid="banner-shed" onRetry={() => setShed(null)} />}
    </div>
  );
}
