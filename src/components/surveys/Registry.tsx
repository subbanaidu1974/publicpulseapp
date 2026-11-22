import { useEffect, useRef, useState } from "react";
import { surveysApi, type LogEntry, type SurveySummary } from "../../api/surveys";
import { useT } from "../../i18n";
import { type Keyed, Btn, Disclaimer, ErrorLine, Page, ProtectionBox, StatusBadge, card, fmtDate, linkCls, shortHash, titleOf, useLoad } from "./shared";
import { useSurveyT, type SurveyKey } from "./surveysText";

export function useCreatorLabel() {
  const s = useSurveyT();
  return (c: SurveySummary["creator"]) => {
    const kind = s(`org.${c.org_kind}` as SurveyKey);
    const extra = c.org_code ?? c.department;
    return extra ? `${kind}: ${extra}` : kind;
  };
}

export function useScopeLabel() {
  const s = useSurveyT();
  return (sc: SurveySummary["scope"]) => {
    const parts = Object.entries(sc.units ?? {}).filter(([, v]) => v && v.length).map(([k, v]) => `${s(`unit.${k}` as SurveyKey)}: ${v!.join(", ")}`);
    return `${sc.state}${parts.length ? " (" + parts.join("; ") + ")" : ` (${s("scope.whole")})`}`;
  };
}

export function SurveyCard({ sv }: Keyed & { sv: SurveySummary }) {
  const s = useSurveyT();
  const { lang } = useT();
  const org = useCreatorLabel(), scope = useScopeLabel();
  return (
    <li className={card} data-testid="survey-card" data-survey-id={sv.id} data-status={sv.status}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={sv.status} />
        <span className="text-xs">{s(`topic.${sv.topic_class}` as SurveyKey)}</span>
      </div>
      <h2 className="text-lg font-bold break-words"><a className={linkCls} href={`#/surveys/${sv.id}`} data-testid="survey-card-title">{titleOf(sv, lang)}</a></h2>
      <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="font-bold">{s("f.creator")}</dt><dd data-testid="survey-card-creator">{org(sv.creator)}</dd>
        <dt className="font-bold">{s("f.scope")}</dt><dd>{scope(sv.scope)}</dd>
        <dt className="font-bold">{s("f.window")}</dt><dd>{fmtDate(sv.opens_at, lang)} - {fmtDate(sv.closes_at, lang)}</dd>
        <dt className="font-bold">{s("f.hash")}</dt><dd><code data-testid="survey-card-hash" title={sv.wording_hash}>{shortHash(sv.wording_hash)}</code> (v{sv.version})</dd>
      </dl>
      {sv.hidden_reason === "election_window" && <p data-testid="survey-hidden-notice" role="note" className="text-sm border border-black/50 bg-slate-100 px-3 py-2">{s("hidden.election")}</p>}
      {sv.cancellation && (
        <p data-testid="survey-cancel-reason" className="text-sm border border-red-800 bg-red-50 px-3 py-2">
          <strong>{s("cancel.public")}</strong> {s(`reason.${sv.cancellation.reason_code}` as SurveyKey)}: {sv.cancellation.reason_text}
        </p>
      )}
      <div className="flex flex-wrap gap-4 text-sm">
        <a className={linkCls} href={`#/surveys/${sv.id}`}>{s("a.details")}</a>
        <a className={linkCls} href={`#/surveys/${sv.id}/versions`} data-testid="survey-card-history">{s("a.history")}</a>
        {sv.status === "closed" && <a className={linkCls} href={`#/surveys/${sv.id}/figures`}>{s("a.figures")}</a>}
      </div>
    </li>
  );
}

