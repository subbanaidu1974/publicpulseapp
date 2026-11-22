import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { civicIdentityApi, type GeoState, type GeoUnit } from "../../api/civic";
import { useT } from "../../i18n";
import { useCivicT } from "./civicText";
import { Btn, ErrorNote, Field, TextInput, inputCls } from "./ui";

/** Residence declaration (T1): state, district, mandal, village, optional hamlet. Honest copy: this is self-declared. */
export default function ResidenceFlow({ declared, onDeclared }: { declared?: boolean; onDeclared: () => void }) {
  const c = useCivicT();
  const { lang } = useT();
  const [open, setOpen] = useState(!declared);
  const [state, setState] = useState<GeoState>("AP");
  const [districts, setDistricts] = useState<GeoUnit[]>([]);
  const [mandals, setMandals] = useState<GeoUnit[]>([]);
  const [villages, setVillages] = useState<GeoUnit[]>([]);
  const [district, setDistrict] = useState<GeoUnit | null>(null);
  const [mandal, setMandal] = useState<GeoUnit | null>(null);
  const [village, setVillage] = useState<GeoUnit | null>(null);
  const [hamlet, setHamlet] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<(GeoUnit & { path: string[] })[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const nm = (u: GeoUnit) => (lang === "te" ? u.nameTe ?? u.nameEn : u.nameEn);

  useEffect(() => { setOpen(!declared); }, [declared]);
  useEffect(() => {
    setDistrict(null); setMandal(null); setVillage(null); setMandals([]); setVillages([]); setHits([]); setQ("");
    civicIdentityApi.geoUnits(state, "district").then(setDistricts).catch(() => setDistricts([]));
  }, [state]);
  useEffect(() => {
    setMandal(null); setVillage(null); setVillages([]);
    if (district) civicIdentityApi.geoUnits(state, "mandal", district.code).then(setMandals).catch(() => setMandals([]));
    else setMandals([]);
  }, [district, state]);
  useEffect(() => {
    setVillage(null);
    if (mandal) civicIdentityApi.geoUnits(state, "village", mandal.code).then(setVillages).catch(() => setVillages([]));
    else setVillages([]);
  }, [mandal, state]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const mine = ++seq.current;
    const h = setTimeout(() => { civicIdentityApi.geoSearchVillages(state, q.trim()).then((r) => { if (mine === seq.current) setHits(r.slice(0, 8)); }).catch(() => undefined); }, 250);
    return () => clearTimeout(h);
  }, [q, state]);

  const pick = (list: GeoUnit[], set: (u: GeoUnit | null) => void) => (e: ChangeEvent<HTMLSelectElement>) => set(list.find((u) => u.code === e.target.value) ?? null);
  const sel = (id: string, label: string, list: GeoUnit[], val: GeoUnit | null, set: (u: GeoUnit | null) => void, disabled = false) => (
    <Field id={id} label={label}>
      <select id={id} data-testid={id} className={inputCls} disabled={disabled || list.length === 0} value={val?.code ?? ""} onChange={pick(list, set)}>
        <option value="">{c("c.res.choose")}</option>
        {list.map((u) => <option key={u.code} value={u.code}>{nm(u)}</option>)}
      </select>
    </Field>
  );

  if (!open) {
    return (
      <section data-testid="residence-flow" aria-label={c("c.res.title")} className="space-y-2 max-w-md">
        <p data-testid="res-current" className="text-sm">{c("c.res.current")}</p>
        {saved && <p role="status" data-testid="res-saved" className="text-sm font-bold">{c("c.res.saved")}</p>}
        <Btn secondary data-testid="res-change" onClick={() => setOpen(true)}>{c("c.res.change")}</Btn>
      </section>
    );
  }

  return (
    <form data-testid="residence-flow" aria-label={c("c.res.title")} className="space-y-4 max-w-md" onSubmit={async (e) => {
      e.preventDefault(); setErr(null);
      if (!village) { setErr(c("c.res.pick")); return; }
      setBusy(true);
      try {
        const path = (village as { path?: string[] }).path;
        const parts = path ? [hamlet.trim(), village.nameEn, ...path.slice(1).reverse()] : [hamlet.trim(), village.nameEn, mandal?.nameEn, district?.nameEn, state];
        await civicIdentityApi.declareResidence({ residence: parts.join(", "), unitId: village.code });
        setSaved(true); setOpen(false); onDeclared();
      } catch { setErr(c("c.error")); } finally { setBusy(false); }
    }}>
      <h2 className="text-xl font-bold">{c("c.res.title")}</h2>
      <p className="text-sm">{c("c.res.intro")}</p>
      <p data-testid="res-honest" className="border border-black bg-amber-50 text-sm p-3">{c("c.res.honest")}</p>
      <Field id="res-state" label={c("c.res.state")}>
        <select id="res-state" data-testid="res-state" className={inputCls} value={state} onChange={(e) => setState(e.target.value as GeoState)}>
          <option value="AP">{c("c.res.ap")}</option>
          <option value="TG">{c("c.res.tg")}</option>
        </select>
      </Field>
      {sel("res-district", c("c.res.district"), districts, district, setDistrict)}
      {sel("res-mandal", c("c.res.mandal"), mandals, mandal, setMandal, !district)}
      {sel("res-village", c("c.res.village"), villages, village, setVillage, !mandal)}
      <Field id="res-search" label={c("c.res.search")}>
        <TextInput id="res-search" data-testid="res-search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </Field>
      {q.trim().length >= 2 && (
        <ul data-testid="res-hits" className="border border-black divide-y divide-black">
          {hits.length === 0 && <li className="p-2 text-sm">{c("c.res.none")}</li>}
          {hits.map((h) => (
            <li key={h.code}>
              <button type="button" data-testid="res-hit" className="w-full text-left p-2 min-h-[44px] text-sm" onClick={() => { setVillage(h); setQ(""); setHits([]); }}>
                <span className="font-bold">{nm(h)}</span> <span className="text-xs">{h.path.slice(1).join(", ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {village && <p data-testid="res-selected" role="status" className="text-sm font-bold">{c("c.res.village")}: {nm(village)}</p>}
      <Field id="res-hamlet" label={c("c.res.hamlet")}>
        <TextInput id="res-hamlet" data-testid="res-hamlet" maxLength={80} value={hamlet} onChange={(e) => setHamlet(e.target.value)} />
      </Field>
      <button type="submit" data-testid="res-submit" disabled={busy} className="min-h-[44px] min-w-[44px] px-4 py-2 text-sm font-bold border border-black bg-black text-white disabled:opacity-60">{c("c.res.declare")}</button>
      <ErrorNote msg={err} />
    </form>
  );
}
