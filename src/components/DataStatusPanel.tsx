import { api, DataStatusRow } from "../api/client";
import { useApi } from "../api/useApi";
import { useT } from "../i18n";
import { DemoBadge, ErrorBanner, Loading } from "./ui";

/** Per-source data status. Public data (no secrets); the /admin view only renders it after a server-verified admin check. */
export default function DataStatusPanel({ testId = "admin-data-status" }: { testId?: string }) {
  const { t } = useT();
  const res = useApi<{ rows: DataStatusRow[]; demo: boolean }>(() => api.dataStatus(), []);
  return (
    <section data-testid={testId} className="bg-[#FAF8F5] border border-black p-4 sm:p-6 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-serif italic">{t("admin.dataStatus")}</h3>
        {res.data?.demo && <DemoBadge />}
      </div>
      {res.error && <ErrorBanner message={res.error} onRetry={res.retry} />}
      {res.loading && <Loading />}
      {res.data && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-sans border-collapse">
            <thead><tr className="text-left border-b border-black"><th className="py-1 pr-2">{t("admin.source")}</th><th className="pr-2">{t("admin.rows")}</th><th className="pr-2">{t("admin.provenance")}</th><th>{t("admin.generated")}</th></tr></thead>
            <tbody>
              {res.data.rows.map((r) => (
                <tr key={r.name} className="border-b border-black/10">
                  <td className="py-1 pr-2 font-mono">{r.name}</td><td className="pr-2">{r.rows}</td>
                  <td className="pr-2">{r.provenance}</td><td className="font-mono">{r.generatedAt ?? t("cs.na")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
