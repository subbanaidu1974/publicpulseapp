/**
 * Client side of count-day degraded mode (S-46, E2E-56; docs/DEGRADED_MODE.md).
 *  - `shedFrom` recognises the server's shed answer (503 with error "degraded", or the OTP queue-full 503 that sets degraded:true).
 *  - `reportShed` / `onShed` is a tiny bus so one banner can show the latest shed whatever screen made the call.
 *  - `useDegraded` polls GET /api/v1/degraded: slower when healthy, faster when degraded, exponential backoff on failure, paused while the tab is hidden.
 * Telugu strings are a machine draft awaiting native-speaker review.
 */
import { useEffect, useState } from "react";

export interface DegradedBannerText { title_en: string; title_te: string; body_en: string; body_te: string }
export interface DegradedStatus {
  degraded: boolean; read_only: boolean; reasons: string[]; since: string | null; retry_after_seconds: number;
  banner: DegradedBannerText | null; queue: { depth: number; max: number };
}
export interface ShedInfo { shed: string | null; notice_en: string; notice_te: string; retry_after_s: number; at: number }

const DEFAULT_NOTICE = {
  en: "This action is paused for a short while because of high demand. Please try again soon.",
  te: "అధిక రద్దీ కారణంగా ఈ పని కొద్దిసేపు నిలిపివేయబడింది. దయచేసి కొద్దిసేపటి తర్వాత ప్రయత్నించండి.",
};

/** Recognise a shed 503 from its status and parsed body. Returns null for any other response. */
export function shedFrom(status: number, body: unknown, retryAfterHeader?: string | null): ShedInfo | null {
  if ((status !== 503 && status !== 429) || !body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (status === 429 && b.degraded !== true) return null; // a plain rate limit is not a shed; the SMS budget refusal sets degraded:true
  if (b.error !== "degraded" && b.degraded !== true) return null;
  const hdr = Number(retryAfterHeader);
  const raw = Number(b.retry_after_seconds);
  const retry = Number.isFinite(raw) && raw > 0 ? raw : Number.isFinite(hdr) && hdr > 0 ? hdr : 60;
  const banner = b.banner as Record<string, unknown> | null | undefined;
  const pick = (k: string, d: string): string => (typeof b[k] === "string" && b[k] ? (b[k] as string) : d);
  return {
    shed: typeof b.shed === "string" ? b.shed : null,
    notice_en: pick("notice_en", typeof banner?.body_en === "string" ? banner.body_en : DEFAULT_NOTICE.en),
    notice_te: pick("notice_te", typeof banner?.body_te === "string" ? banner.body_te : DEFAULT_NOTICE.te),
    retry_after_s: Math.min(3600, Math.ceil(retry)),
    at: Date.now(),
  };
}

type Listener = (s: ShedInfo) => void;
const listeners = new Set<Listener>();
export function reportShed(s: ShedInfo): void { for (const l of [...listeners]) { try { l(s); } catch { /* a listener must not break the caller */ } } }
export function onShed(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; }
/** The shed carried by a thrown API error, if any. */
export const shedOf = (e: unknown): ShedInfo | null => ((e as { shed?: ShedInfo } | null)?.shed ?? null);

// ---- polling policy (pure, so it is unit-testable) ----
export const POLL_OK_MS = 30_000;
export const POLL_DEGRADED_MS = 15_000;
export const POLL_MAX_MS = 300_000;
export function nextPollDelay(failures: number, degraded: boolean): number {
  if (failures > 0) return Math.min(POLL_MAX_MS, POLL_OK_MS * 2 ** Math.min(failures, 8));
  return degraded ? POLL_DEGRADED_MS : POLL_OK_MS;
}

const validStatus = (j: unknown): j is DegradedStatus => !!j && typeof j === "object" && typeof (j as DegradedStatus).degraded === "boolean";

/** Poll the degraded state. `failed` is true while the last poll failed (the previous status is kept, never guessed). */
export function useDegraded(): { status: DegradedStatus | null; failed: boolean; refresh: () => void } {
  const [status, setStatus] = useState<DegradedStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | null = null, failures = 0, degraded = false;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const schedule = () => {
      clear();
      if (!alive || document.hidden) return; // paused while hidden; visibilitychange resumes with an immediate poll
      timer = setTimeout(() => void poll(), nextPollDelay(failures, degraded));
    };
    const poll = async () => {
      clear();
      try {
        const r = await fetch("/api/v1/degraded", { cache: "no-store" });
        const j: unknown = r.ok ? await r.json() : null;
        if (!alive) return;
        if (!validStatus(j)) throw new Error("bad");
        failures = 0; degraded = j.degraded; setFailed(false); setStatus(j);
      } catch {
        if (!alive) return;
        failures++; setFailed(true);
      }
      schedule();
    };
    const onVis = () => { if (!document.hidden) void poll(); else clear(); };
    document.addEventListener("visibilitychange", onVis);
    if (!document.hidden) void poll();
    return () => { alive = false; clear(); document.removeEventListener("visibilitychange", onVis); };
  }, [nonce]);
  return { status, failed, refresh: () => setNonce((n) => n + 1) };
}

