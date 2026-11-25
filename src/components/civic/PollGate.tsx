import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { broadcastApi, type Poll } from "../../api/broadcast";
import { tokenStore } from "../../api/civic";
import { useT } from "../../i18n";

const TXT = {
  en: {
    badge: "Your opinion is requested", must: "Please answer every question to continue to the app. “Prefer not to say” is always an option.",
    submit: "Submit and continue", sending: "Sending", pick: "Choose one", pickMany: "Choose up to", answered: "answered", of: "of",
    err: "Could not send your answers. Check your connection and try again.", closed: "This poll has just closed. You can continue.", done: "Thank you. Your answer was recorded.",
    anon: "Your answer is counted but not linked to your name or account.",
  },
  te: {
    badge: "మీ అభిప్రాయం కోరుతున్నాము", must: "యాప్‌ను కొనసాగించడానికి అన్ని ప్రశ్నలకు సమాధానం ఇవ్వండి. “చెప్పదలచుకోలేదు” ఎంపిక ఎల్లప్పుడూ ఉంటుంది.",
    submit: "పంపి కొనసాగండి", sending: "పంపుతున్నాము", pick: "ఒకటి ఎంచుకోండి", pickMany: "గరిష్టంగా ఎంచుకోండి", answered: "సమాధానాలు", of: "/",
    err: "మీ సమాధానాలను పంపలేకపోయాము. కనెక్షన్ చూసి మళ్ళీ ప్రయత్నించండి.", closed: "ఈ పోల్ ఇప్పుడే ముగిసింది. మీరు కొనసాగవచ్చు.", done: "ధన్యవాదాలు. మీ సమాధానం నమోదైంది.",
    anon: "మీ సమాధానం లెక్కలోకి వస్తుంది, కానీ మీ పేరు లేదా ఖాతాతో అనుసంధానం కాదు.",
  },
};

/**
 * Broadcast poll gate (S-185). Wraps the whole app. While a signed-in person has an open, unanswered poll, everything underneath is inert
 * (no clicks, no tab stops, hidden from screen readers) and a modal dialog with no close button asks the questions. Submitting a full set of
 * answers releases the app. Nothing here runs for people who are not signed in, and admins are never blocked (the server returns no poll for them).
 */
export default function PollGate({ children }: { children: ReactNode }) {
  const [poll, setPoll] = useState<Poll | null>(null);
  const check = useCallback(async () => {
    if (!tokenStore.get()) { setPoll(null); return; }
    try { const r = await broadcastApi.pending(); setPoll((cur) => (r.poll && cur && cur.id === r.poll.id ? cur : r.poll)); } catch { /* a failed check never blocks or unblocks anyone */ }
  }, []);
  useEffect(() => {
    void check();
    const on = () => { void check(); };
    window.addEventListener("pp-session", on); window.addEventListener("focus", on); window.addEventListener("hashchange", on); document.addEventListener("visibilitychange", on);
    const timer = window.setInterval(on, 30_000);
    return () => { window.removeEventListener("pp-session", on); window.removeEventListener("focus", on); window.removeEventListener("hashchange", on); document.removeEventListener("visibilitychange", on); window.clearInterval(timer); };
  }, [check]);
  return (
    <>
      <div className="contents" {...(poll ? { inert: true, "aria-hidden": true } : {})}>{children}</div>
      {poll && <PollDialog poll={poll} onDone={() => { setPoll(null); void check(); }} />}
    </>
  );
}

