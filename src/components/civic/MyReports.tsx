import { useCallback, useEffect, useState } from "react";
import { issuesApi, type MyReport } from "../../api/civic";
import { useCategories } from "./categories";
import { useCivicT, type CivicKey } from "./civicText";
import IssueDetail from "./IssueDetail";
import { Btn } from "./ui";

const stat = (c: (k: CivicKey) => string, s: string) => (c(`c.issue.s.${s}` as CivicKey) as string | undefined) ?? s;

/**
 * S-157 "My reports": everything the signed-in person reported, including reports held for review or removed, with the state and whether an
 * appeal is possible. Opening one shows the owner detail (reason class, appeal state, appeal form). Only the caller's own reports come back.
 */
export default function MyReports({ refreshKey = 0 }: { refreshKey?: number }) {
  const c = useCivicT();
  const { label } = useCategories();
  const [rows, setRows] = useState<MyReport[] | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => { issuesApi.mine().then((r) => { setRows(r); setErr(false); }).catch(() => setErr(true)); }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  if (open) return <IssueDetail id={open} owner onBack={() => { setOpen(null); load(); }} onChanged={load} />;
  return (
    <section data-testid="my-reports" aria-labelledby="mr-h" className="space-y-3 max-w-md">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 id="mr-h" className="text-xl font-bold">{c("c.issue.mine")}</h2>
        <Btn secondary data-testid="my-reports-refresh" onClick={load}>{c("c.issue.mineRefresh")}</Btn>
      </div>
      <p className="text-sm">{c("c.issue.mineHelp")}</p>
      {err && <p role="alert" className="text-sm font-bold" data-testid="my-reports-error">{c("c.issue.mineLoadFail")}</p>}
      {rows && rows.length === 0 && !err && <p className="text-sm" data-testid="my-reports-none">{c("c.issue.mineNone")}</p>}
      <ul className="space-y-2">
        {(rows ?? []).map((r) => (
          <li key={r.id} data-testid="my-report-row" data-moderation={r.moderation} className="border border-black p-3 space-y-1 break-words">
            <p className="font-bold">{label(r.category)}</p>
            {r.snippet && <p className="text-sm">{r.snippet}</p>}
            <p className="text-sm"><span data-testid="my-report-status">{stat(c, r.status)}</span>
              {r.moderation !== "ok" && <span data-testid="my-report-state"> - {c(r.moderation === "held" ? "c.issue.heldTitle" : "c.issue.takenDownTitle")}</span>}
              {r.appeal?.status === "pending" && <span data-testid="my-report-appeal"> - {c("c.issue.appealPending")}</span>}
            </p>
            <Btn secondary data-testid="my-report-open" onClick={() => setOpen(r.id)}>{c("c.issue.mineOpen")}</Btn>
          </li>
        ))}
      </ul>
    </section>
  );
}
