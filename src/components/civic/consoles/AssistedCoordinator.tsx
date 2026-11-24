import { useState } from "react";
import { CivicApiError, assistedApi } from "../../../api/civic";
import { useT } from "../../../i18n";
import { useCivicT } from "../civicText";
import { Btn, ErrorNote, Field, TextInput } from "../ui";
import { Gate, actionError, errCode, pct, useGuarded } from "./shared";
import { AlertsPanel, AreaHoldPanel, DeletionPanel } from "./AssistedExtras";

/** Coordinator console (S-49): form and suspend assistant pairs. Pairs are never self-formed; the server checks the coordinator's area. Members are never named. */
export default function AssistedCoordinator() {
  const c = useCivicT();
  const { lang } = useT();
  const { data, state, reload } = useGuarded(() => assistedApi.pairs());
  const [village, setVillage] = useState(""); const [m1, setM1] = useState(""); const [m2, setM2] = useState(""); const [label, setLabel] = useState("");
  const [reason, setReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setMsg(null); setErr(null);
    try { await assistedApi.createPair({ village_lgd: village.trim(), member_a: m1.trim(), member_b: m2.trim(), label: label.trim() || undefined }); setMsg(c("c.as.coCreated")); setM1(""); setM2(""); reload(); }
    catch (e) {
      const code = e instanceof CivicApiError ? errCode(e) : "";
      setErr(code === "outside_scope" ? c("c.as.coErrScope") : ["not_a_volunteer", "already_paired", "volunteer_not_found", "two_assistants_required"].includes(code) ? c("c.as.coErrVol") : e instanceof CivicApiError && e.status === 401 ? actionError(e, c) : c("c.as.coErrGeneric"));
    }
  };
  const reinstate = async (id: string) => {
    setMsg(null); setErr(null);
    try { await assistedApi.reinstatePair(id, reason[id] ?? ""); setMsg(c("c.as.reinstated")); reload(); }
    catch (e) { setErr(errCode(e) === "auto_suspended_needs_dual_control" ? c("c.as.autoNeedsTwo") : actionError(e, c)); }
  };
  const suspend = async (id: string) => {
    setMsg(null); setErr(null);
    try { await assistedApi.suspendPair(id, reason[id] ?? ""); setMsg(c("c.as.coSuspended")); reload(); } catch (e) { setErr(actionError(e, c)); }
  };
  return (
    <section data-testid="assisted-coordinator" aria-labelledby="asco-h" className="space-y-3">
      <h3 id="asco-h" className="text-lg font-bold">{c("c.as.coTitle")}</h3>
      <p className="text-xs">{c("c.as.coHelp")}</p>
      <div className="border border-black p-3 space-y-2">
        <Field id="asco-v" label={c("c.as.coVillage")}><TextInput id="asco-v" data-testid="asco-village" value={village} onChange={(e) => setVillage(e.target.value)} /></Field>
        <Field id="asco-a" label={c("c.as.coA")}><TextInput id="asco-a" data-testid="asco-a" autoComplete="off" value={m1} onChange={(e) => setM1(e.target.value)} /></Field>
        <Field id="asco-b" label={c("c.as.coB")}><TextInput id="asco-b" data-testid="asco-b" autoComplete="off" value={m2} onChange={(e) => setM2(e.target.value)} /></Field>
        <Field id="asco-l" label={c("c.as.coLabel")}><TextInput id="asco-l" data-testid="asco-label" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <Btn data-testid="asco-create" disabled={!village.trim() || !m1.trim() || !m2.trim()} onClick={() => void create()}>{c("c.as.coCreate")}</Btn>
      </div>
      {msg && <p role="status" data-testid="asco-msg">{msg}</p>}
      <ErrorNote msg={err} />
      <Gate state={state} onRetry={reload}>
        {data && data.length === 0 && <p className="text-sm">{c("c.as.coEmpty")}</p>}
        <ul className="space-y-2">
          {(data ?? []).map((p) => (
            <li key={p.id} data-testid="asco-pair" className="border border-black p-2 text-sm space-y-1 break-words">
              <p><strong>{(lang === "te" ? p.village.name_te : null) ?? p.village.name_en}</strong>{p.label ? ` - ${p.label}` : ""} ({c("c.as.coStatus")}: <span data-testid="asco-status">{p.status}</span>)</p>
              <p className="text-xs">{c("c.as.coRecords")}: {p.records}. {c("c.as.coChecked")}: {p.checked}. {c("c.as.coNot")}: {p.notConfirmed} ({pct(p.notConfirmedRate ?? undefined)}). {c("c.as.coQueued")}: {p.queued}.</p>
              {p.status === "active" ? (
                <div className="flex gap-2 flex-wrap items-end">
                  <div className="flex-1 min-w-[10rem]"><Field id={`asco-r-${p.id}`} label={c("c.as.coReason")}><TextInput id={`asco-r-${p.id}`} data-testid="asco-reason" maxLength={300} value={reason[p.id] ?? ""} onChange={(e) => setReason({ ...reason, [p.id]: e.target.value })} /></Field></div>
                  <Btn secondary data-testid="asco-suspend" disabled={(reason[p.id] ?? "").trim().length < 5} onClick={() => void suspend(p.id)}>{c("c.as.coSuspend")}</Btn>
                </div>
              ) : (
                <div className="space-y-1">
                  {p.suspendedReason && <p className="text-xs">{p.suspendedReason}</p>}
                  <Field id={`asco-r-${p.id}`} label={c("c.as.coReason")}><TextInput id={`asco-r-${p.id}`} data-testid="asco-reason" maxLength={300} value={reason[p.id] ?? ""} onChange={(e) => setReason({ ...reason, [p.id]: e.target.value })} /></Field>
                  <Btn secondary data-testid="asco-reinstate" disabled={(reason[p.id] ?? "").trim().length < 5} onClick={() => void reinstate(p.id)}>{c("c.as.reinstate")}</Btn>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Gate>
      <AlertsPanel />
      <AreaHoldPanel />
      <DeletionPanel pairs={(data ?? []).map((p) => ({ id: p.id, label: p.label }))} />
    </section>
  );
}
