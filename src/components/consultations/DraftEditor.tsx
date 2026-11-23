import { useState } from "react";
import { consApi, type ClauseInput, type ConsDetail, type DraftInput, type Finding } from "../../api/consultations";
import { useConsT } from "./consultationsText";
import { type Keyed, Btn, ErrorLine, card, inputCls, useErrMsg } from "./shared";

interface AudioRow { group: string; status: "placeholder" | "recorded"; file_id: string; duration_s: string }
interface ClauseRow { original_ref: string; original_text: string; summary_en: string; summary_te: string; audio: AudioRow[] }
const emptyClause = (): ClauseRow => ({ original_ref: "", original_text: "", summary_en: "", summary_te: "", audio: [] });
const toLocal = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const groupsOf = (s: string) => [...new Set(s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))];

/** Create or edit a consultation draft. Content is frozen at submission; after that only corrections apply. */
export function DraftEditor({ initial, admin, onDone, onCancel }: Keyed & { initial: ConsDetail | null; admin: boolean; onDone: () => void; onCancel: () => void }) {
  const c = useConsT();
  const msg = useErrMsg();
  const day = 86_400_000;
  const [titleEn, setTitleEn] = useState(initial?.title_en ?? ""), [titleTe, setTitleTe] = useState(initial?.title_te ?? "");
  const [dept, setDept] = useState(initial?.department ?? ""), [bill, setBill] = useState(initial?.bill_ref ?? ""), [url, setUrl] = useState(initial?.source_url ?? "https://");
  const [state, setState] = useState(initial?.scope.state ?? "AP");
  const [opens, setOpens] = useState(toLocal(initial?.opens_at ?? new Date(Date.now() - 60_000).toISOString())), [closes, setCloses] = useState(toLocal(initial?.closes_at ?? new Date(Date.now() + 14 * day).toISOString()));
  const [groups, setGroups] = useState((initial?.affected_groups ?? []).join(", "));
  const [clauses, setClauses] = useState<ClauseRow[]>(initial ? initial.clauses.map((x) => ({ original_ref: x.original_ref ?? "", original_text: x.original_text ?? "", summary_en: x.summary_en, summary_te: x.summary_te, audio: x.audio.map((a) => ({ group: a.group, status: a.status === "recorded" || a.status === "reviewed" ? "recorded" : "placeholder", file_id: a.file_id ?? "", duration_s: String(a.duration_s) })) })) : [emptyClause()]);
  const [err, setErr] = useState<string | null>(null), [findings, setFindings] = useState<Finding[]>([]), [saved, setSaved] = useState<string | null>(initial?.id ?? null), [busy, setBusy] = useState(false), [note, setNote] = useState<string | null>(null);

  const setC = (i: number, p: Partial<ClauseRow>) => setClauses((x) => x.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const groupList = groupsOf(groups);
  const body = (): DraftInput => ({
    title_en: titleEn, title_te: titleTe, ...(admin ? { department: dept } : {}), bill_ref: bill, source_url: url, scope: { state, units: {} },
    opens_at: new Date(opens).toISOString(), closes_at: new Date(closes).toISOString(), affected_groups: groupList,
    clauses: clauses.map((x): ClauseInput => ({
      ...(x.original_ref ? { original_ref: x.original_ref } : {}), ...(x.original_text ? { original_text: x.original_text } : {}), summary_en: x.summary_en, summary_te: x.summary_te,
      audio: x.audio.filter((a) => a.group).map((a) => ({ group: a.group, status: a.status, ...(a.file_id ? { file_id: a.file_id } : {}), duration_s: Number(a.duration_s) || 0 })),
    })),
  });
  const save = async (): Promise<string | null> => {
    setErr(null); setNote(null); setBusy(true);
    try {
      const r = saved ? await consApi.update(saved, body()) : await consApi.create(body());
      setSaved(r.id); setFindings(r.findings ?? []); setNote(c("ed.saved")); return r.id;
    } catch (e) { setErr(msg(e)); return null; } finally { setBusy(false); }
  };
  const submit = async () => {
    const id = await save(); if (!id) return;
    setBusy(true);
    try { await consApi.submit(id); onDone(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };

  return (
    <form className="space-y-4" data-testid="ed-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 className="text-xl font-bold">{initial ? c("ed.edit") : c("ed.new")}</h2>
      <p className="text-sm">{c("ed.intro")}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-sm font-bold block">{c("ed.titleEn")}<input data-testid="ed-title-en" className={inputCls + " font-normal"} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} /></label>
        <label className="text-sm font-bold block">{c("ed.titleTe")}<input data-testid="ed-title-te" lang="te" className={inputCls + " font-normal"} value={titleTe} onChange={(e) => setTitleTe(e.target.value)} /></label>
        {admin && <label className="text-sm font-bold block">{c("f.department")}<input data-testid="ed-dept" className={inputCls + " font-normal"} value={dept} onChange={(e) => setDept(e.target.value)} /></label>}
        <label className="text-sm font-bold block">{c("f.bill")}<input data-testid="ed-bill" className={inputCls + " font-normal"} value={bill} onChange={(e) => setBill(e.target.value)} /></label>
        <label className="text-sm font-bold block">{c("ed.source")}<input data-testid="ed-source" type="url" className={inputCls + " font-normal"} value={url} onChange={(e) => setUrl(e.target.value)} /></label>
        <label className="text-sm font-bold block">{c("f.state")}
          <select data-testid="ed-state" className={inputCls + " font-normal"} value={state} onChange={(e) => setState(e.target.value)}><option value="AP">AP</option><option value="TG">TG</option></select>
        </label>
        <label className="text-sm font-bold block">{c("ed.opens")}<input data-testid="ed-opens" type="datetime-local" className={inputCls + " font-normal"} value={opens} onChange={(e) => setOpens(e.target.value)} /></label>
        <label className="text-sm font-bold block">{c("ed.closes")}<input data-testid="ed-closes" type="datetime-local" className={inputCls + " font-normal"} value={closes} onChange={(e) => setCloses(e.target.value)} /></label>
      </div>
      <label className="text-sm font-bold block">{c("ed.groups")}<input data-testid="ed-groups" className={inputCls + " font-normal"} value={groups} onChange={(e) => setGroups(e.target.value)} aria-describedby="ed-groups-h" /></label>
      <p id="ed-groups-h" className="text-xs">{c("ed.groupsHint")}</p>
      {clauses.map((cl, i) => (
        <fieldset key={i} className={card} data-testid="ed-clause">
          <legend className="font-bold px-1">{c("cl.n", { n: i + 1 })}</legend>
          <label className="text-sm font-bold block">{c("cl.ref")}<input data-testid="ed-ref" className={inputCls + " font-normal"} value={cl.original_ref} onChange={(e) => setC(i, { original_ref: e.target.value })} /></label>
          <label className="text-sm font-bold block">{c("cl.original")}<textarea data-testid="ed-original" className={inputCls + " font-normal"} rows={2} value={cl.original_text} onChange={(e) => setC(i, { original_text: e.target.value })} /></label>
          <label className="text-sm font-bold block">{c("ed.sumEn")}<textarea data-testid="ed-sum-en" className={inputCls + " font-normal"} rows={2} value={cl.summary_en} onChange={(e) => setC(i, { summary_en: e.target.value })} /></label>
          <label className="text-sm font-bold block">{c("ed.sumTe")}<textarea data-testid="ed-sum-te" lang="te" className={inputCls + " font-normal"} rows={2} value={cl.summary_te} onChange={(e) => setC(i, { summary_te: e.target.value })} /></label>
          <div className="space-y-2 border border-black/30 p-2">
            <p className="font-bold text-sm">{c("ed.audio")}</p>
            <p className="text-xs" data-testid="ed-audio-note">{c("ed.audioNote")}</p>
            {cl.audio.map((a, j) => (
              <div key={j} className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-end" data-testid="ed-audio-row">
                <label className="text-xs font-bold block">{c("ed.audioGroup")}
                  <select className={inputCls + " font-normal"} value={a.group} onChange={(e) => setC(i, { audio: cl.audio.map((x, k) => (k === j ? { ...x, group: e.target.value } : x)) })}><option value="">-</option>{groupList.map((g) => <option key={g} value={g}>{g}</option>)}</select></label>
                <label className="text-xs font-bold block">{c("ed.audioStatus")}
                  <select className={inputCls + " font-normal"} value={a.status} onChange={(e) => setC(i, { audio: cl.audio.map((x, k) => (k === j ? { ...x, status: e.target.value as "placeholder" | "recorded" } : x)) })}><option value="placeholder">{c("aud.st.placeholder")}</option><option value="recorded">{c("aud.st.recorded")}</option></select></label>
                <label className="text-xs font-bold block">{c("ed.audioFile")}<input className={inputCls + " font-normal"} value={a.file_id} onChange={(e) => setC(i, { audio: cl.audio.map((x, k) => (k === j ? { ...x, file_id: e.target.value } : x)) })} /></label>
                <label className="text-xs font-bold block">{c("ed.audioSecs")}<input className={inputCls + " font-normal"} inputMode="numeric" value={a.duration_s} onChange={(e) => setC(i, { audio: cl.audio.map((x, k) => (k === j ? { ...x, duration_s: e.target.value } : x)) })} /></label>
                <Btn secondary onClick={() => setC(i, { audio: cl.audio.filter((_, k) => k !== j) })}>{c("ed.remove")}</Btn>
              </div>
            ))}
            <Btn secondary data-testid="ed-add-audio" onClick={() => setC(i, { audio: [...cl.audio, { group: groupList[0] ?? "", status: "placeholder", file_id: "", duration_s: "60" }] })}>{c("ed.addAudio")}</Btn>
          </div>
          {clauses.length > 1 && <Btn secondary onClick={() => setClauses((x) => x.filter((_, j) => j !== i))}>{c("ed.removeClause")}</Btn>}
        </fieldset>
      ))}
      <Btn secondary data-testid="ed-add-clause" onClick={() => setClauses((x) => [...x, emptyClause()])}>{c("ed.addClause")}</Btn>
      <ErrorLine msg={err} />
      {note && <p role="status" data-testid="ed-note" className="text-sm font-bold">{note}</p>}
      {findings.length > 0 && <ul className="text-sm list-disc pl-5" data-testid="ed-findings">{findings.map((f, i) => <li key={i}><strong>{f.severity}</strong> {f.where}: {f.text}</li>)}</ul>}
      <div className="flex flex-wrap gap-3">
        <Btn type="submit" data-testid="ed-save" disabled={busy}>{c("ed.save")}</Btn>
        <Btn secondary data-testid="ed-submit" disabled={busy} onClick={() => void submit()}>{c("ed.submit")}</Btn>
        <Btn secondary onClick={onCancel}>{c("ed.cancel")}</Btn>
      </div>
      <p className="text-xs">{c("ed.frozen")}</p>
    </form>
  );
}
