import { useEffect, useState } from "react";
import { tokenStore } from "../../api/civic";
import { useT } from "../../i18n";
import DataStatusPanel from "../DataStatusPanel";

type Gate = "checking" | "ok" | "signin" | "denied";

/**
 * Admin view. The browser decides nothing: it sends the civic session token to a server endpoint that must
 * verify the admin role. Anything other than a 200 (including 404 while the endpoint does not exist) is a denial.
 */
export default function AdminPage() {
  const { t } = useT();
  const [gate, setGate] = useState<Gate>("checking");
  useEffect(() => {
    const tok = tokenStore.get();
    if (!tok) { setGate("signin"); return; }
    let alive = true;
    fetch("/api/v1/data-status/admin", { headers: { authorization: `Bearer ${tok}` } })
      .then((r) => { if (alive) setGate(r.ok ? "ok" : "denied"); })
      .catch(() => { if (alive) setGate("denied"); });
    return () => { alive = false; };
  }, []);

  if (gate === "ok") return <DataStatusPanel />;
  return (
    <div data-testid="admin-denied" role="note" className="bg-[#FAF8F5] border border-black p-6 max-w-xl mx-auto text-center space-y-3">
      <h2 className="text-xl font-serif italic">{t("admin.title")}</h2>
      <p className="text-xs font-sans">{gate === "checking" ? t("common.loading") : gate === "signin" ? t("admin.signin") : t("admin.denied")}</p>
      {gate !== "checking" && (
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("pp-nav", { detail: "civic" }))} className="border border-black bg-black text-[#F9F7F2] px-4 py-2 text-[10px] uppercase tracking-widest font-black cursor-pointer">
          {t("nav.civic")}
        </button>
      )}
    </div>
  );
}
