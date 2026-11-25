import { useState } from "react";
import { broadcastApi, type PollResults } from "../../../api/broadcast";
import { Btn, ErrorNote, Field, TextInput, inputCls } from "../ui";
import { Gate, useGuarded } from "./shared";

interface QDraft { kind: "single" | "multi" | "scale5"; text_en: string; text_te: string; options: string; max: string }
const blank = (): QDraft => ({ kind: "single", text_en: "", text_te: "", options: "", max: "" });

/**
 * Admin screen for broadcast polls (S-185): write a poll, push it to every signed-in person, watch the response count, read results, close it.
 * English only (operator tool).
 */
export default function PollsAdmin() {
  const { data, state, reload } = useGuarded(() => broadcastApi.adminList());
  const [title, setTitle] = useState(""), [titleTe, setTitleTe] = useState(""), [intro, setIntro] = useState(""), [closes, setCloses] = useState(""), [opens, setOpens] = useState("");
  const [qs, setQs] = useState<QDraft[]>([blank()]);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null), [msg, setMsg] = useState<string | null>(null);
  const [res, setRes] = useState<PollResults | null>(null);
  const setQ = (i: number, p: Partial<QDraft>) => setQs((c) => c.map((q, k) => (k === i ? { ...q, ...p } : q)));

  const publish = async () => {
    setErr(null); setMsg(null);
    try {
      const body = {
        title_en: title, title_te: titleTe || undefined, intro_en: intro || undefined, opens_at: opens ? new Date(opens).toISOString() : undefined, closes_at: closes ? new Date(closes).toISOString() : undefined,
        questions: qs.map((q) => ({ kind: q.kind, max_select: q.kind === "multi" && q.max ? Number(q.max) : undefined, text_en: q.text_en, text_te: q.text_te || undefined, options: q.kind === "scale5" ? undefined : q.options.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [en, te] = l.split("|").map((s) => s.trim()); return { label_en: en, label_te: te || undefined }; }) })),
      };
      const p = await broadcastApi.adminCreate(body);
      setMsg(`${p.opened_at > new Date().toISOString() ? "Poll scheduled for " + new Date(p.opened_at).toLocaleString() : "Poll opened"}. Id ${p.id.slice(0, 8)}.`);
      setTitle(""); setTitleTe(""); setIntro(""); setCloses(""); setOpens(""); setQs([blank()]); setConfirm(false); reload();
    } catch (e) { setErr((e as { body?: { message?: string } }).body?.message ?? (e as Error).message); }
  };

  return (
    <section data-testid="polls-admin" aria-labelledby="pa-h" className="space-y-3">
      <h4 id="pa-h" className="font-bold">Broadcast polls</h4>
      <p><a href="#/" data-testid="pa-back" className="underline text-sm">Back to the app</a></p>
      <p className="text-sm">Blocks the app for every signed-in person until they answer. Admins are not blocked. Party or candidate choices are refused.</p>
      <div className="space-y-2 max-w-xl">
        <Field id="pa-title" label="Title (English)"><TextInput id="pa-title" data-testid="pa-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field id="pa-title-te" label="Title (Telugu, optional)"><TextInput id="pa-title-te" data-testid="pa-title-te" value={titleTe} onChange={(e) => setTitleTe(e.target.value)} /></Field>
        <Field id="pa-intro" label="Short introduction (optional)"><TextInput id="pa-intro" data-testid="pa-intro" value={intro} maxLength={400} onChange={(e) => setIntro(e.target.value)} /></Field>
        <Field id="pa-opens" label="Start at (optional, within 30 days; empty means now)"><input id="pa-opens" data-testid="pa-opens" type="datetime-local" className={inputCls} value={opens} onChange={(e) => setOpens(e.target.value)} /></Field>
        <Field id="pa-closes" label="Auto-close (optional, 30 days max)"><input id="pa-closes" data-testid="pa-closes" type="datetime-local" className={inputCls} value={closes} onChange={(e) => setCloses(e.target.value)} /></Field>
        {qs.map((q, i) => (
          <fieldset key={i} className="border border-black p-3 space-y-2" data-testid={`pa-q-${i}`}>
            <legend className="font-bold text-sm px-1">Question {i + 1}</legend>
            <Field id={`pa-k-${i}`} label="Type">
              <select id={`pa-k-${i}`} data-testid={`pa-kind-${i}`} className={inputCls} value={q.kind} onChange={(e) => setQ(i, { kind: e.target.value as QDraft["kind"] })}>
                <option value="single">Choose one</option><option value="multi">Choose several</option><option value="scale5">Agree to disagree (5 points)</option>
              </select>
            </Field>
            <Field id={`pa-t-${i}`} label="Question (English)"><TextInput id={`pa-t-${i}`} data-testid={`pa-text-${i}`} value={q.text_en} maxLength={300} onChange={(e) => setQ(i, { text_en: e.target.value })} /></Field>
            <Field id={`pa-tt-${i}`} label="Question (Telugu, optional)"><TextInput id={`pa-tt-${i}`} data-testid={`pa-text-te-${i}`} value={q.text_te} onChange={(e) => setQ(i, { text_te: e.target.value })} /></Field>
            {q.kind === "multi" && (
              <Field id={`pa-m-${i}`} label="Maximum choices a person may pick (empty means no limit)">
                <input id={`pa-m-${i}`} data-testid={`pa-max-${i}`} type="number" min={1} max={6} inputMode="numeric" className={inputCls} value={q.max} onChange={(e) => setQ(i, { max: e.target.value })} />
              </Field>
            )}
            {q.kind !== "scale5" && (
              <Field id={`pa-o-${i}`} label="Options, one per line (Telugu after |)">
                <textarea id={`pa-o-${i}`} data-testid={`pa-options-${i}`} className={inputCls} rows={4} value={q.options} onChange={(e) => setQ(i, { options: e.target.value })} />
              </Field>
            )}
            {qs.length > 1 && <Btn secondary onClick={() => setQs((c) => c.filter((_, k) => k !== i))}>Remove question {i + 1}</Btn>}
          </fieldset>
        ))}
        {qs.length < 5 && <Btn secondary data-testid="pa-add-q" onClick={() => setQs((c) => [...c, blank()])}>Add a question</Btn>}
        <label className="flex items-start gap-3 min-h-[44px]"><input type="checkbox" data-testid="pa-confirm" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /><span className="text-sm">Block the app for {data ? data.registered_users : "all"} registered users until each answers.</span></label>
        <Btn data-testid="pa-publish" disabled={!confirm} onClick={publish}>Push poll to all users</Btn>
        <ErrorNote msg={err} />
        {msg && <p role="status" data-testid="pa-msg" className="text-sm font-bold">{msg}</p>}
      </div>
      <Gate state={state} onRetry={reload}>
        <h5 className="font-bold text-sm">Polls</h5>
        <ul className="space-y-1 text-sm" data-testid="pa-list">
          {(data?.polls ?? []).map((p) => (
            <li key={p.id} data-testid="pa-item" data-status={p.status} className="border border-black/40 p-2 flex flex-wrap items-center gap-2">
              <span className="font-bold">{p.title_en}</span><span>{p.status === "scheduled" ? `scheduled for ${new Date(p.opened_at).toLocaleString()}` : p.status}</span><span>{p.responses} answered</span>
              <Btn secondary data-testid="pa-results" onClick={async () => { setErr(null); try { setRes(await broadcastApi.adminResults(p.id)); } catch (e) { setErr((e as Error).message); } }}>Responses</Btn>
              {(p.status === "open" || p.status === "scheduled") && <Btn secondary data-testid="pa-close" onClick={async () => { setErr(null); try { await broadcastApi.adminClose(p.id); reload(); } catch (e) { setErr((e as Error).message); } }}>{p.status === "scheduled" ? "Cancel poll" : "Close poll"}</Btn>}
            </li>
          ))}
        </ul>
      </Gate>
      {res && (
        <div data-testid="pa-result-panel" className="border-2 border-black p-3 space-y-2">
          <h5 className="font-bold">{res.title_en}: {res.responses} answered</h5>
          <p className="text-sm">{res.note_en}</p>
          {res.suppressed ? <p data-testid="pa-suppressed" className="text-sm font-bold">Hidden until {res.min_results} answers.</p> : res.results.map((q, qi) => (
            <div key={qi}><p className="font-bold text-sm">{q.text_en}</p><ul className="text-sm list-disc pl-5">{q.options.map((o, oi) => <li key={oi}>{o.label_en}: {o.n}</li>)}</ul></div>
          ))}
          <Btn secondary onClick={() => setRes(null)}>Hide responses</Btn>
        </div>
      )}
    </section>
  );
}
