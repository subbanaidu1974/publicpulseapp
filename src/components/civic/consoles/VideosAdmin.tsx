import { useState } from "react";
import { videocastApi } from "../../../api/videocast";
import { Btn, ErrorNote, Field, TextInput, inputCls } from "../ui";
import { Gate, useGuarded } from "./shared";

const say = (e: unknown): string => (e as { body?: { message?: string } }).body?.message ?? (e as Error).message;

/**
 * Admin screen for video broadcasts (S-230): propose a video or audio item, a DIFFERENT admin approves it, then every signed-in member sees it in the Media tab.
 * English only (operator tool). The media is a link to a direct file; nothing is uploaded or copied here.
 */
export default function VideosAdmin() {
  const { data, state, reload } = useGuarded(() => videocastApi.adminList());
  const [f, setF] = useState({ title_en: "", title_te: "", note_en: "", note_te: "", media_url: "", credit: "", publish_at: "" });
  const [neutral, setNeutral] = useState(false), [rights, setRights] = useState(false);
  const [err, setErr] = useState<string | null>(null), [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((c) => ({ ...c, [k]: v }));

  const propose = async () => {
    setErr(null); setMsg(null);
    try {
      await videocastApi.adminCreate({ ...f, publish_at: f.publish_at ? new Date(f.publish_at).toISOString() : undefined, confirm_neutral: neutral, confirm_rights: rights });
      setMsg("Sent for approval. A different admin must approve it before any member sees it.");
      setF({ title_en: "", title_te: "", note_en: "", note_te: "", media_url: "", credit: "", publish_at: "" }); setNeutral(false); setRights(false); reload();
    } catch (e) { setErr(say(e)); }
  };
  const act = async (fn: () => Promise<unknown>, done: string) => { setErr(null); setMsg(null); try { await fn(); setMsg(done); reload(); } catch (e) { setErr(say(e)); } };

  return (
    <section data-testid="videos-admin" aria-labelledby="va-h" className="space-y-3">
      <h4 id="va-h" className="font-bold">Video broadcasts</h4>
      <p><a href="#/" data-testid="va-back" className="underline text-sm">Back to the app</a></p>
      <p className="text-sm">Every signed-in member sees an approved video as a card in the Media tab. It never blocks the app. A video you propose must be approved by a different admin.</p>
      <div className="space-y-2 max-w-xl">
        <Field id="va-title" label="Title (English)"><TextInput id="va-title" data-testid="va-title" value={f.title_en} maxLength={120} onChange={(e) => set("title_en", e.target.value)} /></Field>
        <Field id="va-title-te" label="Title (Telugu, optional)"><TextInput id="va-title-te" data-testid="va-title-te" value={f.title_te} maxLength={160} onChange={(e) => set("title_te", e.target.value)} /></Field>
        <Field id="va-note" label="Short note (optional)"><TextInput id="va-note" data-testid="va-note" value={f.note_en} maxLength={400} onChange={(e) => set("note_en", e.target.value)} /></Field>
        <Field id="va-note-te" label="Short note (Telugu, optional)"><TextInput id="va-note-te" data-testid="va-note-te" value={f.note_te} maxLength={600} onChange={(e) => set("note_te", e.target.value)} /></Field>
        <Field id="va-url" label="Address of the video or audio file (https, straight to an mp4, webm, mp3, m4a, ogg or wav file)"><TextInput id="va-url" data-testid="va-url" inputMode="url" value={f.media_url} maxLength={500} onChange={(e) => set("media_url", e.target.value)} /></Field>
        <Field id="va-credit" label="Credit line (who made it, and the licence or permission)"><TextInput id="va-credit" data-testid="va-credit" value={f.credit} maxLength={160} onChange={(e) => set("credit", e.target.value)} /></Field>
        <Field id="va-at" label="Start at (optional, within 30 days; empty means as soon as it is approved)"><input id="va-at" data-testid="va-at" type="datetime-local" className={inputCls} value={f.publish_at} onChange={(e) => set("publish_at", e.target.value)} /></Field>
        <label className="flex items-start gap-3 min-h-[44px]"><input type="checkbox" data-testid="va-neutral" checked={neutral} onChange={(e) => setNeutral(e.target.checked)} /><span className="text-sm">This video does not promote or attack a party or candidate, and does not ask anyone how to vote.</span></label>
        <label className="flex items-start gap-3 min-h-[44px]"><input type="checkbox" data-testid="va-rights" checked={rights} onChange={(e) => setRights(e.target.checked)} /><span className="text-sm">We made it, or we have the right to show it to {data ? data.registered_users : "all"} registered members.</span></label>
        <Btn data-testid="va-propose" disabled={!neutral || !rights} onClick={propose}>Send for approval</Btn>
        <ErrorNote msg={err} />
        {msg && <p role="status" data-testid="va-msg" className="text-sm font-bold">{msg}</p>}
      </div>
      <Gate state={state} onRetry={reload}>
        <h5 className="font-bold text-sm">Videos</h5>
        <ul className="space-y-1 text-sm" data-testid="va-list">
          {(data?.items ?? []).map((v) => (
            <li key={v.id} data-testid="va-item" data-status={v.status} className="border border-black/40 p-2 flex flex-wrap items-center gap-2">
              <span className="font-bold">{v.title_en}</span>
              <span data-testid="va-status">{v.status === "scheduled" && v.live_at ? `scheduled for ${new Date(v.live_at).toLocaleString()}` : v.status}</span>
              <span>{v.views === null ? `plays hidden under ${v.views_hidden_below}` : `${v.views} plays`}</span>
              {v.status === "pending" && (
                <>
                  <Btn data-testid="va-approve" disabled={v.mine} title={v.mine ? "A different admin must approve it" : undefined} onClick={() => act(() => videocastApi.adminApprove(v.id), "Approved. Members can see it now.")}>Approve</Btn>
                  <Btn secondary data-testid="va-reject" onClick={() => act(() => videocastApi.adminReject(v.id), "Refused.")}>{v.mine ? "Withdraw" : "Refuse"}</Btn>
                  {v.mine && <span className="text-xs">You proposed this; another admin must approve it.</span>}
                </>
              )}
              {(v.status === "live" || v.status === "scheduled") && <Btn secondary data-testid="va-recall" onClick={() => act(() => videocastApi.adminRecall(v.id), "Recalled. Members no longer see it.")}>Recall</Btn>}
            </li>
          ))}
        </ul>
      </Gate>
    </section>
  );
}
