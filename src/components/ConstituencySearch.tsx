import { useMemo, useState } from "react";
import { api, Seat } from "../api/client";
import { useApi } from "../api/useApi";
import { ElectionType, StateCode } from "../lib/states";
import { useStateCtx } from "../state/StateContext";
import { useT } from "../i18n";
import { DemoBadge, ErrorBanner, fmt, Loading } from "./ui";
import ConstituencyProfile from "./profiles/ConstituencyProfile";

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

  const addCompare = () => {
    if (!picked) return;
    const next = [...cmp.filter((c) => !(c.state === state && c.seat.acNo === picked.acNo && c.year === year && c.type === type)),
      { state, year, type, seat: picked, demo: !!seats.data?.demo }].slice(-2);
    setCmp(next);
    try { sessionStorage.setItem(CMP_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const clearCmp = () => { setCmp([]); try { sessionStorage.removeItem(CMP_KEY); } catch { /* ignore */ } };

  const name = (s: Seat) => (lang === "te" ? s.acNameTe ?? TE_HINTS[s.acName] ?? s.acName : s.acName);

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
        <ConstituencyProfile state={state} acNo={picked.acNo}
          actions={<button type="button" onClick={addCompare} className="border border-black px-3 py-1 text-[10px] uppercase tracking-widest font-black cursor-pointer">{t("cs.compare")}</button>} />
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
                <div>{c.year} {t(c.type === "ls" ? "type.ls" : "type.assembly")} &middot; {c.seat.winnerParty} &middot; {t("cs.margin")} {fmt(c.seat.marginPct)}%</div>
                <div className="text-[10px] text-slate-500">{t("cs.compareSource")} {c.demo && <DemoBadge testId="demo-badge-inline" />}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
