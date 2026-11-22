import { useState } from "react";
import { fetchVillages, type AcDetail, type UnitRow } from "../../api/geo";
import { useApi } from "../../api/useApi";
import { useT } from "../../i18n";
import { fmtInt } from "./mapModel";

const LIMIT = 60;
const label = (r: UnitRow, lang: string) => (lang === "te" && r.nameTe ? r.nameTe : r.name);

function Villages({ state, mandal, lang }: { state: "AP" | "TG"; mandal: UnitRow; lang: string }) {
  const { t } = useT();
  const q = useApi(() => fetchVillages(state, mandal.lgd), [state, mandal.lgd]);
  const [all, setAll] = useState(false);
  if (q.loading) return <p role="status" className="px-2 py-1">{t("common.loading")}</p>;
  if (q.error || !q.data) return <p className="px-2 py-1">{t("map.units.unavailable")}</p>;
  const rows = all ? q.data : q.data.slice(0, LIMIT);
  return (
    <div data-testid="map-villages" className="px-2 py-1">
      <ul className="max-h-40 overflow-auto" tabIndex={0} aria-label={`${t("map.villages")}: ${mandal.name}`}>
        {rows.map((v) => (
          <li key={v.lgd} className="flex flex-wrap justify-between gap-x-2 py-0.5">
            <span>{label(v, lang)}{lang !== "te" && v.nameTe ? <span lang="te" className="ml-2 opacity-80">{v.nameTe}</span> : null}</span>
            <span className="opacity-70">LGD {v.lgd}{v.censusCode ? `, Census ${v.censusCode}` : ""}</span>
          </li>
        ))}
      </ul>
      {q.data.length > LIMIT && <button type="button" onClick={() => setAll(!all)} className="underline font-bold cursor-pointer">{all ? t("map.showFewer") : `${t("map.showAll")} (${q.data.length})`}</button>}
    </div>
  );
}

/** Counts, mandals (with Telugu names) and on-demand villages for one constituency. Honest empty state when the service has none. */
export default function UnitsPanel({ state, loading, error, detail, lang }: { state: "AP" | "TG"; loading: boolean; error: string | null; detail: AcDetail | null; lang: string }) {
  const { t } = useT();
  const [open, setOpen] = useState<string | null>(null);
  if (loading) return <p role="status">{t("common.loading")}</p>;
  if (error || !detail) return <p data-testid="map-units-unavailable" role="status">{t("map.units.unavailable")}</p>;
  const c = detail.counts;
  const items: [string, number | undefined][] = [[t("map.villages"), c.villages], [t("map.wards"), c.wards], [t("map.mandals"), c.mandals], [t("map.urban"), c.urbanBodies]];
  return (
    <div data-testid="map-units" className="space-y-3">
      <dl className="grid grid-cols-2 gap-2">
        {items.filter(([, v]) => typeof v === "number").map(([k, v]) => (
          <div key={k} className="border border-black/10 p-2"><dt className="text-[10px] uppercase tracking-widest font-black">{k}</dt><dd className="text-base font-serif">{fmtInt(v!)}</dd></div>
        ))}
      </dl>
      {detail.census && <p className="text-[11px]">{t("map.m.population")}: {fmtInt(detail.census.population)} ({detail.census.villagesWithCensus}/{detail.census.villagesTotal} {t("map.villages").toLowerCase()})</p>}
      {detail.mandals.length === 0 ? (
        <p data-testid="map-units-unavailable">{t("map.units.unavailable")}</p>
      ) : (
        <section data-testid="map-mandals" className="space-y-1">
          <h4 className="font-black uppercase tracking-widest text-[10px]">{t("map.mandals")} ({detail.mandals.length})</h4>
          <ul className="border border-black/10 divide-y divide-black/10">
            {detail.mandals.map((m) => (
              <li key={m.lgd}>
                <button type="button" aria-expanded={open === m.lgd} onClick={() => setOpen(open === m.lgd ? null : m.lgd)} className="w-full text-left px-2 py-1 flex flex-wrap justify-between gap-x-2 cursor-pointer">
                  <span>{label(m, lang)}{lang !== "te" && m.nameTe ? <span lang="te" className="ml-2 opacity-80">{m.nameTe}</span> : null}</span>
                  <span className="opacity-70">LGD {m.lgd}</span>
                </button>
                {open === m.lgd && <Villages state={state} mandal={m} lang={lang} />}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
