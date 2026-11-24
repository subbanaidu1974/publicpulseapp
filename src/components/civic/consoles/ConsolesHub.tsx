import { useEffect, useState } from "react";
import { issuesApi, type Me } from "../../../api/civic";
import { useCivicT } from "../civicText";
import { Btn } from "../ui";
import AdminConsole from "./AdminConsole";
import AssistedCoordinator from "./AssistedCoordinator";
import AssistedReviewer from "./AssistedReviewer";
import ModeratorConsole from "./ModeratorConsole";
import OfficerConsole from "./OfficerConsole";
import PoliticianConsole from "./PoliticianConsole";

type Which = "officer" | "moderator" | "politician" | "admin" | "assist_coordinator" | "assist_reviewer";

/**
 * Entry to the work consoles. Which tabs appear is a convenience derived from GET /admin/me (or the identity record); it is not a
 * security control: every console loads and writes through endpoints the server authorises, and shows 401/403 states when refused.
 */
export default function ConsolesHub() {
  const c = useCivicT();
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState<Which | null>(null);
  useEffect(() => { let live = true; issuesApi.me().then((m) => { if (live) setMe(m); }).catch(() => { /* signed out or no roles: show nothing */ }); return () => { live = false; }; }, []);
  const tabs = (["officer", "moderator", "politician", "assist_coordinator", "assist_reviewer", "admin"] as Which[]).filter((r) => me?.roles.includes(r) || (r === "officer" && me?.roles.includes("admin")));
  if (!me || tabs.length === 0) return null;
  return (
    <section data-testid="consoles" aria-labelledby="cons-h" className="space-y-3 border-t border-black pt-4">
      <h2 id="cons-h" className="text-xl font-bold">{c("c.cons.title")}</h2>
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby="cons-h">
        {tabs.map((t) => <Btn key={t} secondary={open !== t} data-testid={`console-tab-${t}`} aria-pressed={open === t} onClick={() => setOpen(open === t ? null : t)}>{c(`c.cons.${t}`)}</Btn>)}
      </div>
      {open === "officer" && <OfficerConsole />}
      {open === "moderator" && <ModeratorConsole />}
      {open === "politician" && <PoliticianConsole />}
      {open === "assist_coordinator" && <AssistedCoordinator />}
      {open === "assist_reviewer" && <AssistedReviewer />}
      {open === "admin" && <AdminConsole personId={me.personId} />}
    </section>
  );
}
