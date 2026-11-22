import { useCallback, useEffect, useState } from "react";
import { CivicApiError, issuesApi, type HeldReport, type ModDecision, type ModMetricsFull, type ModQueue, type ModQueueStatus } from "../../../api/civic";
import { useT } from "../../../i18n";
import { useCategories } from "../categories";
import { useCivicT, type CivicKey } from "../civicText";
import { Btn, ErrorNote, Field, TextInput, inputCls } from "../ui";
import { Gate, actionError, errCode, pct, stateOf, useGuarded, type LoadState } from "./shared";

const STATUSES: { id: ModQueueStatus; key: CivicKey }[] = [{ id: "held", key: "c.mod.sHeld" }, { id: "escalated", key: "c.mod.sEscalated" }, { id: "taken_down", key: "c.mod.sTakenDown" }];

/** S-142: held reports with the rule-id reasons, approve / reject / uphold / escalate, appeals, and the hold-rate and false-positive metrics. */
export function ModerationQueue() {
  const c = useCivicT();
  const { lang } = useT();
  const { label } = useCategories();
  const [status, setStatus] = useState<ModQueueStatus>("held");
  const [items, setItems] = useState<HeldReport[]>([]);
  const [page, setPage] = useState<ModQueue | null>(null);
  const [full, setFull] = useState<ModMetricsFull | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async (s: ModQueueStatus) => {
    try {
      const q = await issuesApi.moderationQueue({ status: s });
      setPage(q); setItems(q.items); setState("ok");
      issuesApi.moderationMetrics().then(setFull).catch(() => setFull(null));
    } catch (e) { setState(stateOf(e)); }
  }, []);
  useEffect(() => { void load(status); }, [status, load]);
  const more = async () => {
    if (!page?.nextCursor) return;
    try { const q = await issuesApi.moderationQueue({ status, cursor: page.nextCursor }); setPage(q); setItems((cur) => [...cur, ...q.items.filter((i) => !cur.some((x) => x.id === i.id))]); } catch (e) { setErr(actionError(e, c)); }
  };
  const decide = async (id: string, d: ModDecision) => {
    setMsg(null); setErr(null);
    try { await issuesApi.moderate(id, d); setMsg(c("c.mod.decided")); void load(status); }
    catch (e) { setErr(e instanceof CivicApiError && errCode(e) === "admin_required" ? c("c.mod.adminRequired") : e instanceof CivicApiError && e.status === 403 && /escalated/i.test(e.message) ? c("c.mod.adminRequired") : actionError(e, c)); }
  };
  const m = page?.metrics;
  const text = (r: HeldReport) => (lang === "te" ? r.textTe ?? r.text : r.text ?? r.textTe);
  return (
    <section data-testid="mod-queue" aria-labelledby="mq-h" className="space-y-3">
      <h4 id="mq-h" className="font-bold">{c("c.mod.queue")}</h4>
      <Gate state={state} onRetry={() => void load(status)}>
        <Field id="mq-status" label={c("c.mod.status")}>
          <select id="mq-status" data-testid="mq-status" className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as ModQueueStatus)}>{STATUSES.map((s) => <option key={s.id} value={s.id}>{c(s.key)}</option>)}</select>
        </Field>
        <dl data-testid="mod-metrics" aria-label={c("c.mod.metrics")} className="grid grid-cols-2 gap-2 text-sm">
          <div className="border border-black p-2"><dt>{c("c.mod.holdRate")}</dt><dd data-testid="mod-hold-rate" className="font-bold text-lg">{pct(m?.holdRate)}</dd></div>
          <div className="border border-black p-2"><dt>{c("c.mod.fpRate")}</dt><dd data-testid="mod-fp-rate" className="font-bold text-lg">{pct(m?.falsePositiveRate)}</dd></div>
          {m?.held !== undefined && <div className="border border-black p-2"><dt>{c("c.mod.held")}</dt><dd className="font-bold">{m.held}</dd></div>}
          {m?.total !== undefined && <div className="border border-black p-2"><dt>{c("c.mod.total")}</dt><dd className="font-bold">{m.total}</dd></div>}
          {full?.appeals && <div className="border border-black p-2"><dt>{c("c.mod.appealsPending")}</dt><dd data-testid="mod-appeals-pending" className="font-bold">{full.appeals.pending}</dd></div>}
          {full?.appeals?.medianHours != null && <div className="border border-black p-2"><dt>{c("c.mod.appealHours")}</dt><dd className="font-bold">{full.appeals.medianHours}</dd></div>}
          {full?.lexiconVersion !== undefined && <div className="border border-black p-2"><dt>{c("c.mod.lexVersion")}</dt><dd data-testid="mod-lex-version" className="font-bold">{full.lexiconVersion}</dd></div>}
          {page?.waitingHoursOldest !== undefined && page.waitingHoursOldest > 0 && <div className="border border-black p-2"><dt>{c("c.mod.waiting")}</dt><dd className="font-bold">{page.waitingHoursOldest}</dd></div>}
        </dl>
        {full && Object.keys(full.heldByRule).length > 0 && (
          <p className="text-xs" data-testid="mod-by-rule"><strong>{c("c.mod.heldByRule")}:</strong> {Object.entries(full.heldByRule).map(([k, v]) => `${k} ${v}`).join(", ")}</p>
        )}
        {state === "ok" && items.length === 0 && <p className="text-sm">{c("c.mod.empty")}</p>}
        <ul className="space-y-2">
          {items.map((r) => (
            <li key={r.id} data-testid="mod-item" className="border border-black p-2 text-sm space-y-2 break-words">
              <p><strong>{label(r.category ?? "other")}</strong>{r.escalated ? <span className="text-xs"> ({c("c.mod.escalatedBadge")})</span> : null}</p>
              {text(r) && <p>{text(r)}</p>}
              {r.reasons.length > 0 && <p data-testid="mod-reasons"><strong>{c("c.mod.reasons")}:</strong> {r.reasons.join(", ")}</p>}
              {r.appeal && <p data-testid="mod-appeal"><strong>{c("c.mod.appeals")}:</strong> {r.appeal.reason}</p>}
              <div className="flex flex-wrap gap-2">
                <Btn data-testid="mod-approve" onClick={() => void decide(r.id, "approve")}>{c("c.mod.approve")}</Btn>
                {status !== "taken_down" && <Btn secondary data-testid="mod-reject" onClick={() => void decide(r.id, "reject")}>{c("c.mod.reject")}</Btn>}
                {r.appeal && <Btn secondary data-testid="mod-uphold" onClick={() => void decide(r.id, "uphold")}>{c("c.mod.uphold")}</Btn>}
                {!r.escalated && status === "held" && <Btn secondary data-testid="mod-escalate" onClick={() => void decide(r.id, "escalate")}>{c("c.mod.escalate")}</Btn>}
              </div>
            </li>
          ))}
        </ul>
        {page?.hasMore && <Btn secondary data-testid="mod-more" onClick={() => void more()}>{c("c.issue.more")}</Btn>}
        {msg && <p role="status" data-testid="mod-msg">{msg}</p>}
        <ErrorNote msg={err} />
      </Gate>
    </section>
  );
}

