import { useState } from "react";
import { issuesApi } from "../../../api/civic";
import { useCivicT, type CivicKey } from "../civicText";
import { Btn, ErrorNote, Field, TextInput, inputCls } from "../ui";
import { Gate, adminError, useGuarded } from "./shared";

const ROLES = ["officer", "moderator", "admin", "politician", "journalist", "eci_liaison", "geo_reviewer", "volunteer"];

/**
 * Role changes need two admins (S-140): one files a request with a TOTP code, a DIFFERENT admin approves with theirs, within 72 hours.
 * The server enforces all of it; this panel only collects the code (sent as x-totp-code, never kept) and explains the refusals.
 */
export default function RoleRequests({ me }: { me?: string }) {
  const c = useCivicT();
  const { data, state, reload } = useGuarded(() => issuesApi.roleRequests());
  const [action, setAction] = useState<"grant" | "revoke">("grant");
  const [person, setPerson] = useState("");
  const [role, setRole] = useState("officer");
  const [scope, setScope] = useState("");
  const [reason, setReason] = useState("");
  const [totp, setTotp] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const roleName = (r: string) => (r === "officer" || r === "moderator" || r === "admin" ? c(`c.cons.${r}` as CivicKey) : r);
  const run = async (fn: (m: { totp: string }) => Promise<unknown>, ok: CivicKey) => {
    setMsg(null); setErr(null);
    try { await fn({ totp: totp.trim() }); setMsg(c(ok)); reload(); } catch (e) { setErr(adminError(e, c)); } finally { setTotp(""); } // a code is single-use
  };
  const statusText = (s: string): string => (s === "approved" ? c("c.adm.approved") : s === "rejected" ? c("c.adm.rejected") : s === "expired" ? c("c.adm.expired") : c("c.adm.awaiting"));
  const needCode = totp.trim().length !== 6;
  return (
    <section data-testid="role-requests" aria-labelledby="rr-h" className="space-y-3">
      <h4 id="rr-h" className="font-bold">{c("c.adm.roles")}</h4>
      <p className="text-xs">{c("c.adm.rolesHelp")}</p>
      <Field id="rr-totp" label={c("c.adm.totp")}><TextInput id="rr-totp" data-testid="rr-totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} /></Field>
      <form className="space-y-2" data-testid="rr-form" onSubmit={(e) => { e.preventDefault(); void run(async (m) => { await issuesApi.requestRole({ action, personId: person.trim(), role, scope: scope.trim(), reason: reason.trim() }, m); setPerson(""); setScope(""); setReason(""); }, "c.adm.requested"); }}>
        <Field id="rr-action" label={c("c.adm.action")}>
          <select id="rr-action" data-testid="rr-action" className={inputCls} value={action} onChange={(e) => setAction(e.target.value as "grant" | "revoke")}><option value="grant">{c("c.adm.grant")}</option><option value="revoke">{c("c.adm.revoke")}</option></select>
        </Field>
        <Field id="rr-person" label={c("c.adm.person")}><TextInput id="rr-person" data-testid="rr-person" autoComplete="off" value={person} onChange={(e) => setPerson(e.target.value)} /></Field>
        <Field id="rr-role" label={c("c.adm.role")}>
          <select id="rr-role" data-testid="rr-role" className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{roleName(r)}</option>)}</select>
        </Field>
        <Field id="rr-scope" label={c("c.adm.scope")}><TextInput id="rr-scope" data-testid="rr-scope" value={scope} onChange={(e) => setScope(e.target.value)} /></Field>
        <Field id="rr-reason" label={c("c.adm.reason")}><TextInput id="rr-reason" data-testid="rr-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <button type="submit" data-testid="rr-submit" disabled={person.trim().length < 3 || reason.trim().length < 5 || needCode} className="min-h-[44px] px-4 border border-black bg-black text-white font-bold disabled:opacity-60">{c("c.adm.request")}</button>
      </form>
      <Gate state={state} onRetry={reload}>
        {data && data.length === 0 && <p className="text-sm">{c("c.cons.empty")}</p>}
        <ul className="space-y-2">
          {(data ?? []).map((r) => {
            const mine = !!me && r.requestedBy === me;
            return (
              <li key={r.id} data-testid="rr-item" className="border border-black p-2 text-sm space-y-1 break-words">
                <p><strong>{r.action === "revoke" ? c("c.adm.revoke") : c("c.adm.grant")} {roleName(r.role)}</strong>{r.scope ? ` @ ${r.scope}` : ""} - <span className="font-mono text-xs">{r.personId}</span></p>
                {r.reason && <p className="text-xs">{r.reason}</p>}
                <p data-testid="rr-status">{statusText(r.status)}{r.status === "pending" && r.expiresAt ? ` (${c("c.adm.expires")}: ${new Date(r.expiresAt).toLocaleString()})` : ""}</p>
                {r.status === "pending" && (
                  <div className="flex flex-wrap gap-2">
                    <Btn data-testid="rr-approve" disabled={mine || needCode} onClick={() => void run((m) => issuesApi.decideRole(r.id, "approve", m), "c.mod.decided")}>{c("c.adm.approve")}</Btn>
                    <Btn secondary data-testid="rr-reject" disabled={needCode} onClick={() => void run((m) => issuesApi.decideRole(r.id, "reject", m), "c.mod.decided")}>{mine ? c("c.adm.withdraw") : c("c.adm.reject")}</Btn>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Gate>
      {msg && <p role="status" data-testid="rr-msg">{msg}</p>}
      <ErrorNote msg={err} />
    </section>
  );
}
