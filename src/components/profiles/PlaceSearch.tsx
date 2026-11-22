import { useEffect, useState } from "react";
import { profiles } from "../../api/profiles";
import type { GeoSearch } from "../../api/profiles";
import { useStateCtx } from "../../state/StateContext";
import { useT } from "../../i18n";
import { ErrorBanner } from "../ui";
import { useDisplayName } from "./common";

/** Search districts, mandals, villages and constituencies in English or Telugu (GET /api/v1/geo/:state/search). Results link to profile pages. */
export default function PlaceSearch() {
  const { state } = useStateCtx();
  const { t } = useT();
  const dn = useDisplayName();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<GeoSearch | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRes(null); setErr(null); return; }
    let alive = true;
    const id = setTimeout(() => {
      profiles.search(state, term).then(r => { if (alive) { setRes(r); setErr(null); } }, e => { if (alive) { setRes(null); setErr(String(e?.message ?? "error")); } });
    }, 200);
    return () => { alive = false; clearTimeout(id); };
  }, [q, state]);

  return (
    <section className="bg-[#FAF8F5] border border-black/20 p-4 sm:p-6 space-y-3 mt-6" aria-label={t("prof.placeSearch")}>
      <h3 className="text-lg font-serif italic">{t("prof.placeSearch")}</h3>
      <input data-testid="place-search" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t("prof.placeSearchHint")} aria-label={t("prof.placeSearchHint")}
        className="w-full border border-black bg-white p-3 text-sm font-sans" />
      {err && <ErrorBanner inline message={err} onRetry={() => setQ(q + " ")} />}
      {res && res.results.length === 0 && <p className="text-xs font-sans">{t("cs.none")}</p>}
      {res && res.results.length > 0 && (
        <ul className="divide-y divide-black/10 bg-white border border-black/10" data-testid="place-results">
          {res.results.map(r => (
            <li key={`${r.kind}-${r.code}`}>
              <a data-testid="place-result" href={r.href} className="block px-3 py-2 text-xs font-sans hover:bg-black/5">
                <span className="font-bold">{dn(r)}</span>{" "}
                <span className="text-[10px] uppercase tracking-widest text-slate-600">{t(`prof.kind.${r.kind}` as "prof.kind.ac")}</span>
                <span className="block text-[11px] text-slate-600">{r.path.slice(1).join(" / ")}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