/** Lexicon proposals: any moderator proposes adding or removing a term; a DIFFERENT moderator approves or rejects (removals need more approvals). */
export function LexiconPanel() {
  const c = useCivicT();
  const { data, state, reload } = useGuarded(() => issuesApi.lexicon());
  const [term, setTerm] = useState("");
  const [list, setList] = useState("abuse.en");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => {
    if (e instanceof CivicApiError) {
      if (errCode(e) === "independent_review_required" || (e.body as { hint?: string }).hint === "independent_review_required") return c("c.mod.ownProposal");
      if (e.status === 409) return /already approved/i.test(e.message) ? c("c.mod.alreadyApproved") : c("c.mod.dupProposal");
      if (e.status === 404) return c("c.mod.dupProposal");
    }
    return actionError(e, c);
  };
  const run = async (fn: () => Promise<string | null>) => {
    setMsg(null); setErr(null);
    try { const m = await fn(); setMsg(m); setTerm(""); reload(); } catch (e) { setErr(fail(e)); }
  };
  const lists = data?.lists?.length ? data.lists : ["abuse.en", "abuse.te"];
  const pending = (data?.changes ?? []).filter((t) => t.status === "pending");
  return (
    <section data-testid="mod-lexicon" aria-labelledby="lx-h" className="space-y-3">
      <h4 id="lx-h" className="font-bold">{c("c.mod.lexicon")}{data?.version !== undefined ? ` (${c("c.mod.lexVersion")} ${data.version})` : ""}</h4>
      <p className="text-xs">{c("c.mod.lexHelp")}</p>
      <div className="space-y-1">
        <label htmlFor="lx-term" className="block text-sm font-bold">{c("c.mod.term")}</label>
        <TextInput id="lx-term" data-testid="lx-term" value={term} maxLength={60} onChange={(e) => setTerm(e.target.value)} />
        <Field id="lx-list" label={c("c.mod.list")}>
          <select id="lx-list" data-testid="lx-list" className={inputCls} value={list} onChange={(e) => setList(e.target.value)}>{lists.map((l) => <option key={l} value={l}>{l}</option>)}</select>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Btn data-testid="lx-add" disabled={term.trim().length < 2} onClick={() => void run(async () => { await issuesApi.proposeTerm(term.trim(), "add", list); return c("c.mod.proposed"); })}>{c("c.mod.propose")}</Btn>
          <Btn secondary data-testid="lx-remove" disabled={term.trim().length < 2} onClick={() => void run(async () => { await issuesApi.proposeTerm(term.trim(), "remove", list); return c("c.mod.proposed"); })}>{c("c.mod.proposeRemove")}</Btn>
        </div>
      </div>
      <Gate state={state} onRetry={reload}>
        <h5 className="text-sm font-bold">{c("c.mod.review")}</h5>
        {pending.length === 0 && <p className="text-sm">{c("c.cons.empty")}</p>}
        <ul className="space-y-2">
          {pending.map((t) => (
            <li key={t.id} data-testid="lx-item" className="border border-black p-2 text-sm flex flex-wrap items-center gap-2">
              <span className="font-bold break-all">{t.term}</span>
              <span className="text-xs" data-testid="lx-meta">({t.op === "retire" ? c("c.mod.opRetire") : c("c.mod.opAdd")}, {t.list}, {t.approvals}/{t.approvalsNeeded} {c("c.mod.approvals")})</span>
              <Btn data-testid="lx-accept" onClick={() => void run(async () => { const r = await issuesApi.reviewTerm(t.id, "approve"); return r.status === "applied" ? `${c("c.mod.applied")} ${r.version ?? ""}` : c("c.mod.partial"); })}>{c("c.mod.reviewApprove")}</Btn>
              <Btn secondary data-testid="lx-decline" onClick={() => void run(async () => { await issuesApi.reviewTerm(t.id, "reject"); return c("c.mod.rejectedP"); })}>{c("c.mod.reviewReject")}</Btn>
            </li>
          ))}
        </ul>
        {msg && <p role="status" data-testid="lx-msg">{msg}</p>}
        <ErrorNote msg={err} />
      </Gate>
    </section>
  );
}
