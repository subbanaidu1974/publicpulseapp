import { useMemo, useState } from "react";
import { api, CensusRow, Seat } from "../api/client";
import { useApi } from "../api/useApi";
import { ElectionType, StateCode } from "../lib/states";
import { ELECTION_YEARS, useStateCtx } from "../state/StateContext";
import { useT } from "../i18n";
import { DemoBadge, ErrorBanner, fmt, Loading } from "./ui";

/** Small EN->TE name hints so Telugu input works even when the API has no Telugu names. */
const TE_HINTS: Record<string, string> = {
  Mangalagiri: "మంగళగిరి", Pithapuram: "పిఠాపురం", Kuppam: "కుప్పం", Pulivendla: "పులివెందుల", Tirupati: "తిరుపతి",
  Visakhapatnam: "విశాఖపట్నం", Vijayawada: "విజయవాడ", Guntur: "గుంటూరు", Nellore: "నెల్లూరు", Kurnool: "కర్నూలు",
  Kodangal: "కొడంగల్", Gajwel: "గజ్వేల్", Siddipet: "సిద్దిపేట", Sircilla: "సిరిసిల్ల", Kamareddy: "కామారెడ్డి",
  Hyderabad: "హైదరాబాద్", Secunderabad: "సికింద్రాబాద్", Warangal: "వరంగల్", Karimnagar: "కరీంనగర్", Nizamabad: "నిజామాబాద్",
  Khammam: "ఖమ్మం", Adilabad: "ఆదిలాబాద్", Malkajgiri: "మల్కాజ్‌గిరి", Chevella: "చేవెళ్ల", Rajahmundry: "రాజమండ్రి",
};

interface CompareItem { state: StateCode; year: number; type: ElectionType; seat: Seat; demo: boolean }
const CMP_KEY = "pp-compare";
const loadCmp = (): CompareItem[] => { try { return JSON.parse(sessionStorage.getItem(CMP_KEY) ?? "[]"); } catch { return []; } };

