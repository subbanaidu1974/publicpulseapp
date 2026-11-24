import { Fragment, useState } from "react";
import { assistedApi, type AssistedRecheck } from "../../../api/civic";
import { useT } from "../../../i18n";
import { useCategories } from "../categories";
import { useCivicT } from "../civicText";
import { Btn, ErrorNote, Field, TextInput } from "../ui";
import { Gate, actionError, useGuarded } from "./shared";
import { AlertsPanel, AreaHoldPanel } from "./AssistedExtras";

function Item({ r, onDone }: { r: AssistedRecheck; onDone: (suspended: boolean) => void }) {
  const c = useCivicT();
  const { lang } = useT();
  const { label } = useCategories();
  const [note, setNote] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const send = async (outcome: "confirmed" | "not_confirmed" | "unreachable") => {
    setErr(null); setBusy(true);
    try { const out = await assistedApi.submitRecheck(r.recordId, outcome, note.trim() || undefined); onDone(out.pair_suspended === true); }
    catch (e) { setErr(actionError(e, c, "c.cons.403")); } finally { setBusy(false); }
  };
  const text = lang === "te" ? r.textTe ?? r.textEn : r.textEn ?? r.textTe;
  return (
    <li data-testid="asrv-item" className="border border-black p-2 text-sm space-y-2 break-words">
      <p><strong>{label(r.category)}</strong>, {(lang === "te" ? r.village?.name_te : null) ?? r.village?.name_en}
        {r.flagged && <strong data-testid="asrv-flagged"> {c("c.as.rvFlagged")}</strong>}{r.overdue && <strong className="text-red-800"> {c("c.as.rvOverdue")}</strong>}
        {r.dueBy && <span className="text-xs"> {c("c.as.rvDue")}: {new Date(r.dueBy).toLocaleDateString(lang === "te" ? "te-IN" : "en-IN")}</span>}</p>
      {text && <p data-testid="asrv-text">{text}</p>}
      <Field id={`asrv-n-${r.recordId}`} label={c("c.as.rvNote")}><TextInput id={`asrv-n-${r.recordId}`} data-testid="asrv-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="flex gap-2 flex-wrap">
        <Btn data-testid="asrv-confirmed" disabled={busy} onClick={() => void send("confirmed")}>{c("c.as.rvConfirmed")}</Btn>
        <Btn secondary data-testid="asrv-not" disabled={busy} onClick={() => void send("not_confirmed")}>{c("c.as.rvNot")}</Btn>
        <Btn secondary data-testid="asrv-unreachable" disabled={busy} onClick={() => void send("unreachable")}>{c("c.as.rvUnreachable")}</Btn>
      </div>
      <ErrorNote msg={err} />
    </li>
  );
}

/** Reviewer console (S-49): the re-check queue. The reviewer records only the outcome; the report text cannot be edited here. */
export default function AssistedReviewer() {
  const c = useCivicT();
  const { data, state, reload } = useGuarded(() => assistedApi.rechecks());
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <section data-testid="assisted-reviewer" aria-labelledby="asrv-h" className="space-y-3">
      <h3 id="asrv-h" className="text-lg font-bold">{c("c.as.rvTitle")}</h3>
      <p className="text-xs">{c("c.as.rvHelp")}</p>
      {msg && <p role="status" data-testid="asrv-msg">{msg}</p>}
      <Gate state={state} onRetry={reload}>
        {data && data.length === 0 && <p className="text-sm" data-testid="asrv-empty">{c("c.as.rvEmpty")}</p>}
        <ul className="space-y-2">{(data ?? []).map((r) => <Fragment key={r.recordId}><Item r={r} onDone={(sus) => { setMsg(c("c.as.rvLogged") + (sus ? " " + c("c.as.rvSuspended") : "")); reload(); }} /></Fragment>)}</ul>
      </Gate>
      <AlertsPanel />
      <AreaHoldPanel />
    </section>
  );
}