export function RegistryPage() {
  const s = useSurveyT();
  const [status, setStatus] = useState(""), [topic, setTopic] = useState(""), [state, setState] = useState(""), [q, setQ] = useState("");
  const [qDebounced, setQd] = useState("");
  useEffect(() => { const t = setTimeout(() => setQd(q), 300); return () => clearTimeout(t); }, [q]);
  const [items, setItems] = useState<SurveySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [disc, setDisc] = useState<{ en?: string; te?: string }>({});
  const seq = useRef(0);

  const fetchPage = (cur: string | undefined, append: boolean) => {
    const mine = ++seq.current;
    setLoading(true); setErr(null);
    surveysApi.list({ status, topic, state, q: qDebounced, cursor: cur, limit: 12, include_hidden: "1" })
      .then((r) => { if (mine !== seq.current) return; setItems((p) => (append ? [...p, ...r.surveys] : r.surveys)); setCursor(r.next_cursor); setDisc({ en: r.disclaimer_en, te: r.disclaimer_te }); })
      .catch(() => { if (mine === seq.current) setErr(s("err.load")); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchPage(undefined, false); }, [status, topic, state, qDebounced]);

  const sel = "border border-black bg-white text-black px-2 text-base min-h-[44px]";
  return (
    <Page title={s("reg.title")}>
      <p className="text-sm max-w-2xl">{s("reg.intro")}</p>
      <Disclaimer en={disc.en} te={disc.te} />
      <ProtectionBox compact />
      <form role="search" aria-label={s("reg.filters")} className="grid grid-cols-1 sm:grid-cols-4 gap-3" onSubmit={(e) => e.preventDefault()}>
        <label className="text-sm font-bold space-y-1 block">{s("f.status")}
          <select data-testid="reg-status" className={sel + " w-full font-normal"} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{s("f.any")}</option>
            {(["in_review", "approved", "open", "closed", "cancelled"] as const).map((x) => <option key={x} value={x}>{s(`st.${x}` as SurveyKey)}</option>)}
          </select>
        </label>
        <label className="text-sm font-bold space-y-1 block">{s("f.topic")}
          <select data-testid="reg-topic" className={sel + " w-full font-normal"} value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="">{s("f.any")}</option>
            {(["issue_service", "bill", "political", "election_choice"] as const).map((x) => <option key={x} value={x}>{s(`topic.${x}` as SurveyKey)}</option>)}
          </select>
        </label>
        <label className="text-sm font-bold space-y-1 block">{s("f.state")}
          <select data-testid="reg-state" className={sel + " w-full font-normal"} value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">{s("f.any")}</option><option value="AP">AP</option><option value="TG">TG</option>
          </select>
        </label>
        <label className="text-sm font-bold space-y-1 block">{s("f.search")}
          <input data-testid="reg-search" className={sel + " w-full font-normal"} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </form>
      <ErrorLine msg={err} />
      <ul className="space-y-3" data-testid="survey-list" aria-busy={loading}>{items.map((sv) => <SurveyCard key={sv.id} sv={sv} />)}</ul>
      {loading && <p role="status" data-testid="reg-loading">{s("loading")}</p>}
      {!loading && !err && items.length === 0 && <p data-testid="reg-empty" role="status">{s("reg.empty")}</p>}
      {cursor && !loading && <Btn secondary data-testid="reg-more" onClick={() => fetchPage(cursor, true)}>{s("loadMore")}</Btn>}
    </Page>
  );
}

function logLine(e: LogEntry, s: ReturnType<typeof useSurveyT>): string {
  const d = e.detail ?? {};
  if (e.kind === "cancelled") return `${s("log.cancelled")}: ${s(`reason.${String(d.reason_code)}` as SurveyKey)} - ${String(d.reason_text ?? "")}`;
  if (e.kind === "panel_decision") return `${s("log.panel")}: ${d.decision === "approve" ? s("pan.approve") : s("pan.reject")}`;
  return s(`log.${e.kind}` as SurveyKey);
}

/** The public change log of the registry: registrations, panel decisions, openings, closings and cancellations with their reasons. */
export function RegistryLog() {
  const s = useSurveyT();
  const { lang } = useT();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const first = useLoad(() => surveysApi.log(0, 50), []);
  useEffect(() => { if (first.data) { setEntries(first.data.entries); setNext(first.data.next_after); } }, [first.data]);
  const [err, setErr] = useState<string | null>(null);
  const more = async () => { try { const r = await surveysApi.log(next ?? 0, 50); setEntries((p) => [...p, ...r.entries]); setNext(r.next_after); } catch { setErr(s("err.load")); } };
  return (
    <Page title={s("log.title")} back={{ label: s("nav.registry"), to: "#/surveys" }}>
      <p className="text-sm max-w-2xl">{s("log.intro")}</p>
      <Disclaimer en={first.data?.disclaimer_en} te={first.data?.disclaimer_te} />
      <ErrorLine msg={err ?? (first.error ? s("err.load") : null)} />
      <ol className="space-y-2" data-testid="registry-log">
        {entries.map((e) => (
          <li key={e.seq} className={card} data-testid="log-entry" data-kind={e.kind}>
            <p className="text-sm"><strong>#{e.seq}</strong> {fmtDate(e.at, lang, true)} - {logLine(e, s)}</p>
            <a className={linkCls + " text-sm"} href={`#/surveys/${e.survey_id}`}>{s("a.details")}</a>
          </li>
        ))}
      </ol>
      {!first.loading && entries.length === 0 && <p role="status">{s("log.empty")}</p>}
      {next !== null && <Btn secondary data-testid="log-more" onClick={more}>{s("loadMore")}</Btn>}
    </Page>
  );
}
