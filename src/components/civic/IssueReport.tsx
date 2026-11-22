import { useEffect, useRef, useState } from "react";
import { civicApi, type Village } from "../../api/civic";
import { useCivicT } from "./civicText";
import { glyphFor, useCategories } from "./categories";
import { PhotoPicker, VoiceRecorder } from "./MediaPicker";
import { Btn, ErrorNote, Field, TextInput, inputCls, primaryBtnCls } from "./ui";
import { useT } from "../../i18n";

type Gps = { state: "idle" | "asking" | "got" | "denied"; lat?: number; lon?: number };

/** Issue report (S-137): icon-led category, text, photo and voice uploaded to /issues/media (refs `media:<id>`), optional GPS, village/hamlet search. */
export default function IssueReport({ onSent }: { onSent?: () => void }) {
  const c = useCivicT();
  const { lang } = useT();
  const { cats, label } = useCategories();
  const [category, setCategory] = useState<string>("water");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [villages, setVillages] = useState<Village[]>([]);
  const [village, setVillage] = useState<Village | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [voice, setVoice] = useState<string | null>(null);
  const [gps, setGps] = useState<Gps>({ state: "idle" });
  const [ref, setRef] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"held" | "merged" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (q.trim().length < 2 || village) { setVillages([]); return; }
    const mine = ++seq.current;
    const h = setTimeout(() => {
      civicApi.searchVillages(q.trim()).then((v) => { if (mine === seq.current) setVillages(v.slice(0, 8)); }).catch(() => { if (mine === seq.current) setVillages([]); });
    }, 250);
    return () => clearTimeout(h);
  }, [q, village]);

  const vName = (v: Village) => (lang === "te" ? v.nameTe ?? v.nameEn : v.nameEn);
  const askGps = () => {
    if (!navigator.geolocation) { setGps({ state: "denied" }); return; }
    setGps({ state: "asking" });
    navigator.geolocation.getCurrentPosition(
      (p) => setGps({ state: "got", lat: Math.round(p.coords.latitude * 1e4) / 1e4, lon: Math.round(p.coords.longitude * 1e4) / 1e4 }),
      () => setGps({ state: "denied" }), { timeout: 10_000, maximumAge: 60_000 });
  };

  return (
    <form data-testid="issue-report" aria-label={c("c.reportTitle")} className="space-y-4 max-w-md" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null); setRef(null); setOutcome(null);
      try {
        const r = await civicApi.reportIssue({ category, text, villageLgd: village!.lgd, photoRef: photo ?? undefined, voiceRef: voice ?? undefined, lat: gps.state === "got" ? gps.lat : undefined, lon: gps.state === "got" ? gps.lon : undefined });
        setRef(r.id); setOutcome(r.held ? "held" : r.merged ? "merged" : null); setText(""); setPhoto(null); setVoice(null); onSent?.();
      } catch { setErr(c("c.error")); } finally { setBusy(false); }
    }}>
      <h2 className="text-xl font-bold">{c("c.reportTitle")}</h2>
      <fieldset>
        <legend className="text-sm font-bold mb-1">{c("c.category")}</legend>
        <div className="grid grid-cols-2 gap-2">
          {cats.map((k) => (
            <label key={k.id} className={`min-h-[56px] flex items-center gap-2 border border-black px-3 ${category === k.id ? "bg-black text-white" : "bg-white text-black"}`}>
              <input type="radio" name="category" value={k.id} data-testid={`cat-${k.id}`} checked={category === k.id} onChange={() => setCategory(k.id)} className="w-7 h-7 shrink-0" />
              <span aria-hidden="true" className="text-2xl leading-none">{glyphFor(k)}</span>
              <span className="text-sm break-words min-w-0">{label(k.id)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field id="ir-text" label={c("c.text")}>
        <textarea id="ir-text" data-testid="ir-text" className={inputCls} rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <PhotoPicker onRef={setPhoto} />
      <VoiceRecorder onRef={setVoice} />
      <div className="space-y-2" data-testid="gps-block">
        <p className="text-sm font-bold">{c("c.issue.gps")}</p>
        <p className="text-xs">{c("c.issue.gpsWhy")}</p>
        {gps.state !== "got"
          ? <Btn secondary data-testid="ir-gps" disabled={gps.state === "asking"} onClick={askGps}><span aria-hidden="true">📍 </span>{c("c.issue.gpsAsk")}</Btn>
          : <div className="flex items-center gap-2 flex-wrap"><span role="status" data-testid="ir-gps-got">{c("c.issue.gpsGot")}</span><Btn secondary onClick={() => setGps({ state: "idle" })}>{c("c.issue.gpsRemove")}</Btn></div>}
        {gps.state === "denied" && <p role="alert" data-testid="ir-gps-denied" className="text-sm font-bold">{c("c.issue.gpsDenied")}</p>}
      </div>
      <Field id="ir-village" label={c("c.village")}>
        <p className="text-xs mb-1">{c("c.issue.villageHelp")}</p>
        <TextInput id="ir-village" data-testid="ir-village" role="combobox" aria-expanded={villages.length > 0} aria-controls="ir-village-list" autoComplete="off" value={village ? vName(village) : q} onChange={(e) => { setVillage(null); setQ(e.target.value); }} />
      </Field>
      {villages.length > 0 && (
        <ul id="ir-village-list" role="listbox" aria-label={c("c.village")} className="border border-black bg-white">
          {villages.map((v) => (
            <li key={v.lgd} role="option" aria-selected={false}>
              <button type="button" data-testid="village-option" className="w-full text-left min-h-[44px] px-3 py-2" onClick={() => { setVillage(v); setVillages([]); }}>
                {vName(v)}{v.mandal ? `, ${v.mandal}` : ""}
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.trim().length >= 2 && !village && villages.length === 0 && <p className="text-xs">{c("c.villageNone")}</p>}
      <button type="submit" data-testid="ir-submit" disabled={busy || !village || (text.trim().length < 3 && !voice)} className={primaryBtnCls}>{c("c.submit")}</button>
      {ref !== null && <p role="status" data-testid="ir-sent">{outcome === "held" ? c("c.issue.held") : outcome === "merged" ? c("c.issue.merged") : `${c("c.sent")} ${ref}`}</p>}
      <ErrorNote msg={err} />
    </form>
  );
}
