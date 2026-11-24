import { useState } from "react";
import { assistedApi } from "../../../api/civic";
import { useT } from "../../../i18n";
import { useCivicT } from "../civicText";
import { Btn, ErrorNote, Field, TextInput } from "../ui";
import { Gate, actionError, errCode, pct, useGuarded } from "./shared";

/** Warnings for reviewers and coordinators: a pair's not-confirmed rate and the assisted share of an area's reports. They inform; they never act. */
export function AlertsPanel() {
  const c = useCivicT();
  const { lang } = useT();
  const { data, state, reload } = useGuarded(() => assistedApi.alerts());
  return (
    <section data-testid="assisted-alerts" aria-labelledby="asal-h" className="space-y-2">
      <h4 id="asal-h" className="font-bold">{c("c.as.alTitle")}</h4>
      <Gate state={state} onRetry={reload}>
        {data && data.alerts.length === 0 && <p className="text-sm">{c("c.as.alNone")}</p>}
        <ul className="space-y-1">
          {(data?.alerts ?? []).map((a, i) => (
            <li key={i} data-testid="assisted-alert" role="alert" className="border-2 border-black p-2 text-sm">
              <strong>{c(a.kind === "unconfirmed_rate" ? "c.as.alUnconfirmed" : "c.as.alShare")}</strong>
              {a.unit ? `: ${(lang === "te" ? a.unit.name_te : null) ?? a.unit.name_en}` : ""} {pct(a.rate)} ({a.sample})
            </li>
          ))}
        </ul>
      </Gate>
    </section>
  );
}

/** Pause or resume assisted recording for a village, mandal or district in the coordinator's or reviewer's area. */
export function AreaHoldPanel() {
  const c = useCivicT();
  const { data, state, reload } = useGuarded(() => assistedApi.areaHolds());
  const [unit, setUnit] = useState(""); const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const go = async (hold: boolean) => {
    setMsg(null); setErr(null);
    try { await assistedApi.holdArea(unit.trim(), hold, reason.trim()); setMsg(c("c.as.holdDone")); reload(); } catch (e) { setErr(errCode(e) === "outside_scope" ? c("c.as.coErrScope") : actionError(e, c)); }
  };
  return (
    <section data-testid="assisted-hold" aria-labelledby="ash-h" className="space-y-2 border border-black p-3">
      <h4 id="ash-h" className="font-bold">{c("c.as.holdTitle")}</h4>
      <Field id="ash-u" label={c("c.as.holdUnit")}><TextInput id="ash-u" data-testid="ash-unit" value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
      <Field id="ash-r" label={c("c.as.holdReason")}><TextInput id="ash-r" data-testid="ash-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="flex gap-2 flex-wrap">
        <Btn data-testid="ash-on" disabled={!unit.trim() || reason.trim().length < 5} onClick={() => void go(true)}>{c("c.as.holdOn")}</Btn>
        <Btn secondary data-testid="ash-off" disabled={!unit.trim() || reason.trim().length < 5} onClick={() => void go(false)}>{c("c.as.holdOff")}</Btn>
      </div>
      {msg && <p role="status" data-testid="ash-msg">{msg}</p>}
      <ErrorNote msg={err} />
      <Gate state={state} onRetry={reload}>
        {data && data.length > 0 && <div><p className="font-bold text-sm">{c("c.as.holdList")}</p><ul className="text-sm">{data.map((h) => <li key={h.unit} data-testid="ash-held">{h.unit}: {h.reason}</li>)}</ul></div>}
      </Gate>
    </section>
  );
}

/** A person who lost the receipt: pick the record in their presence, ask for deletion; a different person in scope approves. */
export function DeletionPanel({ pairs }: { pairs: { id: string; label: string | null }[] }) {
  const c = useCivicT();
  const [pair, setPair] = useState("");
  const [records, setRecords] = useState<{ recordId: string; category: string; snippet: string | null; deleted: boolean }[]>([]);
  const [reason, setReason] = useState<Record<string, string>>({});
  const queue = useGuarded(() => assistedApi.deletionRequests());
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = async () => { setErr(null); try { setRecords(await assistedApi.pairRecords(pair)); } catch (e) { setErr(actionError(e, c)); } };
  const ask = async (id: string) => { setMsg(null); setErr(null); try { await assistedApi.requestDeletion(id, reason[id] ?? ""); setMsg(c("c.as.delSent")); queue.reload(); } catch (e) { setErr(actionError(e, c)); } };
  const decide = async (id: string, ok: boolean) => { setMsg(null); setErr(null); try { await assistedApi.decideDeletion(id, ok); setMsg(c("c.as.delDone")); queue.reload(); } catch (e) { setErr(actionError(e, c)); } };
  return (
    <section data-testid="assisted-deletion" aria-labelledby="asd-h" className="space-y-2 border border-black p-3">
      <h4 id="asd-h" className="font-bold">{c("c.as.delTitle")}</h4>
      <p className="text-xs">{c("c.as.delHelp")}</p>
      <div className="flex gap-2 flex-wrap items-end">
        <select aria-label={c("c.as.delRecords")} data-testid="asd-pair" className="min-h-[44px] border border-black bg-white px-2" value={pair} onChange={(e) => setPair(e.target.value)}>
          <option value="">-</option>{pairs.map((p) => <option key={p.id} value={p.id}>{p.label ?? p.id.slice(0, 8)}</option>)}
        </select>
        <Btn secondary data-testid="asd-load" disabled={!pair} onClick={() => void load()}>{c("c.as.delRecords")}</Btn>
      </div>
      <ul className="space-y-2">
        {records.filter((r) => !r.deleted).map((r) => (
          <li key={r.recordId} data-testid="asd-record" className="border border-black p-2 text-sm space-y-1 break-words">
            <p>{r.snippet}</p>
            <Field id={`asd-r-${r.recordId}`} label={c("c.as.delReason")}><TextInput id={`asd-r-${r.recordId}`} data-testid="asd-reason" maxLength={300} value={reason[r.recordId] ?? ""} onChange={(e) => setReason({ ...reason, [r.recordId]: e.target.value })} /></Field>
            <Btn secondary data-testid="asd-ask" disabled={(reason[r.recordId] ?? "").trim().length < 5} onClick={() => void ask(r.recordId)}>{c("c.as.delAsk")}</Btn>
          </li>
        ))}
      </ul>
      {msg && <p role="status" data-testid="asd-msg">{msg}</p>}
      <ErrorNote msg={err} />
      <p className="font-bold text-sm">{c("c.as.delQueue")}</p>
      <Gate state={queue.state} onRetry={queue.reload}>
        <ul className="space-y-2">
          {(queue.data ?? []).map((r) => (
            <li key={r.id} data-testid="asd-request" className="border border-black p-2 text-sm space-y-1 break-words">
              <p>{r.reason}</p>
              {r.mine ? <p className="text-xs">{c("c.as.delOwn")}</p> : (
                <div className="flex gap-2 flex-wrap">
                  <Btn data-testid="asd-approve" onClick={() => void decide(r.id, true)}>{c("c.as.delApprove")}</Btn>
                  <Btn secondary data-testid="asd-reject" onClick={() => void decide(r.id, false)}>{c("c.as.delReject")}</Btn>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Gate>
    </section>
  );
}