/** Whole seconds left until `startedAt + seconds`, ticking once a second; 0 when it is time to retry. */
export function useCountdown(seconds: number, startedAt: number): number {
  const left = () => Math.max(0, Math.ceil((startedAt + seconds * 1000 - Date.now()) / 1000));
  const [n, setN] = useState(left);
  useEffect(() => {
    setN(left());
    const t = setInterval(() => { const v = left(); setN(v); if (v <= 0) clearInterval(t); }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, startedAt]);
  return n;
}

export const DEGRADED_TEXT = {
  en: {
    paused: "Paused for now", works: "What still works",
    pausedList: ["New sign-up codes", "Exports and bulk downloads", "Photo uploads", "Consultation, household and notification changes", "Survey credentials and survey set-up", "Me-too support on issues"],
    worksList: ["Reading public information", "Signing in and your existing session", "PIN recovery", "Reporting an issue and officer replies", "Answering a survey you already hold a credential for"],
    readOnly: "Read-only mode", since: "since", queue: "Sign-up codes waiting", of: "of",
    shedTitle: "This action is paused", retryIn: "You can try again in {n} seconds.", retryNow: "You can try again now.", retry: "Try again",
    queuedTitle: "Your code is queued", queuedBody: "Many people are signing up. Your code will be sent in about {n} seconds. Please wait on this page; it stays valid for 5 minutes after it arrives.",
    stale: "Could not check the platform status. Showing the last known state.",
  },
  te: {
    paused: "ప్రస్తుతం నిలిపివేసినవి", works: "ఇంకా పనిచేసేవి",
    pausedList: ["కొత్త సైన్ అప్ కోడ్‌లు", "ఎగుమతులు, పెద్ద డౌన్‌లోడ్‌లు", "ఫోటో అప్‌లోడ్‌లు", "సంప్రదింపులు, కుటుంబం, నోటిఫికేషన్ మార్పులు", "సర్వే క్రెడెన్షియల్స్, సర్వే ఏర్పాటు", "సమస్యలపై నాకూ ఇదే మద్దతు"],
    worksList: ["ప్రజా సమాచారం చదవడం", "సైన్ ఇన్, ఇప్పటికే ఉన్న సెషన్", "PIN రికవరీ", "సమస్య నివేదించడం, అధికారుల సమాధానాలు", "క్రెడెన్షియల్ ఉన్న సర్వేకు జవాబివ్వడం"],
    readOnly: "చదవడానికి మాత్రమే మోడ్", since: "నుండి", queue: "వేచి ఉన్న సైన్ అప్ కోడ్‌లు", of: "/",
    shedTitle: "ఈ పని నిలిపివేయబడింది", retryIn: "{n} సెకన్ల తర్వాత మళ్లీ ప్రయత్నించవచ్చు.", retryNow: "ఇప్పుడు మళ్లీ ప్రయత్నించవచ్చు.", retry: "మళ్లీ ప్రయత్నించండి",
    queuedTitle: "మీ కోడ్ వరుసలో ఉంది", queuedBody: "చాలా మంది సైన్ అప్ అవుతున్నారు. మీ కోడ్ సుమారు {n} సెకన్లలో పంపబడుతుంది. ఈ పేజీలోనే వేచి ఉండండి; అది వచ్చాక 5 నిమిషాలు చెల్లుతుంది.",
    stale: "ప్లాట్‌ఫామ్ స్థితిని తనిఖీ చేయలేకపోయాము. చివరిగా తెలిసిన స్థితి చూపబడుతోంది.",
  },
} as const;
