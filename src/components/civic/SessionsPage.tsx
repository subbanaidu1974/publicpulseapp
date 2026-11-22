import { useCallback, useEffect, useState } from "react";
import { civicIdentityApi, type SessionRow } from "../../api/civic";
import { useCivicT } from "./civicText";
import { Btn } from "./ui";

/** Lists where the person is signed in and lets them sign out other places. Hidden when the server has no sessions route yet. */
export default function SessionsPage() {
  const c = useCivicT();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    civicIdentityApi.listSessions().then((r) => { setRows(r); setMissing(false); }).catch(() => setMissing(true));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (missing) return null;
  if (!rows) return null;
  return (
    <section data-testid="sessions-page" aria-labelledby="sess-title" className="space-y-3 max-w-md">
      <h2 id="sess-title" className="text-xl font-bold">{c("c.login.sessTitle")}</h2>
      {rows.length === 0 && <p className="text-sm">{c("c.login.sessNone")}</p>}
      <ul className="space-y-2">
        {rows.map((s) => (
          <li key={s.id} data-testid="session-row" className="border border-black p-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm break-words min-w-0">
              <span className="font-bold">{s.device || "-"}</span>
              {s.current && <span> ({c("c.login.sessThis")})</span>}
              {s.lastSeen && <span className="block text-xs">{c("c.login.sessSeen")}: {s.lastSeen.slice(0, 10)}</span>}
            </span>
            {!s.current && <Btn secondary data-testid="session-revoke" onClick={async () => { try { await civicIdentityApi.revokeSession(s.id); setMsg(c("c.login.sessDone")); load(); } catch { setMsg(c("c.error")); } }}>{c("c.login.sessRevoke")}</Btn>}
          </li>
        ))}
      </ul>
      {msg && <p role="status" data-testid="session-msg" className="text-sm font-bold">{msg}</p>}
    </section>
  );
}