export default function ConstituencySearch({ year, type }: { year: number; type: ElectionType; valid?: boolean }) {
  const { state, config } = useStateCtx();
  const { t, lang } = useT();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Seat | null>(null);
  const [cmp, setCmp] = useState<CompareItem[]>(loadCmp);

  const seats = useApi(() => api.seats(state, year, type), [state, year, type]);

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || !seats.data) return [];
    return seats.data.seats.filter((x) =>
      x.acName.toLowerCase().includes(s) ||
      (x.acNameTe ?? "").includes(q.trim()) ||
      (TE_HINTS[x.acName] ?? "").includes(q.trim()) ||
      String(x.acNo) === s,
    ).slice(0, 15);
  }, [q, seats.data]);

  const years = ELECTION_YEARS[state][type];
  const history = useApi(async () => {
    if (!picked) return [];
    const res = await Promise.allSettled(years.map((y) => api.seats(state, y, type)));
    return res.flatMap((r, i) => {
      if (r.status !== "fulfilled") return [];
      const seat = r.value.seats.find((x) => x.acNo === picked.acNo);
      return seat ? [{ year: years[i], seat, demo: r.value.demo }] : [];
    });
  }, [picked?.acNo, state, type]);

  const census = useApi(() => api.census(state), [state]);
  const censusRow: CensusRow | undefined = picked?.district
    ? census.data?.rows.find((r) => String(r.district ?? r.name ?? "").toLowerCase() === picked.district!.toLowerCase())
    : undefined;

  const addCompare = () => {
    if (!picked) return;
    const next = [...cmp.filter((c) => !(c.state === state && c.seat.acNo === picked.acNo && c.year === year && c.type === type)),
      { state, year, type, seat: picked, demo: !!seats.data?.demo }].slice(-2);
    setCmp(next);
    try { sessionStorage.setItem(CMP_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const clearCmp = () => { setCmp([]); try { sessionStorage.removeItem(CMP_KEY); } catch { /* ignore */ } };

  const name = (s: Seat) => (lang === "te" ? s.acNameTe ?? TE_HINTS[s.acName] ?? s.acName : s.acName);
  const pct = (n: unknown) => (typeof n === "number" ? `${n.toFixed(1)}%` : "n/a");

  return (
    <section className="bg-[#FAF8F5] border border-black/20 p-4 sm:p-6 space-y-4" aria-label={t("cs.title")}>
      <h3 className="text-lg font-serif italic">{t("cs.title")} <span className="text-xs font-sans not-italic">({lang === "te" ? config.nameTe : config.name} {year})</span></h3>
      <input
        data-testid="constituency-search"
        type="search"
        value={q}
        onChange={(e) => { setQ(e.target.value); setPicked(null); }}
        placeholder={t("cs.placeholder")}
        aria-label={t("cs.placeholder")}
        className="w-full border border-black bg-white p-3 text-sm font-sans"
      />
      {seats.error && <ErrorBanner inline message={seats.error} onRetry={seats.retry} />}
      {seats.loading && <Loading />}
      {q.trim() && seats.data && hits.length === 0 && <p className="text-xs font-sans">{t("cs.none")}</p>}
      <ul className="divide-y divide-black/10 bg-white border border-black/10">
        {hits.map((h) => (
          <li key={h.acNo}>
            <button type="button" data-testid="constituency-result" onClick={() => setPicked(h)}
              className="w-full text-left px-3 py-2 text-xs font-sans hover:bg-black/5 cursor-pointer flex justify-between gap-2">
              <span>{h.acNo}. {h.acName}{(h.acNameTe ?? TE_HINTS[h.acName]) ? ` / ${h.acNameTe ?? TE_HINTS[h.acName]}` : ""}</span>
              <span className="text-slate-500">{h.district ?? ""}</span>
            </button>
          </li>
        ))}
      </ul>

      {picked && (
        <div data-testid="constituency-profile" className="bg-white border border-black p-4 space-y-4">
          <div className="flex flex-wrap justify-between items-start gap-2">
            <div>
              <h4 className="text-xl font-serif italic">{name(picked)}</h4>
              <p className="text-[11px] font-sans text-slate-600">{picked.district ?? ""} &middot; #{picked.acNo} &middot; {config.name}</p>
            </div>
            <div className="flex items-center gap-2">
              {seats.data?.demo && <DemoBadge testId="demo-badge-inline" />}
              <button type="button" onClick={addCompare} className="border border-black px-3 py-1 text-[10px] uppercase tracking-widest font-black cursor-pointer">{t("cs.compare")}</button>
            </div>
          </div>

          <div>
            <h5 className="text-[10px] uppercase tracking-widest font-black mb-1">{t("cs.history")}</h5>
            {history.loading && <Loading />}
            {history.error && <ErrorBanner inline message={history.error} onRetry={history.retry} />}
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-sans border-collapse">
                <thead><tr className="text-left border-b border-black"><th className="py-1 pr-2">{t("common.year")}</th><th className="pr-2">Winner</th><th className="pr-2">Party</th><th className="pr-2">Margin</th></tr></thead>
                <tbody>
                  {history.data?.map((h) => (
                    <tr key={h.year} className="border-b border-black/10">
                      <td className="py-1 pr-2">{h.year}</td><td className="pr-2">{h.seat.winner ?? "n/a"}</td>
                      <td className="pr-2">{h.seat.winnerParty}</td><td className="pr-2">{pct(h.seat.marginPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div data-testid="constituency-survey-card" className="border border-black/20 bg-[#FAF8F5] p-3 text-xs font-sans space-y-1">
            <div className="flex items-center gap-2"><h5 className="text-[10px] uppercase tracking-widest font-black">Survey pulse</h5><DemoBadge testId="demo-badge-inline" /></div>
            <p>Results are hidden until at least 30 responses are collected for this constituency (currently 0). <a href="#take-survey" onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("pp-nav", { detail: "survey" })); }} className="underline font-bold">Take the survey</a></p>
          </div>

          <div>
            <h5 className="text-[10px] uppercase tracking-widest font-black mb-1">{t("cs.census")}</h5>
            {census.error ? <ErrorBanner inline message={census.error} onRetry={census.retry} /> : censusRow ? (
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-sans">
                <div><dt className="text-slate-500">Population</dt><dd>{censusRow.population?.toLocaleString() ?? "n/a"}</dd></div>
                <div><dt className="text-slate-500">Literacy</dt><dd>{pct(censusRow.literacyPct ?? censusRow.literacy)}</dd></div>
                <div><dt className="text-slate-500">SC %</dt><dd>{pct(censusRow.scPct)}</dd></div>
                <div><dt className="text-slate-500">ST %</dt><dd>{pct(censusRow.stPct)}</dd></div>
                <div className="col-span-2 sm:col-span-4 text-[10px] text-slate-500">Source: Census of India {censusRow.censusYear ?? 2011} (PCA){census.data?.demo ? " " : ""}{census.data?.demo && <DemoBadge testId="demo-badge-inline" />}</div>
              </dl>
            ) : (
              <div className="text-xs font-sans space-y-1">
                <p>{t("cs.noCensus")}</p>
                {census.data && census.data.rows.length > 0 && (
                  <ul className="text-[11px] text-slate-700">
                    {census.data.rows.slice(0, 5).map((r) => (
                      <li key={String(r.district ?? r.name)}>{String(r.district ?? r.name)}: pop {r.population?.toLocaleString() ?? "n/a"}, literacy {pct(r.literacyPct ?? r.literacy)}, SC {pct(r.scPct)}, ST {pct(r.stPct)} (Census {r.censusYear ?? 2011}){census.data?.demo ? " - demo" : ""}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {cmp.length > 0 && (
        <div data-testid="constituency-compare" className="bg-white border border-black p-4">
          <div className="flex justify-between items-center mb-2">
            <h4 className="text-sm font-serif italic">{t("cs.compareTitle")}</h4>
            <button type="button" onClick={clearCmp} className="text-[10px] uppercase underline font-bold cursor-pointer">{t("cs.clear")}</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {cmp.map((c) => (
              <div key={`${c.state}-${c.seat.acNo}-${c.year}-${c.type}`} className="border border-black/20 p-3 text-xs font-sans space-y-1">
                <strong className="font-serif italic text-sm">{c.seat.acName}</strong> ({c.state})
                <div>{c.year} {c.type === "ls" ? "Lok Sabha" : "Assembly"} &middot; {c.seat.winnerParty} &middot; margin {fmt(c.seat.marginPct)}%</div>
                <div className="text-[10px] text-slate-500">Source: ECI / TCPD {c.demo && <DemoBadge testId="demo-badge-inline" />}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
