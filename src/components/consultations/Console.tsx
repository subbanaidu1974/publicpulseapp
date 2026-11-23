import type { ReactNode } from "react";
import { useState } from "react";
import { consApi, type Analyst, type ClauseDiff, type ConsDetail, type ConsSummary, type CorrectionRow, type HeldComment, type Missing, type ReportPreview } from "../../api/consultations";
import { useT } from "../../i18n";
import { useConsT, type ConsKey, type ConsT } from "./consultationsText";
import { DraftEditor } from "./DraftEditor";
import { ReportView } from "./Report";
import { type Keyed, Btn, ClosingBadge, ErrorLine, Page, StatusBadge, card, fmtDate, inputCls, linkCls, shortHash, titleOf, useErrMsg, useLoad, useMe } from "./shared";

/** Plain-language line for one reason a closing report cannot be published yet. */
export function missingText(c: ConsT, m: Missing): string {
  if (m.code === "department_response_required") return c("miss.responses", { n: (m.clauses ?? []).join(", ") });
  if (m.code === "themes_required") return c("miss.themes");
  if (m.code.startsWith("figures_not_yet_publishable")) return c("miss.figures");
  return m.code;
}

function useAct(reload: () => void) {
  const msg = useErrMsg();
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false), [note, setNote] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, ok?: string, after?: () => void) => {
    setErr(null); setNote(null); setBusy(true);
    try { await fn(); if (ok) setNote(ok); after?.(); reload(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return { act, err, busy, note, setErr, setNote };
}

// ---------------------------------------------------------------------------------------------
// Department: corrections and closing tools
// ---------------------------------------------------------------------------------------------

function CorrectionForm({ cs, reload }: Keyed & { cs: ConsDetail; reload: () => void }) {
  const c = useConsT();
  const a = useAct(reload);
  const [n, setN] = useState(1), [reasonEn, setReasonEn] = useState(""), [reasonTe, setReasonTe] = useState(""), [sEn, setSEn] = useState(""), [sTe, setSTe] = useState("");
  const cl = cs.clauses.find((x) => x.n === n);
  return (
    <details className="border border-black/30 p-3" data-testid="corr-box">
      <summary className="font-bold cursor-pointer min-h-[44px] flex items-center">{c("corr.title")}</summary>
      <form className="space-y-2 mt-2" onSubmit={(e) => { e.preventDefault(); void a.act(() => consApi.correct(cs.id, { reason_en: reasonEn, ...(reasonTe ? { reason_te: reasonTe } : {}), clauses: [{ n, summary_en: sEn || cl?.summary_en, summary_te: sTe || cl?.summary_te }] }), c("corr.sent")); }}>
        <p className="text-sm">{c("corr.intro")}</p>
        <label className="text-sm font-bold block">{c("corr.clause")}
          <select data-testid="corr-clause" className={inputCls + " font-normal"} value={n} onChange={(e) => setN(Number(e.target.value))}>{cs.clauses.map((x) => <option key={x.n} value={x.n}>{c("cl.n", { n: x.n })}</option>)}</select></label>
        <label className="text-sm font-bold block">{c("ed.sumEn")}<textarea data-testid="corr-sum-en" className={inputCls + " font-normal"} rows={2} defaultValue={cl?.summary_en} key={"e" + n} onChange={(e) => setSEn(e.target.value)} /></label>
        <label className="text-sm font-bold block">{c("ed.sumTe")}<textarea data-testid="corr-sum-te" lang="te" className={inputCls + " font-normal"} rows={2} defaultValue={cl?.summary_te} key={"t" + n} onChange={(e) => setSTe(e.target.value)} /></label>
        <label className="text-sm font-bold block">{c("corr.reasonEn")}<input data-testid="corr-reason-en" className={inputCls + " font-normal"} value={reasonEn} onChange={(e) => setReasonEn(e.target.value)} /></label>
        <label className="text-sm font-bold block">{c("corr.reasonTe")}<input data-testid="corr-reason-te" lang="te" className={inputCls + " font-normal"} value={reasonTe} onChange={(e) => setReasonTe(e.target.value)} /></label>
        <ErrorLine msg={a.err} />
        {a.note && <p role="status" data-testid="corr-note" className="text-sm font-bold">{a.note}</p>}
        <Btn type="submit" data-testid="corr-send" disabled={a.busy}>{c("corr.send")}</Btn>
      </form>
    </details>
  );
}

function ResponseForm({ cs, clause, reload }: Keyed & { cs: ConsDetail; clause: number; reload: () => void }) {
  const c = useConsT();
  const a = useAct(reload);
  const [kind, setKind] = useState<"response" | "no_change">("response"), [en, setEn] = useState(""), [te, setTe] = useState("");
  return (
    <form className="border border-black/30 p-3 space-y-2" data-testid="resp-form" data-clause={clause} onSubmit={(e) => { e.preventDefault(); void a.act(() => consApi.respond(cs.id, { clause, kind, text_en: en, ...(te ? { text_te: te } : {}) }), c("resp.saved")); }}>
      <h4 className="font-bold">{c("cl.n", { n: clause })}</h4>
      <label className="text-sm font-bold block">{c("resp.kind")}
        <select data-testid="resp-kind" className={inputCls + " font-normal"} value={kind} onChange={(e) => setKind(e.target.value as "response" | "no_change")}><option value="response">{c("resp.response")}</option><option value="no_change">{c("resp.noChange")}</option></select></label>
      <label className="text-sm font-bold block">{kind === "no_change" ? c("resp.reasonsEn") : c("resp.textEn")}<textarea data-testid="resp-en" className={inputCls + " font-normal"} rows={2} value={en} onChange={(e) => setEn(e.target.value)} /></label>
      <label className="text-sm font-bold block">{c("resp.textTe")}<textarea data-testid="resp-te" lang="te" className={inputCls + " font-normal"} rows={2} value={te} onChange={(e) => setTe(e.target.value)} /></label>
      <ErrorLine msg={a.err} />
      {a.note && <p role="status" className="text-sm font-bold" data-testid="resp-note">{a.note}</p>}
      <Btn type="submit" data-testid="resp-save" disabled={a.busy}>{c("resp.save")}</Btn>
    </form>
  );
}

function ClosingTools({ cs, reload, canPublish }: Keyed & { cs: ConsDetail; reload: () => void; canPublish: boolean }) {
  const c = useConsT();
  const { lang } = useT();
  const an = useLoad<Analyst>(() => consApi.analyst(cs.id), [cs.id]);
  const a = useAct(() => { an.reload(); reload(); });
  const [theme, setTheme] = useState(""), [themeTe, setThemeTe] = useState(""), [themeClause, setThemeClause] = useState(0);
  const [pv, setPv] = useState<ReportPreview | null>(null), [missing, setMissing] = useState<Missing[] | null>(null);
  const d = an.data;
  const sample = d ? [...d.suggested_sample.representatives, ...d.suggested_sample.random] : [];
  return (
    <div className="space-y-3 border-t border-black/30 pt-3" data-testid="closing-tools">
      <h3 className="font-bold text-lg">{c("cls.title")}</h3>
      <section aria-label={c("cls.analyst")} className="space-y-2" data-testid="analyst">
        <h4 className="font-bold">{c("cls.analyst")}</h4>
        {an.loading && !d && <p role="status">{c("loading")}</p>}
        {an.error && !d && <ErrorLine msg={c("err.load")} />}
        {d && (
          <>
            <p className="text-sm" data-testid="an-coverage">{c("rep.coverageLine", { n: d.coverage.comments_total, h: d.coverage.reviewed_by_human, m: d.coverage.machine_summarised })}</p>
            <p className="text-sm">{c("cls.flags", { n: d.flags.flagged_clusters, p: d.flags.peak_per_minute, l: d.flags.rate_limited_requests })}</p>
            {d.clusters.length === 0 ? <p className="text-sm">{c("cls.noClusters")}</p> : (
              <ul className="space-y-2">
                {d.clusters.map((x, i) => (
                  <li key={i} className="border border-black/30 p-2 text-sm" data-testid="an-cluster" data-size={x.size}>
                    <strong>{x.size > 1 ? c("cls.cluster", { s: x.size, n: x.clause }) : c("cls.single", { n: x.clause })}</strong>{x.flagged ? ` - ${c("cls.flagged")}` : ""}
                    <br />{c("cls.window", { a: fmtDate(x.first_at, lang, true), b: fmtDate(x.last_at, lang, true) })}
                    {x.representative.text && <blockquote className="border-l-4 border-black pl-2 my-1 whitespace-pre-line break-words">{x.representative.text}</blockquote>}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-sm">{c("cls.sample", { n: sample.length, t: d.suggested_sample.target })}</p>
            <div className="flex flex-wrap gap-2">
              <Btn secondary data-testid="an-read" disabled={a.busy || sample.length === 0} onClick={() => void a.act(() => consApi.readComments(cs.id, sample), c("cls.readDone"))}>{c("cls.markRead")}</Btn>
              <Btn secondary data-testid="an-run" disabled={a.busy} onClick={() => void a.act(async () => { const r = await consApi.runReviewer(cs.id); a.setNote(r.note ?? c("cls.reviewerRan", { n: r.summarised })); })}>{c("cls.runReviewer")}</Btn>
            </div>
            <ul className="list-disc pl-5 text-sm" data-testid="an-themes">{d.themes.map((t) => <li key={t.id}>{lang === "te" && t.label_te ? t.label_te : t.label_en} ({t.source})</li>)}</ul>
          </>
        )}
        <form className="border border-black/30 p-3 space-y-2" data-testid="theme-form" onSubmit={(e) => { e.preventDefault(); void a.act(() => consApi.addTheme(cs.id, { label_en: theme, ...(themeTe ? { label_te: themeTe } : {}), ...(themeClause ? { clause: themeClause } : {}) }), c("cls.themeSaved"), () => { setTheme(""); setThemeTe(""); }); }}>
          <label className="text-sm font-bold block">{c("cls.themeEn")}<input data-testid="theme-en" className={inputCls + " font-normal"} value={theme} onChange={(e) => setTheme(e.target.value)} /></label>
          <label className="text-sm font-bold block">{c("cls.themeTe")}<input data-testid="theme-te" lang="te" className={inputCls + " font-normal"} value={themeTe} onChange={(e) => setThemeTe(e.target.value)} /></label>
          <label className="text-sm font-bold block">{c("corr.clause")}
            <select data-testid="theme-clause" className={inputCls + " font-normal"} value={themeClause} onChange={(e) => setThemeClause(Number(e.target.value))}><option value={0}>{c("cls.allClauses")}</option>{cs.clauses.map((x) => <option key={x.n} value={x.n}>{c("cl.n", { n: x.n })}</option>)}</select></label>
          <Btn type="submit" data-testid="theme-save" disabled={a.busy}>{c("cls.addTheme")}</Btn>
        </form>
        <ErrorLine msg={a.err} />
        {a.note && <p role="status" data-testid="cls-note" className="text-sm font-bold">{a.note}</p>}
      </section>
      <section aria-label={c("resp.title")} className="space-y-2" data-testid="responses">
        <h4 className="font-bold">{c("resp.title")}</h4>
        <p className="text-sm">{c("resp.intro")}</p>
        {cs.clauses.map((x) => <ResponseForm key={String(x.n)} cs={cs} clause={x.n} reload={() => setPv(null)} />)}
      </section>
      <section aria-label={c("prev.title")} className="space-y-2" data-testid="preview">
        <h4 className="font-bold">{c("prev.title")}</h4>
        <Btn secondary data-testid="prev-load" disabled={a.busy} onClick={() => void a.act(async () => { const r = await consApi.preview(cs.id); setPv(r); setMissing(r.missing); })}>{c("prev.load")}</Btn>
        {missing && (missing.length === 0 ? <p role="status" data-testid="prev-ready">{c("prev.ready")}</p> : <ul className="list-disc pl-5 text-sm" data-testid="prev-missing">{missing.map((m, i) => <li key={i} data-code={m.code}>{missingText(c, m)}</li>)}</ul>)}
        {pv && <details><summary className="font-bold cursor-pointer min-h-[44px] flex items-center">{c("prev.show")}</summary><ReportView r={pv.snapshot} /></details>}
        {canPublish && cs.closing_report.status !== "published" && (
          <Btn data-testid="rep-publish" disabled={a.busy} onClick={() => void a.act(async () => { try { await consApi.publishReport(cs.id); } catch (e) { const b = (e as { body?: { missing?: Missing[] } }).body; if (b?.missing) setMissing(b.missing); throw e; } }, c("prev.published"))}>{c("prev.publish")}</Btn>
        )}
      </section>
    </div>
  );
}

function DeptItem({ cs, reload, onEdit, canPublish }: Keyed & { cs: ConsDetail; reload: () => void; onEdit: () => void; canPublish: boolean }) {
  const c = useConsT();
  const { lang } = useT();
  const a = useAct(reload);
  return (
    <li className={card} data-testid="dept-item" data-cons-id={cs.id} data-status={cs.status}>
      <div className="flex flex-wrap items-center gap-2"><StatusBadge status={cs.status} /><ClosingBadge cr={cs.closing_report} /></div>
      <h3 className="text-lg font-bold break-words">{titleOf(cs, lang)}</h3>
      <p className="text-sm">{cs.department} - {cs.bill_ref} - <code title={cs.content_hash}>{shortHash(cs.content_hash)}</code> (v{cs.version})</p>
      {cs.findings && cs.findings.length > 0 && <ul className="list-disc pl-5 text-sm" data-testid="dept-findings">{cs.findings.map((f, i) => <li key={i}>{f.where}: {f.text}</li>)}</ul>}
      <div className="flex flex-wrap gap-2">
        {cs.status === "draft" && <Btn secondary data-testid="dept-edit" onClick={onEdit}>{c("ed.edit")}</Btn>}
        {cs.status === "draft" && cs.registered_at === null && <Btn data-testid="dept-submit" disabled={a.busy} onClick={() => void a.act(() => consApi.submit(cs.id), c("dept.submitted"))}>{c("ed.submit")}</Btn>}
        {cs.status === "approved" && <Btn data-testid="dept-publish" disabled={a.busy} onClick={() => void a.act(() => consApi.publish(cs.id), c("dept.published"))}>{c("dept.publish")}</Btn>}
        {cs.status === "open" && <Btn secondary data-testid="dept-close" disabled={a.busy} onClick={() => void a.act(() => consApi.close(cs.id), c("dept.closed"))}>{c("dept.close")}</Btn>}
        {cs.status === "closed" && cs.closing_report.status === "published" && <Btn data-testid="dept-complete" disabled={a.busy} onClick={() => void a.act(() => consApi.complete(cs.id), c("dept.completed"))}>{c("dept.complete")}</Btn>}
        {cs.status !== "draft" && <a className={linkCls + " min-h-[44px] inline-flex items-center"} href={`#/consultations/${cs.id}`}>{c("a.details")}</a>}
      </div>
      <ErrorLine msg={a.err} />
      {a.note && <p role="status" className="text-sm font-bold" data-testid="dept-note">{a.note}</p>}
      {cs.status === "draft" && cs.registered_at !== null && <p className="text-sm" data-testid="dept-returned">{c("dept.returned")}</p>}
      {cs.status !== "completed" && <AudioUploads cs={cs} reload={reload} />}
      {(cs.status === "approved" || cs.status === "open") && <CorrectionForm cs={cs} reload={reload} />}
      {cs.status === "closed" && <ClosingTools cs={cs} reload={reload} canPublish={canPublish} />}
    </li>
  );
}

function DeptSection({ admin, canPublish }: { admin: boolean; canPublish: boolean }) {
  const c = useConsT();
  const q = useLoad(() => consApi.mineDept(), []);
  const [edit, setEdit] = useState<{ cs: ConsDetail | null } | null>(null);
  if (edit) return <DraftEditor key={edit.cs?.id ?? "new"} initial={edit.cs} admin={admin} onDone={() => { setEdit(null); q.reload(); }} onCancel={() => { setEdit(null); q.reload(); }} />;
  return (
    <section className="space-y-3" data-testid="dept-section" aria-labelledby="dept-h">
      <h2 id="dept-h" className="text-xl font-bold">{c("dept.title")}</h2>
      <p className="text-sm">{c("dept.intro")}</p>
      <Btn data-testid="dept-new" onClick={() => setEdit({ cs: null })}>{c("ed.new")}</Btn>
      {q.loading && !q.data && <p role="status">{c("loading")}</p>}
      {q.error && <p role="alert" data-testid="dept-denied" className="font-bold text-sm">{c("dept.denied")}</p>}
      <ul className="space-y-3" data-testid="dept-list">{(q.data?.consultations ?? []).map((cs) => <DeptItem key={cs.id} cs={cs} reload={q.reload} onEdit={() => setEdit({ cs })} canPublish={canPublish} />)}</ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

/** A closed header per consultation: the detail (clauses, decisions, audio) is fetched only when a reviewer opens it, so a long list never floods the server. */
function PanelCard({ sum, reload }: Keyed & { sum: ConsSummary; reload: () => void }) {
  const c = useConsT();
  const { lang } = useT();
  const [open, setOpen] = useState(false);
  if (open) return <PanelCardOpen sum={sum} reload={reload} />;
  return (
    <li className={card} data-testid="panel-item" data-cons-id={sum.id} data-status={sum.status}>
      <div className="flex flex-wrap items-center gap-2"><StatusBadge status={sum.status} /><ClosingBadge cr={sum.closing_report} /></div>
      <h3 className="text-lg font-bold break-words">{titleOf(sum, lang)}</h3>
      <p className="text-sm">{sum.department} - {sum.bill_ref}</p>
      <Btn secondary data-testid="panel-toggle" onClick={() => setOpen(true)}>{c("pan.open")}</Btn>
    </li>
  );
}

const diffText = (v: unknown): string => { const t = typeof v === "string" ? v : JSON.stringify(v ?? null); return t.length > 400 ? t.slice(0, 400) + "..." : t; };

/** The per-clause difference of a correction, so a reviewer decides on the change itself. */
function DiffList({ diff }: { diff: ClauseDiff[] }) {
  const c = useConsT();
  return (
    <div className="space-y-1" data-testid="panel-corr-diff">
      <h5 className="font-bold text-sm">{c("diff.title")}</h5>
      {diff.length === 0 ? <p className="text-sm">{c("diff.none")}</p> : (
        <ul className="space-y-2">{diff.map((d, i) => (
          <li key={i} className="text-sm border border-black/30 p-2" data-testid="diff-item" data-clause={d.clause} data-field={d.field}>
            <strong>{c("diff.line", { n: d.clause, field: c(`diff.${d.field}` as ConsKey) })}</strong>
            <p className="break-words"><span className="font-bold">{c("diff.before")}: </span><span data-testid="diff-before">{diffText(d.before)}</span></p>
            <p className="break-words"><span className="font-bold">{c("diff.after")}: </span><span data-testid="diff-after">{diffText(d.after)}</span></p>
          </li>))}</ul>)}
    </div>
  );
}

function PanelCardOpen({ sum }: Keyed & { sum: ConsSummary; reload: () => void }) {
  const c = useConsT();
  const { lang } = useT();
  const det = useLoad(() => consApi.get(sum.id), [sum.id, sum.version, sum.status]);
  const status = det.data?.status;
  const corrs = useLoad(() => (status && status !== "in_review" ? consApi.corrections(sum.id, "pending").then((r) => r.corrections) : Promise.resolve([] as CorrectionRow[])), [sum.id, det.data?.version, status]);
  const a = useAct(() => { det.reload(); corrs.reload(); }); // the list is not reloaded: a returned draft leaves the public list but its decision note stays visible
  const [notes, setNotes] = useState(""), [picked, setPicked] = useState("");
  const cs = det.data;
  if (!cs) return <li className={card}><p role="status">{c("loading")}</p></li>;
  const pending = corrs.data ?? [];
  const chosen = cs.status === "in_review" ? undefined : pending.find((x) => x.id === picked) ?? pending[0];
  const corr = chosen?.id ?? "";
  const recorded = cs.clauses.flatMap((cl) => cl.audio.filter((x) => x.status === "recorded").map((x) => ({ n: cl.n, group: x.group })));
  return (
    <li className={card} data-testid="panel-item" data-cons-id={cs.id} data-status={cs.status}>
      <div className="flex flex-wrap items-center gap-2"><StatusBadge status={cs.status} /><ClosingBadge cr={cs.closing_report} /></div>
      <h3 className="text-lg font-bold break-words">{titleOf(cs, lang)}</h3>
      <p className="text-sm">{cs.department} - {cs.bill_ref} - <code title={cs.content_hash}>{shortHash(cs.content_hash)}</code></p>
      <p className="text-sm" data-testid="panel-count">{c("pan.summary", { a: cs.panel.approvals, n: cs.panel.required_approvals })}</p>
      <ul className="text-sm space-y-1">{cs.panel.decisions.map((d, i) => <li key={i} data-testid="panel-decision">{d.decision === "approve" ? c("pan.approve") : c("pan.reject")} v{d.version}{d.notes ? `: ${d.notes}` : ""}</li>)}</ul>
      <a className={linkCls + " min-h-[44px] inline-flex items-center"} href={`#/consultations/${cs.id}`} data-testid="panel-open">{c("pan.read")}</a>
      {(cs.status === "in_review" || cs.status === "approved" || cs.status === "open") && (
        <form className="space-y-2 border border-black/30 p-3" data-testid="panel-form" onSubmit={(e) => e.preventDefault()}>
          <label className="text-sm font-bold block">{c("pan.notes")}<textarea data-testid="panel-notes" className={inputCls + " font-normal"} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          {cs.status !== "in_review" && (pending.length === 0 ? <p className="text-sm" data-testid="panel-corr-none">{c("pan.corrNone")}</p> : (
            <div className="space-y-2" data-testid="panel-corr-box">
              <label className="text-sm font-bold block">{c("pan.corrPick")}
                <select data-testid="panel-corr" className={inputCls + " font-normal"} value={corr} onChange={(e) => setPicked(e.target.value)}>
                  {pending.map((x) => <option key={x.id} value={x.id}>{c("pan.corrOption", { a: x.from_version, b: x.to_version, reason: x.reason_en })}</option>)}
                </select></label>
              {chosen && <><p className="text-xs" data-testid="panel-corr-approvals">{c("pan.corrApprovals", { n: chosen.approvals })}</p><DiffList diff={chosen.diff} /></>}
            </div>))}
          <div className="flex flex-wrap gap-2">
            <Btn data-testid="panel-approve" disabled={a.busy || (cs.status !== "in_review" && !corr)} onClick={() => void a.act(() => consApi.review(cs.id, "approve", notes, corr.trim() || undefined), c("pan.done"))}>{c("pan.approve")}</Btn>
            <Btn secondary data-testid="panel-reject" disabled={a.busy || (cs.status !== "in_review" && !corr)} onClick={() => void a.act(() => consApi.review(cs.id, "reject", notes, corr.trim() || undefined), c("pan.done"))}>{c("pan.reject")}</Btn>
          </div>
        </form>
      )}
      {recorded.length > 0 && (
        <div className="space-y-1" data-testid="panel-audio">
          <h4 className="font-bold text-sm">{c("pan.audio")}</h4>
          {recorded.map((r) => <Btn key={r.n + r.group} secondary data-testid="panel-audio-review" disabled={a.busy} onClick={() => void a.act(() => consApi.reviewAudio(cs.id, r.n, r.group), c("pan.audioDone"))}>{c("pan.markAudio", { n: r.n, g: r.group })}</Btn>)}
        </div>
      )}
      {cs.status === "closed" && cs.closing_report.status !== "published" && (
        <Btn data-testid="panel-publish-report" disabled={a.busy} onClick={() => void a.act(() => consApi.publishReport(cs.id), c("prev.published"))}>{c("prev.publish")}</Btn>
      )}
      <ErrorLine msg={a.err} />
      {a.note && <p role="status" className="text-sm font-bold" data-testid="panel-note">{a.note}</p>}
    </li>
  );
}

function PanelSection() {
  const c = useConsT();
  // One request (the newest 100), filtered here: the registry list is rate-limited per address.
  const q = useLoad(async () => (await consApi.list({ limit: 100 })).consultations.filter((x) => x.status !== "completed").slice(0, 30), []);
  return (
    <section className="space-y-3" data-testid="panel-section" aria-labelledby="panel-h">
      <h2 id="panel-h" className="text-xl font-bold">{c("pan.sectionTitle")}</h2>
      <p className="text-sm">{c("pan.intro")}</p>
      {q.loading && !q.data && <p role="status">{c("loading")}</p>}
      <ErrorLine msg={q.error ? c("err.load") : null} />
      {q.error && <Btn secondary data-testid="panel-retry" onClick={q.reload}>{c("retry")}</Btn>}
      <ul className="space-y-3" data-testid="panel-list">{(q.data ?? []).map((s) => <PanelCard key={s.id} sum={s} reload={q.reload} />)}</ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Moderation: held comments with their feedback ids, released or rejected through the moderate route
// ---------------------------------------------------------------------------------------------

function HeldItem({ cid, h, reload }: Keyed & { cid: string; h: HeldComment; reload: () => void }) {
  const c = useConsT();
  const a = useAct(reload);
  return (
    <li className={card} data-testid="held-item" data-feedback-id={h.feedback_id}>
      <p className="text-sm font-bold">{c("mod.clause", { n: h.clause, s: h.stance })}</p>
      <blockquote className="border-l-4 border-black pl-2 whitespace-pre-line break-words text-sm" data-testid="held-text">{h.comment}</blockquote>
      {h.reasons.length > 0 && <p className="text-xs">{c("mod.reasons", { r: h.reasons.join(", ") })}</p>}
      <div className="flex flex-wrap gap-2">
        <Btn data-testid="held-release" disabled={a.busy} onClick={() => void a.act(() => consApi.moderate(cid, h.feedback_id, "release"), c("mod.released"))}>{c("mod.release")}</Btn>
        <Btn secondary data-testid="held-reject" disabled={a.busy} onClick={() => void a.act(() => consApi.moderate(cid, h.feedback_id, "reject"), c("mod.rejected"))}>{c("mod.reject")}</Btn>
      </div>
      <ErrorLine msg={a.err} />
      {a.note && <p role="status" className="text-sm font-bold" data-testid="held-note">{a.note}</p>}
    </li>
  );
}

function HeldQueue({ cid }: Keyed & { cid: string }) {
  const c = useConsT();
  const q = useLoad(() => consApi.held(cid), [cid]);
  const msg = useErrMsg();
  if (q.loading && !q.data) return <p role="status">{c("loading")}</p>;
  if (q.error) return <ErrorLine msg={msg(q.error)} />;
  const list = q.data?.comments ?? [];
  return list.length === 0 ? <p className="text-sm" data-testid="held-empty">{c("mod.none")}</p> : (
    <>
      <p className="text-sm font-bold" data-testid="held-count">{c("mod.count", { n: list.length })}</p>
      <ul className="space-y-3" data-testid="held-list">{list.map((h) => <HeldItem key={h.feedback_id} cid={cid} h={h} reload={q.reload} />)}</ul>
    </>
  );
}

function ModerationSection() {
  const c = useConsT();
  const { lang } = useT();
  const q = useLoad(async () => (await consApi.list({ limit: 100 })).consultations.slice(0, 50), []);
  const [pick, setPick] = useState("");
  return (
    <section className="space-y-3" data-testid="mod-section" aria-labelledby="mod-h">
      <h2 id="mod-h" className="text-xl font-bold">{c("mod.title")}</h2>
      <p className="text-sm">{c("mod.intro")}</p>
      {q.loading && !q.data && <p role="status">{c("loading")}</p>}
      <ErrorLine msg={q.error ? c("err.load") : null} />
      <label className="text-sm font-bold block">{c("mod.pick")}
        <select data-testid="mod-pick" className={inputCls + " font-normal"} value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">{c("mod.choose")}</option>
          {(q.data ?? []).map((x) => <option key={x.id} value={x.id}>{titleOf(x, lang)}</option>)}
        </select></label>
      {pick && <HeldQueue key={pick} cid={pick} />}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Department: recording uploads (the server sniffs the type; a recording is public only after a panel review)
// ---------------------------------------------------------------------------------------------

function AudioUpload({ cs, n, audio, reload }: Keyed & { cs: ConsDetail; n: number; audio: { group: string; status: string } ; reload: () => void }) {
  const c = useConsT();
  const a = useAct(reload);
  const [file, setFile] = useState<File | null>(null);
  const id = `au-${cs.id}-${n}-${audio.group}`;
  if (audio.status === "reviewed") return <li className="text-sm" data-testid="aud-locked" data-group={audio.group}>{c("cl.n", { n })}, {audio.group}: {c("aud.up.locked")}</li>;
  return (
    <li className="space-y-1" data-testid="aud-item" data-clause={n} data-group={audio.group}>
      <label htmlFor={id} className="text-sm font-bold block">{c("aud.up.file", { n, g: audio.group })}</label>
      <input id={id} type="file" accept="audio/*" data-testid="aud-file" className={inputCls + " font-normal"} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <Btn secondary data-testid="aud-upload" disabled={a.busy} onClick={() => { if (!file) { a.setErr(c("aud.up.choose")); return; } void a.act(() => consApi.uploadAudio(cs.id, n, audio.group, file), c("aud.up.done")); }}>{c("aud.up.btn")}</Btn>
      <ErrorLine msg={a.err} />
      {a.note && <p role="status" className="text-sm font-bold" data-testid="aud-note">{a.note}</p>}
    </li>
  );
}

function AudioUploads({ cs, reload }: Keyed & { cs: ConsDetail; reload: () => void }) {
  const c = useConsT();
  const items = cs.clauses.flatMap((cl) => cl.audio.filter((x) => !!x.file_id).map((x) => ({ n: cl.n, audio: x })));
  if (items.length === 0 || cs.status === "completed") return null;
  return (
    <details className="border border-black/30 p-3" data-testid="aud-box">
      <summary className="font-bold cursor-pointer min-h-[44px] flex items-center">{c("aud.up.title")}</summary>
      <p className="text-sm my-2">{c("aud.up.help")}</p>
      <ul className="space-y-3">{items.map((x) => <AudioUpload key={x.n + x.audio.group} cs={cs} n={x.n} audio={x.audio} reload={reload} />)}</ul>
    </details>
  );
}

export function ConsolePage() {
  const c = useConsT();
  const me = useMe();
  const has = (r: string) => me.roles.includes(r);
  const dept = has("officer") || has("admin"), panel = has("survey_panel") || has("admin"), mod = has("moderator") || has("admin");
  let body: ReactNode;
  if (me.loading) body = <p role="status">{c("loading")}</p>;
  else if (!me.signedIn) body = <p role="alert" data-testid="console-401" className="font-bold">{c("err.401")}</p>;
  else if (!dept && !panel && !mod) body = <p role="alert" data-testid="console-403" className="font-bold">{c("console.noRole")}</p>;
  else body = <>{dept && <DeptSection admin={has("admin")} canPublish={panel} />}{panel && <PanelSection />}{mod && <ModerationSection />}</>;
  return (
    <Page title={c("console.title")} back={{ label: c("nav.registry"), to: "#/consultations" }}>
      <p className="text-sm max-w-2xl">{c("console.intro")}</p>
      {body}
    </Page>
  );
}
