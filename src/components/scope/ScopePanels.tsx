import { useCallback, useEffect, useState, type ReactNode } from "react";
import { scopeApi, ScopeError, type AuditSummary, type IssuesSummary, type ScopeMe, type SurveysSummary, type TreeUnit } from "../../api/scope";
import { useT } from "../../i18n";
import { Btn, Field, TextInput, inputCls } from "../civic/ui";
import { ShedNotice } from "../DegradedBanner";
import { useScopeT, type ScopeKey } from "./scopeText";

export type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "error"; error: ScopeError };
const asErr = (e: unknown): ScopeError => (e instanceof ScopeError ? e : new ScopeError(0, "error"));

/** Load from the server; the server's answer (data or refusal) is the only thing shown. */
export function useScoped<T>(load: () => Promise<T>, deps: unknown[]): { load: Load<T>; reload: () => void } {
  const [st, setSt] = useState<Load<T>>({ state: "loading" });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setSt((s) => (s.state === "ok" ? s : { state: "loading" }));
    load().then((data) => { if (live) setSt({ state: "ok", data }); }, (e) => { if (live) setSt({ state: "error", error: asErr(e) }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { load: st, reload: useCallback(() => setN((x) => x + 1), []) };
}

/** Clear EN/TE explanation of a refusal (401/403/405/429/503), by the server's machine code. */
export function ScopeErrorView({ error, onRetry }: { error: ScopeError; onRetry?: () => void }) {
  const s = useScopeT();
  if (error.shed) return <ShedNotice shed={error.shed} onRetry={onRetry} testid="scope-shed" />;
  const key = (error.code === "unauthenticated" ? "sc.err.401" : `sc.err.${error.code}`) as ScopeKey;
  return (
    <div role="alert" data-testid={`scope-err-${error.code}`} data-status={error.status} className="border-2 border-black p-3 text-sm space-y-2">
      <p className="font-bold">{s(key, { n: error.retryAfter ?? 60 })}</p>
      {onRetry && error.code !== "outside_scope" && error.code !== "department_mismatch" && error.code !== "role_required" && <Btn secondary onClick={onRetry}>{s("sc.retry")}</Btn>}
    </div>
  );
}

const Loading = () => { const s = useScopeT(); return <p role="status" data-testid="scope-loading" className="text-sm">{s("sc.loading")}</p>; };
const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section data-testid={`panel-${id}`} aria-labelledby={`h-${id}`} className="space-y-3"><h3 id={`h-${id}`} className="text-lg font-bold">{title}</h3>{children}</section>
);
const th = "p-2 text-left font-bold";
const td = "p-2 border-t border-black/10";

// ---------------------------------------------------------------------------------------------
export function IssuesPanel({ me }: { me: ScopeMe }) {
  const s = useScopeT();
  const { lang } = useT();
  const [unit, setUnit] = useState("");
  const [dept, setDept] = useState("");
  const [deptDraft, setDeptDraft] = useState("");
  const { load, reload } = useScoped<IssuesSummary>(() => scopeApi.issues(unit, dept), [unit, dept]);
  const name = (u: { name_en: string; name_te?: string | null } | null) => (u ? (lang === "te" && u.name_te ? u.name_te : u.name_en) : s("sc.iss.state"));
  const own = me.roles.filter((r) => r.unit && ["politician", "officer", "journalist", "admin"].includes(r.role));
  return (
    <Section id="issues" title={s("sc.iss.title")}>
      <div className="space-y-3 border border-black/30 p-3">
        <div className="flex flex-wrap gap-2 items-end">
          <Btn secondary data-testid="iss-own" onClick={() => setUnit("")}>{s("sc.iss.own")}</Btn>
          {own.map((r) => <Btn key={`${r.role}-${r.unit!.lgd}`} secondary data-testid="iss-own-unit" onClick={() => setUnit(r.unit!.lgd)}>{name(r.unit)}</Btn>)}
        </div>
        <UnitTree onPick={setUnit} />
        <form className="flex flex-wrap gap-2 items-end" onSubmit={(e) => { e.preventDefault(); setDept(deptDraft.trim()); }}>
          <Field id="iss-dept" label={s("sc.iss.dept")}><TextInput id="iss-dept" data-testid="iss-dept" value={deptDraft} onChange={(e) => setDeptDraft(e.target.value)} className={inputCls} /></Field>
          <Btn secondary type="submit" data-testid="iss-dept-apply">{s("sc.iss.apply")}</Btn>
        </form>
      </div>
      {load.state === "loading" && <Loading />}
      {load.state === "error" && <ScopeErrorView error={load.error} onRetry={reload} />}
      {load.state === "ok" && <IssuesTable d={load.data} name={name} />}
    </Section>
  );
}

/** District -> mandal -> village (or the unit a scoped role holds), one level at a time. Every unit listed comes from the server's scope check. */
function UnitTree({ onPick }: { onPick: (lgd: string) => void }) {
  const s = useScopeT();
  const { lang } = useT();
  const [path, setPath] = useState<TreeUnit[]>([]);
  const parent = path.length ? path[path.length - 1].lgd : undefined;
  const { load, reload } = useScoped(() => scopeApi.units(parent), [parent]);
  const nm = (u: { name_en: string; name_te?: string | null }) => (lang === "te" && u.name_te ? u.name_te : u.name_en);
  return (
    <section aria-labelledby="tree-h" className="space-y-2" data-testid="unit-tree">
      <h4 id="tree-h" className="font-bold text-sm">{s("sc.tree.title")}</h4>
      <p className="text-xs">{s("sc.tree.hint")}</p>
      <nav aria-label={s("sc.tree.path")}>
        <ol className="flex flex-wrap gap-1 items-center text-sm" data-testid="tree-path">
          <li><Btn secondary data-testid="tree-root" onClick={() => setPath([])}>{s("sc.tree.root")}</Btn></li>
          {path.map((u, i) => <li key={u.lgd}><Btn secondary data-testid="tree-crumb" data-lgd={u.lgd} aria-current={i === path.length - 1 ? "location" : undefined} onClick={() => setPath(path.slice(0, i + 1))}>{nm(u)}</Btn></li>)}
        </ol>
      </nav>
      {load.state === "loading" && <p role="status" data-testid="tree-loading" className="text-sm">{s("sc.tree.loading")}</p>}
      {load.state === "error" && <ScopeErrorView error={load.error} onRetry={reload} />}
      {load.state === "ok" && (load.data.units.length === 0 ? <p className="text-sm" data-testid="tree-none">{s("sc.tree.none")}</p> : (
        <>
          <ul className="space-y-1" data-testid="tree-units" data-parent={load.data.parent?.lgd ?? ""}>{load.data.units.map((u) => (
            <li key={u.lgd} className="flex flex-wrap items-center gap-2 text-sm" data-testid="tree-unit" data-lgd={u.lgd} data-level={u.level}>
              <span className="font-bold">{nm(u)}</span><span className="text-xs">({s(`sc.lvl.${u.level}` as ScopeKey)})</span>
              {u.has_children && <Btn secondary data-testid="tree-open" onClick={() => setPath([...path, u])}>{s("sc.tree.open")}</Btn>}
              <Btn secondary data-testid="iss-pick" data-lgd={u.lgd} onClick={() => onPick(u.lgd)}>{s("sc.tree.show")}</Btn>
            </li>))}</ul>
          {load.data.truncated && <p className="text-xs" data-testid="tree-more">{s("sc.tree.more", { n: load.data.units.length })}</p>}
        </>))}
    </section>
  );
}

function IssuesTable({ d, name }: { d: IssuesSummary; name: (u: { name_en: string; name_te?: string | null } | null) => string }) {
  const s = useScopeT();
  return (
    <div className="space-y-3" data-testid="issues-result" data-unit={d.unit?.lgd ?? ""}>
      <p className="text-sm font-bold" data-testid="issues-showing">{s("sc.iss.showing", { unit: name(d.unit) })}{d.department ? ` | ${d.department}` : ""}</p>
      {d.cells.length === 0 ? <p data-testid="issues-empty" className="text-sm">{s("sc.iss.empty")}</p> : (
        <div className="overflow-x-auto"><table className="w-full text-xs border border-black/30" data-testid="issues-cells">
          <thead><tr className="bg-black/5"><th className={th}>{s("sc.iss.dep")}</th><th className={th}>{s("sc.iss.total")}</th><th className={th}>{s("sc.iss.open")}</th><th className={th}>{s("sc.iss.resolved")}</th><th className={th}>{s("sc.iss.rate")}</th></tr></thead>
          <tbody>{d.cells.map((c) => <tr key={c.department} data-testid="issues-cell"><td className={td}>{c.department}</td><td className={td}>{c.total}</td><td className={td}>{c.open}</td><td className={td}>{c.resolved}</td><td className={td}>{Math.round(c.resolution_rate * 100)}%</td></tr>)}</tbody>
        </table></div>)}
      {d.masked.length > 0 && <p data-testid="issues-masked" className="text-xs border border-dashed border-black p-2">{s("sc.iss.masked", { n: d.min_cell, names: d.masked.map((m) => m.department).join(", ") })}</p>}
      <p className="text-xs" data-testid="issues-sum">{s("sc.iss.sum", { n: d.total_shown })}</p>
      {d.truncated && <p role="note" data-testid="issues-truncated" className="text-xs font-bold border border-black p-2">{s("sc.iss.trunc")}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
export function SurveysPanel() {
  const s = useScopeT();
  const { lang } = useT();
  const { load, reload } = useScoped<SurveysSummary>(() => scopeApi.surveys(), []);
  return (
    <Section id="surveys" title={s("sc.sv.title")}>
      <p role="note" data-testid="surveys-same" className="text-sm border border-black p-2">{s("sc.sv.same")}</p>
      {load.state === "loading" && <Loading />}
      {load.state === "error" && <ScopeErrorView error={load.error} onRetry={reload} />}
      {load.state === "ok" && (<>
        <p className="text-xs" data-testid="surveys-note">{lang === "te" ? load.data.note_te : load.data.note_en}</p>
        {load.data.published.length === 0 ? <p data-testid="surveys-empty" className="text-sm">{s("sc.sv.empty")}</p> : (
          <div className="overflow-x-auto"><table className="w-full text-xs border border-black/30" data-testid="surveys-list">
            <thead><tr className="bg-black/5"><th className={th}>{s("sc.sv.topic")}</th><th className={th}>{s("sc.sv.state")}</th><th className={th}>{s("sc.sv.at")}</th><th className={th}>{s("sc.sv.hash")}</th><th className={th}><span className="sr-only">{s("sc.sv.open")}</span></th></tr></thead>
            <tbody>{load.data.published.map((p) => (
              <tr key={p.survey_id} data-testid="survey-row">
                <td className={td}>{p.topic_class}</td><td className={td}>{p.state}</td><td className={td}>{p.published_at.slice(0, 10)}</td><td className={`${td} font-mono`}>{p.snapshot_sha256.slice(0, 12)}</td>
                <td className={td}><a data-testid="survey-figures-link" className="underline font-bold text-blue-900 inline-flex items-center min-h-[44px]" href={`#/surveys/${encodeURIComponent(p.survey_id)}/figures`}>{s("sc.sv.open")}</a></td>
              </tr>))}</tbody>
          </table></div>)}
      </>)}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
export function AuditPanel() {
  const s = useScopeT();
  const { load, reload } = useScoped<AuditSummary>(() => scopeApi.audit(), []);
  const yn = (v: boolean | null) => (v === null ? s("sc.unknown") : v ? s("sc.yes") : s("sc.no"));
  return (
    <Section id="audit" title={s("sc.au.title")}>
      {load.state === "loading" && <Loading />}
      {load.state === "error" && <ScopeErrorView error={load.error} onRetry={reload} />}
      {load.state === "ok" && (() => {
        const d = load.data;
        const alarm = !d.anchors.chain_ok || d.anchors.anchor_matches_chain === false || !!d.jobs.alarm;
        return (
          <div className="space-y-4">
            {alarm
              ? <p role="alert" data-testid="audit-alarm" data-alarm="1" className="border-4 border-double border-red-800 bg-red-50 text-red-900 p-3 font-bold text-sm">{s("sc.au.alarm")}</p>
              : <p role="status" data-testid="audit-ok" data-alarm="0" className="border border-black p-2 text-sm">{s("sc.au.ok")}</p>}
            <div data-testid="audit-head" className="text-xs space-y-1"><h4 className="font-bold text-sm">{s("sc.au.head")}</h4>
              {d.head ? <p>{s("sc.au.seq")} {d.head.seq} | {s("sc.au.count")} {d.head.count} | {s("sc.au.ts")} {d.head.ts} | {s("sc.au.hash")} <span className="font-mono break-all">{d.head.hash}</span></p> : <p>{s("sc.au.none")}</p>}</div>
            <div data-testid="audit-anchors" className="text-xs space-y-1"><h4 className="font-bold text-sm">{s("sc.au.anchors")}</h4>
              <p>{s("sc.au.sink")}: {d.anchors.sink ?? s("sc.au.none")} | {s("sc.au.chain")}: {yn(d.anchors.chain_ok)} | {s("sc.au.matches")}: {yn(d.anchors.anchor_matches_chain)} | {s("sc.au.unanchored")}: {d.anchors.unanchored_entries}</p></div>
            <div data-testid="audit-jobs" className="text-xs space-y-1"><h4 className="font-bold text-sm">{s("sc.au.jobs")}</h4>
              {d.jobs.alarm && <p role="alert" className="font-bold text-red-900" data-testid="audit-job-alarm">{s("sc.au.jobAlarm")}: {d.jobs.alarm.kind} ({d.jobs.alarm.at})</p>}
              {d.jobs.jobs.length === 0 ? <p>{s("sc.au.none")}</p> : (
                <div className="overflow-x-auto"><table className="w-full border border-black/30"><thead><tr className="bg-black/5"><th className={th}>Job</th><th className={th}>{s("sc.au.runs")}</th><th className={th}>{s("sc.au.fails")}</th><th className={th}>{s("sc.au.lastOk")}</th></tr></thead>
                  <tbody>{d.jobs.jobs.map((j) => <tr key={j.name}><td className={td}>{j.name}</td><td className={td}>{j.runs}</td><td className={td}>{j.failures}</td><td className={td}>{yn(j.lastOk)}</td></tr>)}</tbody></table></div>)}</div>
            <div data-testid="audit-blocks" className="text-xs space-y-1"><h4 className="font-bold text-sm">{s("sc.au.blocks")}</h4><p>{s("sc.au.blocksTotal", { n: d.block_log.total })}</p>
              {d.block_log.by_action.length > 0 && <ul className="list-disc pl-5">{d.block_log.by_action.map((b) => <li key={b.action}>{b.action}: {b.n}</li>)}</ul>}</div>
          </div>
        );
      })()}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
export function ExportPanel() {
  const s = useScopeT();
  const [format, setFormat] = useState<"ndjson" | "csv">("ndjson");
  const [cursor, setCursor] = useState<string | null>(null);
  const [part, setPart] = useState(0);
  const [done, setDone] = useState<{ n: number; name: string; last: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ScopeError | null>(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await scopeApi.exportPart(format, cursor ?? undefined);
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement("a"); a.href = url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setPart((n) => n + 1); setCursor(r.nextCursor); setDone({ n: part + 1, name: r.filename, last: !r.nextCursor });
    } catch (e) { setErr(asErr(e)); } finally { setBusy(false); }
  };
  return (
    <Section id="export" title={s("sc.ex.title")}>
      <p role="note" data-testid="export-same" className="text-sm border border-black p-2">{s("sc.ex.same")}</p>
      <div className="flex flex-wrap gap-3 items-end">
        <Field id="ex-format" label={s("sc.ex.format")}>
          <select id="ex-format" data-testid="export-format" className={inputCls} value={format} disabled={busy || !!cursor} onChange={(e) => { setFormat(e.target.value as "ndjson" | "csv"); setPart(0); setDone(null); }}>
            <option value="ndjson">NDJSON</option><option value="csv">CSV</option>
          </select>
        </Field>
        <Btn data-testid="export-download" disabled={busy} onClick={() => void run()}>{cursor ? s("sc.ex.next") : s("sc.ex.first")}</Btn>
      </div>
      {busy && <p role="status" className="text-sm">{s("sc.ex.busy")}</p>}
      {done && <p role="status" data-testid="export-done" data-part={done.n} data-has-next={cursor ? "1" : "0"} className="text-sm">{s("sc.ex.done", { n: done.n, name: done.name })} {done.last ? s("sc.ex.last") : s("sc.ex.more")}</p>}
      {err && <ScopeErrorView error={err} onRetry={() => setErr(null)} />}
    </Section>
  );
}
