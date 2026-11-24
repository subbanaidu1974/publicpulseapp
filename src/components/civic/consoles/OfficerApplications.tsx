import { useEffect, useState } from "react";
import { officersApi, type OfficerApplication } from "../../../api/civic";
import { useCivicT } from "../civicText";
import { Btn, ErrorNote, Field, TextInput } from "../ui";
import { Gate, adminError, useGuarded } from "./shared";

function LetterView({ id }: { id: string }) {
  const c = useCivicT();
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true, made: string | null = null;
    void officersApi.letterObjectUrl(id).then((u) => { made = u; if (live) setUrl(u); else if (u) URL.revokeObjectURL(u); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [id]);
  if (url === undefined) return <p role="status" className="text-sm">{c("c.loading")}</p>;
  return url ? <img data-testid="oq-letter" src={url} alt={c("c.offq.showLetter")} className="max-w-full h-auto border border-black" /> : <p role="alert" className="text-sm">{c("c.offq.noLetter")}</p>;
}

/**
 * Verification queue for officer applications (S-141). The e-mail domain check already passed on the server. The admin looks at the letter,
 * ticks that it matches, and sends the application on: that files an ordinary role request, which a DIFFERENT admin approves under
 * "Role changes". The TOTP code is sent as a header and never kept. The server enforces every rule; this panel only explains the refusals.
 */
export default function OfficerApplications() {
  const c = useCivicT();
  const { data, state, reload } = useGuarded(() => officersApi.queue("submitted"));
  const waiting = useGuarded(() => officersApi.queue("awaiting_second_admin"));
  const [shown, setShown] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [totp, setTotp] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: (m: { totp: string }) => Promise<unknown>, ok: "c.offq.verified" | "c.offq.rejected") => {
    setMsg(null); setErr(null);
    try { await fn({ totp: totp.trim() }); setMsg(c(ok)); reload(); waiting.reload(); }
    catch (e) { setErr(adminError(e, c)); }
    finally { setTotp(""); } // a code is single-use
  };
  const needCode = totp.trim().length !== 6;
  const row = (a: OfficerApplication, actions: boolean) => (
    <li key={a.id} data-testid="oq-item" className="border border-black p-2 text-sm space-y-2 break-words">
      <p><strong>{a.fullName}</strong>{a.designation ? `, ${a.designation}` : ""} - {a.department}{a.jurisdiction ? ` @ ${a.jurisdiction}` : ""}</p>
      <p className="text-xs">{a.officialEmail} - {c("c.offq.domainOk")} ({a.emailDomain}) - {c("c.offq.person")}: <span className="font-mono">{a.personId}</span></p>
      {!actions && <p data-testid="oq-awaiting">{c("c.offq.awaiting")}</p>}
      {actions && (
        <>
          <Btn secondary data-testid="oq-show" onClick={() => setShown(shown === a.id ? null : a.id)}>{shown === a.id ? c("c.offq.hideLetter") : c("c.offq.showLetter")}</Btn>
          {shown === a.id && <LetterView id={a.id} />}
          <label className="flex items-start gap-2"><input type="checkbox" data-testid="oq-checked" className="mt-1 w-5 h-5" checked={!!checked[a.id]} onChange={(e) => setChecked({ ...checked, [a.id]: e.target.checked })} /><span>{c("c.offq.checked")}</span></label>
          <Field id={`oq-note-${a.id}`} label={`${c("c.offq.note")} / ${c("c.offq.rejectWhy")}`}><TextInput id={`oq-note-${a.id}`} data-testid="oq-note" maxLength={300} value={note[a.id] ?? ""} onChange={(e) => setNote({ ...note, [a.id]: e.target.value })} /></Field>
          <div className="flex flex-wrap gap-2">
            <Btn data-testid="oq-verify" disabled={!checked[a.id] || needCode} onClick={() => void run((m) => officersApi.verify(a.id, note[a.id] ?? "", m), "c.offq.verified")}>{c("c.offq.verify")}</Btn>
            <Btn secondary data-testid="oq-reject" disabled={needCode || (note[a.id] ?? "").trim().length < 5} onClick={() => void run((m) => officersApi.reject(a.id, (note[a.id] ?? "").trim(), m), "c.offq.rejected")}>{c("c.offq.reject")}</Btn>
          </div>
        </>
      )}
    </li>
  );
  return (
    <section data-testid="officer-queue" aria-labelledby="oq-h" className="space-y-3">
      <h4 id="oq-h" className="font-bold">{c("c.offq.title")}</h4>
      <p className="text-xs">{c("c.offq.help")}</p>
      <Field id="oq-totp" label={c("c.adm.totp")}><TextInput id="oq-totp" data-testid="oq-totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} /></Field>
      <Gate state={state} onRetry={reload}>
        {data && data.length === 0 && (waiting.data?.length ?? 0) === 0 && <p className="text-sm">{c("c.offq.empty")}</p>}
        <ul className="space-y-2">{(data ?? []).map((a) => row(a, true))}{(waiting.data ?? []).map((a) => row(a, false))}</ul>
      </Gate>
      {msg && <p role="status" data-testid="oq-msg">{msg}</p>}
      <ErrorNote msg={err} />
    </section>
  );
}
