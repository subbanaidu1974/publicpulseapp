import { useState } from "react";
import { issuesApi, type AuditVerify } from "../../../api/civic";
import { useCivicT } from "../civicText";
import { Btn } from "../ui";
import { Gate, useGuarded } from "./shared";

/** Background jobs (GET /ops/jobs, admin) and the public audit log: head, anchor state and a verify check whose 409 is shown as an alarm. */
export default function JobsStatus() {
  const c = useCivicT();
  const jobs = useGuarded(() => issuesApi.jobs());
  const head = useGuarded(() => issuesApi.auditHead());
  // Verify only on request: GET /audit/verify is the expensive, tightly rate-limited public check (6 per minute per address).
  const [verify, setVerify] = useState<{ state: "idle" | "busy" | "ok" | "fail"; data?: AuditVerify }>({ state: "idle" });
  const runVerify = async () => { setVerify({ state: "busy" }); try { setVerify({ state: "ok", data: await issuesApi.auditVerify() }); } catch { setVerify({ state: "fail" }); } };
  const h = head.data;
  return (
    <section data-testid="jobs-status" aria-labelledby="js-h" className="space-y-3">
      <h4 id="js-h" className="font-bold">{c("c.adm.jobs")}</h4>
      <Btn secondary onClick={() => { jobs.reload(); head.reload(); }}>{c("c.cons.refresh")}</Btn>
      <Gate state={jobs.state} onRetry={jobs.reload}>
        {jobs.data?.alarm && <p role="alert" data-testid="jobs-alarm" className="text-red-800 font-bold text-sm">{c("c.adm.jobAlarm")}: {jobs.data.alarm}</p>}
        <ul className="space-y-2">
          {(jobs.data?.jobs ?? []).map((j) => (
            <li key={j.name} data-testid="job-row" className="border border-black p-2 text-sm break-words">
              <strong>{j.name}</strong> - {j.lastOk === null ? c("c.adm.never") : j.lastOk ? c("c.adm.ok") : c("c.adm.failed")}
              <span className="block text-xs">{j.runs} {c("c.adm.runs")}, {j.failures} {c("c.adm.failures")}; {c("c.adm.lastRun")}: {j.lastRunAt ?? c("c.adm.never")}{j.lastError ? ` (${j.lastError})` : ""}</span>
            </li>
          ))}
        </ul>
      </Gate>
      <div data-testid="audit-head" className="text-sm space-y-1">
        <p className="font-bold">{c("c.adm.audit")}</p>
        {head.state === "ok" && h && (
          <>
            <p className="break-all font-mono text-xs">{c("c.adm.auditHash")}: {h.hash} ({c("c.adm.auditCount")}: {h.count})</p>
            <p className="text-xs">{h.anchorConfigured ? `${c("c.adm.auditAnchor")}: ${h.anchorSink ?? ""}` : c("c.adm.auditNoAnchor")}{h.unanchored > 0 ? `; ${h.unanchored} ${c("c.adm.auditUnanchored")}` : ""}</p>
          </>
        )}
        {head.state === "ok" && !h && <p className="text-xs">{c("c.adm.auditEmpty")}</p>}
        {head.state === "fail" && <p className="text-xs" role="alert">{c("c.cons.fail")}</p>}
        {verify.state === "ok" && verify.data && (verify.data.ok
          ? <p role="status" data-testid="audit-verify-ok" className="text-xs">{c("c.adm.auditOk")}</p>
          : <p role="alert" data-testid="audit-alarm" className="text-red-800 font-bold">{c("c.adm.auditBad")}</p>)}
        {verify.state === "fail" && <p role="alert" className="text-xs">{c("c.cons.fail")}</p>}
        <Btn secondary data-testid="audit-verify" disabled={verify.state === "busy"} onClick={() => void runVerify()}>{c("c.adm.auditVerify")}</Btn>
      </div>
    </section>
  );
}
