import { useState } from "react";
import { issuesApi, type OfficerItem } from "../../../api/civic";
import { useT } from "../../../i18n";
import { useCategories } from "../categories";
import { useCivicT, type CivicKey } from "../civicText";
import { statusLabel } from "../IssueFeed";
import { Btn, ErrorNote, inputCls } from "../ui";
import { Gate, actionError, useGuarded } from "./shared";

/** Allowed moves are a hint only; the server (S-24 workflow) validates the transition, department and jurisdiction. */
const NEXT: Record<string, string[]> = { Reported: ["Verified"], Verified: ["Assigned"], Assigned: ["InProgress", "Resolved"], InProgress: ["Resolved"], Reopened: ["Assigned"] };
const FALLBACK_DEPARTMENTS = ["Rural Water Supply", "Roads and Buildings", "Energy", "Health", "School Education", "Agriculture and Irrigation", "Social Welfare", "Police", "General Administration"];

function Editor({ issue, departments, onDone }: { issue: OfficerItem; departments: string[]; onDone: () => void }) {
  const c = useCivicT();
  const next = NEXT[issue.status] ?? [];
  const [pick, setTo] = useState(next[0] ?? "");
  const to = next.includes(pick) ? pick : next[0] ?? ""; // the list reloads after a move, so the offered moves change under the form
  const [note, setNote] = useState("");
  const [dep, setDep] = useState(departments[0]);
  const [reply, setReply] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: CivicKey) => {
    setMsg(null); setErr(null);
    try { await fn(); setMsg(c(ok)); onDone(); } catch (e) { setErr(actionError(e, c, "c.cons.outOfJur")); }
  };
  return (
    <div data-testid="officer-editor" className="border border-black p-3 space-y-3 text-sm">
      {next.length > 0 && (
        <div className="space-y-1">
          <label htmlFor="oc-to" className="block font-bold">{c("c.cons.moveTo")}</label>
          <select id="oc-to" data-testid="oc-to" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)}>{next.map((s) => <option key={s} value={s}>{statusLabel(c, s)}</option>)}</select>
          <label htmlFor="oc-note" className="block font-bold">{c("c.cons.note")}</label>
          <input id="oc-note" data-testid="oc-note" className={inputCls} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          <Btn data-testid="oc-apply" onClick={() => void run(() => issuesApi.transition(issue.id, { to, note: note || undefined }), "c.cons.applied")}>{c("c.cons.apply")}</Btn>
        </div>
      )}
      <div className="space-y-1">
        <label htmlFor="oc-dep" className="block font-bold">{c("c.cons.reroute")}: {c("c.cons.rerouteTo")}</label>
        <select id="oc-dep" data-testid="oc-dep" className={inputCls} value={dep} onChange={(e) => setDep(e.target.value)}>{departments.map((d) => <option key={d}>{d}</option>)}</select>
        <Btn secondary data-testid="oc-reroute" onClick={() => void run(() => issuesApi.transition(issue.id, { action: "out_of_jurisdiction", department: dep }), "c.cons.rerouted")}>{c("c.cons.reroute")}</Btn>
      </div>
      <div className="space-y-1">
        <label htmlFor="oc-reply" className="block font-bold">{c("c.cons.rebuttal")}</label>
        <textarea id="oc-reply" data-testid="oc-reply" className={inputCls} rows={3} maxLength={2000} value={reply} onChange={(e) => setReply(e.target.value)} />
        <Btn data-testid="oc-post-reply" disabled={!reply.trim()} onClick={() => void run(async () => { await issuesApi.rebuttal(issue.id, reply.trim()); setReply(""); }, "c.cons.rebuttalSent")}>{c("c.cons.postRebuttal")}</Btn>
      </div>
      {msg && <p role="status" data-testid="oc-msg">{msg}</p>}
      <ErrorNote msg={err} />
    </div>
  );
}

/** Officer console (S-140): GET /issues/officer/queue (open issues in your department and area), status change, reroute, public reply. Every action is authorised by the server. */
export default function OfficerConsole() {
  const c = useCivicT();
  const { lang } = useT();
  const { cats, label } = useCategories();
  const { data, state, reload } = useGuarded(() => issuesApi.officerQueue(100));
  const [sel, setSel] = useState<string | null>(null);
  const departments = [...new Set(cats.map((k) => k.department).filter((d): d is string => !!d))];
  const deps = departments.length ? departments : FALLBACK_DEPARTMENTS;
  const text = (i: OfficerItem) => (lang === "te" ? i.textTe ?? i.text : i.text ?? i.textTe);
  return (
    <section data-testid="officer-console" aria-labelledby="oc-h" className="space-y-3">
      <h3 id="oc-h" className="text-lg font-bold">{c("c.cons.officerTitle")}</h3>
      <p className="text-xs">{c("c.cons.officerHelp")}</p>
      <Gate state={state} onRetry={reload}>
        {data && <p className="text-xs" data-testid="officer-scope">{c("c.cons.scope")}: {data.role.department ?? c("c.cons.anyDept")}{data.role.jurisdictionLgd ? ` @ ${data.role.jurisdictionLgd}` : ""}</p>}
        {data && data.items.length === 0 && <p className="text-sm">{c("c.cons.empty")}</p>}
        <ul className="space-y-2">
          {(data?.items ?? []).map((i) => (
            <li key={i.id} data-testid="officer-item" className="border border-black p-2 text-sm space-y-2 break-words">
              <p><strong>{label(i.category)}</strong> ({statusLabel(c, i.status)}){i.overdue ? <strong data-testid="officer-overdue" className="text-red-800"> {c("c.cons.overdue")}</strong> : null}</p>
              {text(i) && <p>{text(i)}</p>}
              {i.slaDue && <p className="text-xs">{c("c.cons.slaDue")}: {new Date(i.slaDue).toLocaleString(lang === "te" ? "te-IN" : "en-IN", { dateStyle: "medium", timeStyle: "short" })}</p>}
              <Btn secondary aria-expanded={sel === i.id} onClick={() => setSel(sel === i.id ? null : i.id)} data-testid="officer-manage">{c("c.cons.apply")}</Btn>
              {sel === i.id && <Editor issue={i} departments={deps} onDone={reload} />}
            </li>
          ))}
        </ul>
      </Gate>
    </section>
  );
}