function PollDialog({ poll, onDone }: { poll: Poll; onDone: () => void }) {
  const { lang } = useT();
  const L = TXT[lang === "te" ? "te" : "en"];
  const te = lang === "te";
  const [picked, setPicked] = useState<number[][]>(() => poll.questions.map(() => []));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { setPicked(poll.questions.map(() => [])); setErr(null); head.current?.focus(); }, [poll.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Focus trap: Tab and Shift+Tab stay inside the dialog; Escape does nothing (the poll cannot be dismissed).
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); return; }
    if (e.key !== "Tab" || !root.current) return;
    const f = [...root.current.querySelectorAll<HTMLElement>("input, button:not([disabled]), [tabindex='0']")];
    if (f.length === 0) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1], at = document.activeElement;
    if (e.shiftKey && (at === first || at === head.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  };
  const count = picked.filter((p) => p.length > 0).length;
  const complete = count === poll.questions.length;
  const toggle = (qi: number, oi: number) => setPicked((cur) => cur.map((p, i) => {
    if (i !== qi) return p;
    const q = poll.questions[qi], opt = q.options[oi];
    if (q.kind !== "multi" || opt.prefer_not) return [oi];
    const base = p.filter((n) => !q.options[n].prefer_not);
    return base.includes(oi) ? base.filter((n) => n !== oi) : base.length >= q.max_select ? base : [...base, oi];
  }));
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await broadcastApi.answer(poll.id, picked); onDone(); }
    catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "closed" || code === "already_answered") onDone(); else setErr(L.err);
    } finally { setBusy(false); }
  };
  const title = (te && poll.title_te) || poll.title_en, intro = (te && poll.intro_te) || poll.intro_en;
  return (
    <div className="fixed inset-0 z-[1000] bg-black/70 flex items-start sm:items-center justify-center overflow-y-auto p-3" data-testid="poll-overlay">
      <div ref={root} role="dialog" aria-modal="true" aria-labelledby="poll-title" aria-describedby="poll-must" data-testid="poll-dialog" onKeyDown={onKey}
        className="bg-[#FAF8F5] text-[#121212] border-2 border-black w-full max-w-xl my-4 p-4 sm:p-6 space-y-4">
        <p className="text-xs font-bold uppercase tracking-widest">{L.badge}</p>
        <h2 id="poll-title" ref={head} tabIndex={-1} className="text-xl font-black outline-none" data-testid="poll-title">{title}</h2>
        {intro && <p className="text-sm">{intro}</p>}
        <p id="poll-must" className="text-sm font-bold">{L.must}</p>
        <form onSubmit={(e) => { e.preventDefault(); if (complete && !busy) void submit(); }} className="space-y-4" noValidate>
          {poll.questions.map((q, qi) => (
            <fieldset key={qi} className="border border-black p-3 space-y-1" data-testid={`poll-q-${qi}`}>
              <legend className="font-bold text-sm px-1">{qi + 1}. {(te && q.text_te) || q.text_en}</legend>
              <p className="text-xs">{q.kind === "multi" ? `${L.pickMany} ${q.max_select}` : L.pick}</p>
              {q.options.map((o, oi) => {
                const on = picked[qi].includes(oi), id = `poll-${qi}-${oi}`;
                return (
                  <label key={oi} htmlFor={id} className={`flex items-center gap-3 min-h-[44px] px-2 border ${on ? "border-black bg-black text-white" : "border-black/30"}`}>
                    <input id={id} data-testid={`poll-opt-${qi}-${oi}`} type={q.kind === "multi" ? "checkbox" : "radio"} name={`poll-q-${qi}`} checked={on} onChange={() => toggle(qi, oi)} className="w-5 h-5" />
                    <span className="text-sm">{(te && o.label_te) || o.label_en}</span>
                  </label>
                );
              })}
            </fieldset>
          ))}
          <p className="text-xs" aria-live="polite" data-testid="poll-progress">{count} {L.of} {poll.questions.length} {L.answered}</p>
          {err && <p role="alert" className="text-red-800 text-sm font-bold" data-testid="poll-error">{err}</p>}
          <button type="submit" data-testid="poll-submit" disabled={!complete || busy} className="min-h-[44px] w-full px-4 py-2 text-sm font-bold border border-black bg-black text-white disabled:opacity-50">{busy ? L.sending : L.submit}</button>
        </form>
        <p className="text-xs">{L.anon}</p>
        <p className="text-xs">{te ? poll.note_te : poll.note_en}</p>
      </div>
    </div>
  );
}
