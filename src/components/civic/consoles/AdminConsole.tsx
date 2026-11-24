import { useState } from "react";
import { issuesApi } from "../../../api/civic";
import { useCivicT } from "../civicText";
import { Btn, ErrorNote, Field, TextInput } from "../ui";
import JobsStatus from "./JobsStatus";
import OfficerApplications from "./OfficerApplications";
import RoleRequests from "./RoleRequests";
import { Gate, actionError, useGuarded } from "./shared";

/** TOTP enrolment. The secret and the recovery codes are shown once: the codes stay on screen with a "save these now" notice until dismissed. */
function MfaPanel() {
  const c = useCivicT();
  const { data, state, reload } = useGuarded(() => issuesApi.me());
  const [secret, setSecret] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const confirmed = !!data?.mfa?.confirmed;
  return (
    <section data-testid="mfa-panel" aria-labelledby="mfa-h" className="space-y-2">
      <h4 id="mfa-h" className="font-bold">{c("c.adm.mfa")}</h4>
      <Gate state={state} onRetry={reload}>
        <p className="text-sm" data-testid="mfa-state">{confirmed ? c("c.adm.mfaOn") : c("c.adm.mfaOff")}{confirmed && data?.mfa?.recoveryCodesLeft !== undefined ? ` ${c("c.adm.recoveryLeft")}: ${data.mfa.recoveryCodesLeft}` : ""}</p>
        {!secret && !confirmed && <Btn secondary data-testid="mfa-start" onClick={async () => { setErr(null); try { const r = await issuesApi.mfaEnrol(); setSecret(r.secret); setCodes(r.recoveryCodes); } catch (e) { setErr(actionError(e, c)); } }}>{c("c.adm.mfaStart")}</Btn>}
        {secret && <p className="text-sm break-all">{c("c.adm.mfaSecret")}: <code data-testid="mfa-secret" className="font-mono">{secret}</code></p>}
        {codes.length > 0 && (
          <div role="group" aria-labelledby="mfa-rec-h" data-testid="mfa-recovery" className="border-2 border-black p-3 space-y-2">
            <p id="mfa-rec-h" className="font-bold">{c("c.adm.recoveryTitle")}</p>
            <p className="text-sm">{c("c.adm.recoveryWarn")}</p>
            <ul className="font-mono text-sm grid grid-cols-2 gap-1">{codes.map((k) => <li key={k} data-testid="mfa-recovery-code">{k}</li>)}</ul>
            <Btn secondary data-testid="mfa-recovery-saved" onClick={() => { setCodes([]); setSecret(null); }}>{c("c.adm.recoverySaved")}</Btn>
          </div>
        )}
        {(secret || confirmed) && (
          <form className="space-y-2" onSubmit={async (e) => { e.preventDefault(); setErr(null); setMsg(null); try { await issuesApi.mfaVerify(code.trim()); setMsg(c("c.adm.mfaDone")); setCode(""); reload(); } catch (x) { const st = (x as { status?: number }).status; setErr(st === 400 || st === 403 ? c("c.adm.mfaBad") : actionError(x, c)); } }}>
            <Field id="mfa-code" label={c("c.adm.mfaCode")}><TextInput id="mfa-code" data-testid="mfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></Field>
            <button type="submit" data-testid="mfa-verify" disabled={code.length !== 6} className="min-h-[44px] px-4 border border-black bg-black text-white font-bold disabled:opacity-60">{c("c.adm.mfaVerify")}</button>
          </form>
        )}
        {msg && <p role="status" data-testid="mfa-msg">{msg}</p>}
        <ErrorNote msg={err} />
      </Gate>
    </section>
  );
}

export default function AdminConsole({ personId }: { personId?: string }) {
  const c = useCivicT();
  return (
    <section data-testid="admin-console" aria-labelledby="ac-h" className="space-y-6">
      <h3 id="ac-h" className="text-lg font-bold">{c("c.adm.title")}</h3>
      <MfaPanel />
      <OfficerApplications />
      <RoleRequests me={personId} />
      <JobsStatus />
    </section>
  );
}
