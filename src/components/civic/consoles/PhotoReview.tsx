import { Fragment, useEffect, useState } from "react";
import { photoReviewApi, type PhotoSubmission } from "../../../api/civic";
import { useCivicT } from "../civicText";
import { Btn, ErrorNote, Field, TextInput, inputCls } from "../ui";
import { Gate, actionError, useGuarded } from "./shared";

const STATUSES = ["pending", "approved", "rejected"] as const;
type Status = (typeof STATUSES)[number];

/** The submitted image, fetched with the admin's sign-in (an <img> cannot send it) and released when the card goes away. */
function Preview({ id, alt }: { id: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true, made: string | null = null;
    photoReviewApi.imageObjectUrl(id).then((u) => { if (live) { made = u; setUrl(u); } else if (u) URL.revokeObjectURL(u); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [id]);
  return url ? <img src={url} alt={alt} className="w-28 h-auto border border-black object-cover" /> : <div className="w-28 h-28 border border-black/40" aria-hidden="true" />;
}

/**
 * Photo review (S-201): the queue of photos people sent for a constituency page (S-200). Nothing is shown to visitors until an admin approves it here.
 * The server is the only authority (admin sign-in); this panel only shows the queue and sends the decision.
 * There is NO automatic identity check: compare the claimed name with the winner, and use the contact to confirm, before approving.
 */
export default function PhotoReview() {
  const c = useCivicT();
  const [status, setStatus] = useState<Status>("pending");
  return (
    <section data-testid="photo-review" aria-labelledby="pr-h" className="space-y-3">
      <h4 id="pr-h" className="font-bold">{c("c.pr.title")}</h4>
      <p className="text-xs" data-testid="pr-warning">{c("c.pr.warning")}</p>
      <Field id="pr-status" label={c("c.pr.status")}>
        <select id="pr-status" data-testid="pr-status" className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
          {STATUSES.map((s) => <option key={s} value={s}>{c(`c.pr.s.${s}` as never)}</option>)}
        </select>
      </Field>
      <Fragment key={status}><Queue status={status} /></Fragment>
    </section>
  );
}

function Queue({ status }: { status: Status }) {
  const c = useCivicT();
  const { data, state, reload } = useGuarded(() => photoReviewApi.list(status));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (s: PhotoSubmission, d: "approved" | "rejected") => {
    setMsg(null); setErr(null);
    try { await photoReviewApi.decide(s.id, d, (notes[s.id] ?? "").trim()); setMsg(c(d === "approved" ? "c.pr.approvedMsg" : "c.pr.rejectedMsg")); reload(); }
    catch (e) { setErr(actionError(e, c)); }
  };
  return (
    <>
      <Gate state={state} onRetry={reload}>
        {data && data.length === 0 && <p className="text-sm" data-testid="pr-empty">{c("c.pr.empty")}</p>}
        <ul className="space-y-3">
          {(data ?? []).map((s) => (
            <li key={s.id} data-testid="pr-item" className="border border-black p-2 text-sm flex flex-wrap gap-3 break-words">
              <Preview id={s.id} alt={`${s.candidate}, ${s.state} #${s.ac_no}`} />
              <div className="space-y-1 min-w-[16rem] flex-1">
                <p><strong>{s.state} #{s.ac_no}</strong> - {c("c.pr.winner")}: <strong data-testid="pr-winner">{s.candidate}</strong> ({s.year})</p>
                <p>{c("c.pr.claims")}: <strong data-testid="pr-claimed">{s.claimed_name}</strong> ({s.relationship})</p>
                <p>{c("c.pr.credit")}: <span data-testid="pr-credit">{s.holder}</span></p>
                <p>{c("c.pr.contact")}: <span data-testid="pr-contact" className="font-mono text-xs">{s.contact ?? c("c.pr.noContact")}</span></p>
                <p className="text-xs">{new Date(s.created_at).toLocaleString()} - <span data-testid="pr-state">{c(`c.pr.s.${s.status}` as never)}</span>{s.note ? ` - ${s.note}` : ""}</p>
                {s.status === "pending" && (
                  <div className="space-y-2">
                    <Field id={`pr-note-${s.id}`} label={c("c.pr.note")}><TextInput id={`pr-note-${s.id}`} data-testid="pr-note" maxLength={500} value={notes[s.id] ?? ""} onChange={(e) => setNotes({ ...notes, [s.id]: e.target.value })} /></Field>
                    <div className="flex flex-wrap gap-2">
                      <Btn data-testid="pr-approve" onClick={() => void decide(s, "approved")}>{c("c.pr.approve")}</Btn>
                      <Btn secondary data-testid="pr-reject" onClick={() => void decide(s, "rejected")}>{c("c.pr.reject")}</Btn>
                    </div>
                  </div>
                )}
                {s.status === "approved" && <Btn secondary data-testid="pr-withdraw" onClick={() => void decide(s, "rejected")}>{c("c.pr.withdraw")}</Btn>}
              </div>
            </li>
          ))}
        </ul>
        {msg && <p role="status" data-testid="pr-msg">{msg}</p>}
        <ErrorNote msg={err} />
      </Gate>
    </>
  );
}
