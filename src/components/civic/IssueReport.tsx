import { useEffect, useRef, useState } from "react";
import { civicApi, type Village } from "../../api/civic";
import { CATEGORY_IDS, useCivicT, type CivicKey } from "./civicText";
import { ErrorNote, Field, TextInput, inputCls, primaryBtnCls } from "./ui";
import { useT } from "../../i18n";

/** Issue report: category, text, optional voice note (file/recorder; the audio key is a placeholder until storage lands) and village search. */
export default function IssueReport({ onSent }: { onSent?: () => void }) {
  const c = useCivicT();
  const { lang } = useT();
  const [category, setCategory] = useState<string>("water");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [villages, setVillages] = useState<Village[]>([]);
  const [village, setVillage] = useState<Village | null>(null);
  const [voice, setVoice] = useState<string | null>(null);
  const [ref, setRef] = useState<string | null>(null);
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

  return (
    <form data-testid="issue-report" aria-label={c("c.reportTitle")} className="space-y-4 max-w-md" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null); setRef(null);
      try {
        const r = await civicApi.reportIssue({ category, text, villageLgd: village!.lgd, audioKey: voice ?? undefined });
        setRef(r.id); setText(""); setVoice(null); onSent?.();
      } catch { setErr(c("c.error")); } finally { setBusy(false); }
    }}>
      <h2 className="text-xl font-bold">{c("c.reportTitle")}</h2>
      <fieldset>
        <legend className="text-sm font-bold mb-1">{c("c.category")}</legend>
        <div className="grid grid-cols-2 gap-2">
          {CATEGORY_IDS.map((id) => (
            <label key={id} className={`min-h-[44px] flex items-center gap-2 border border-black px-3 ${category === id ? "bg-black text-white" : "bg-white text-black"}`}>
              <input type="radio" name="category" value={id} data-testid={`cat-${id}`} checked={category === id} onChange={() => setCategory(id)} className="w-5 h-5" />
              <span>{c(`c.cat.${id}` as CivicKey)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field id="ir-text" label={c("c.text")}>
        <textarea id="ir-text" data-testid="ir-text" className={inputCls} rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Field id="ir-voice" label={c("c.voice")}>
        <input id="ir-voice" data-testid="ir-voice" type="file" accept="audio/*" className="w-full min-h-[44px] text-sm" onChange={(e) => { const f = e.target.files?.[0]; setVoice(f ? `voice/${Date.now()}-${f.name.replace(/[^\w.-]/g, "_")}` : null); }} />
      </Field>
      <Field id="ir-village" label={c("c.village")}>
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
      {ref !== null && <p role="status" data-testid="ir-sent">{c("c.sent")} {ref}</p>}
      <ErrorNote msg={err} />
    </form>
  );
}
