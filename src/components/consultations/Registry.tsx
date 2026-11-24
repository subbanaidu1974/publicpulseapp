import { useEffect, useRef, useState } from "react";
import { consApi, type ConsSummary } from "../../api/consultations";
import { useT } from "../../i18n";
import { useConsT, type ConsKey } from "./consultationsText";
import { type Keyed, Btn, ClosingBadge, Disclaimer, ErrorLine, Page, StatusBadge, card, chip, fmtDate, linkCls, scopeLabel, selCls, shortHash, titleOf } from "./shared";

export function ConsultationCard({ cs }: Keyed & { cs: ConsSummary }) {
  const c = useConsT();
  const { lang } = useT();
  const groups = cs.affected_groups ?? []; // the list payload carries them: no per-card detail request
  return (
    <li className={card} data-testid="cons-card" data-cons-id={cs.id} data-status={cs.status} data-overdue={cs.closing_report.overdue ? "1" : "0"}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={cs.status} />
        <ClosingBadge cr={cs.closing_report} />
      </div>
      <h2 className="text-lg font-bold break-words"><a className={linkCls} href={`#/consultations/${cs.id}`} data-testid="cons-card-title">{titleOf(cs, lang)}</a></h2>
      <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="font-bold">{c("f.department")}</dt><dd data-testid="cons-card-dept">{cs.department}</dd>
        <dt className="font-bold">{c("f.bill")}</dt>
        <dd className="break-words"><span data-testid="cons-card-bill">{cs.bill_ref}</span>{" "}
          <a className={linkCls} href={cs.source_url} target="_blank" rel="noopener noreferrer" data-testid="cons-card-source">{c("a.source")}<span className="sr-only"> ({c("a.newTab")})</span></a></dd>
        <dt className="font-bold">{c("f.window")}</dt><dd>{fmtDate(cs.opens_at, lang)} - {fmtDate(cs.closes_at, lang)}</dd>
        <dt className="font-bold">{c("f.scope")}</dt><dd>{scopeLabel(c, cs.scope)}</dd>
        <dt className="font-bold">{c("f.groups")}</dt>
        <dd data-testid="cons-card-groups">{groups.length ? <span className="flex flex-wrap gap-1">{groups.map((g) => <span key={g} className={chip}>{g}</span>)}</span> : "-"}</dd>
        <dt className="font-bold">{c("f.hash")}</dt><dd><code title={cs.content_hash}>{shortHash(cs.content_hash)}</code> (v{cs.version})</dd>
      </dl>
      <div className="flex flex-wrap gap-x-4 text-sm">
        <a className={linkCls + " min-h-[44px] inline-flex items-center"} href={`#/consultations/${cs.id}`}>{c("a.details")}</a>
        {(cs.status === "closed" || cs.status === "completed") && <a className={linkCls + " min-h-[44px] inline-flex items-center"} href={`#/consultations/${cs.id}/figures`}>{c("a.figures")}</a>}
        {(cs.status === "closed" || cs.status === "completed") && <a className={linkCls + " min-h-[44px] inline-flex items-center"} href={`#/consultations/${cs.id}/report`}>{c("a.report")}</a>}
      </div>
    </li>
  );
}

export function RegistryPage() {
  const c = useConsT();
  const [status, setStatus] = useState(""), [dept, setDept] = useState(""), [state, setState] = useState(""), [q, setQ] = useState(""), [overdue, setOverdue] = useState(false);
  const [qd, setQd] = useState(""), [dd, setDd] = useState("");
  useEffect(() => { const t = setTimeout(() => { setQd(q); setDd(dept); }, 300); return () => clearTimeout(t); }, [q, dept]);
  const [items, setItems] = useState<ConsSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [disc, setDisc] = useState<{ en?: string; te?: string }>({});
  const seq = useRef(0);

  const fetchPage = (cur: string | undefined, append: boolean) => {
    const mine = ++seq.current;
    setLoading(true); setErr(null);
    consApi.list({ status, department: dd, state, q: qd, overdue: overdue ? "1" : "", cursor: cur, limit: 12 })
      .then((r) => { if (mine !== seq.current) return; setItems((p) => (append ? [...p, ...r.consultations] : r.consultations)); setCursor(r.next_cursor); setDisc({ en: r.disclaimer_en, te: r.disclaimer_te }); })
      .catch(() => { if (mine === seq.current) setErr(c("err.load")); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchPage(undefined, false); }, [status, dd, state, qd, overdue]);

  const shown = items; // every filter, the state included, is applied by the server
  return (
    <Page title={c("reg.title")}>
      <p className="text-sm max-w-2xl">{c("reg.intro")}</p>
      <Disclaimer en={disc.en} te={disc.te} />
      <form role="search" aria-label={c("reg.filters")} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3" onSubmit={(e) => e.preventDefault()}>
        <label className="text-sm font-bold space-y-1 block">{c("f.status")}
          <select data-testid="reg-status" className={selCls + " font-normal"} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{c("f.any")}</option>
            {(["in_review", "approved", "open", "closed", "completed"] as const).map((x) => <option key={x} value={x}>{c(`st.${x}` as ConsKey)}</option>)}
          </select>
        </label>
        <label className="text-sm font-bold space-y-1 block">{c("f.department")}
          <input data-testid="reg-dept" className={selCls + " font-normal"} value={dept} onChange={(e) => setDept(e.target.value)} />
        </label>
        <label className="text-sm font-bold space-y-1 block">{c("f.state")}
          <select data-testid="reg-state" className={selCls + " font-normal"} value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">{c("f.any")}</option><option value="AP">AP</option><option value="TG">TG</option>
          </select>
        </label>
        <label className="text-sm font-bold space-y-1 block">{c("f.search")}
          <input data-testid="reg-search" className={selCls + " font-normal"} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="flex items-center gap-3 text-sm font-bold min-h-[44px] sm:col-span-2">
          <input type="checkbox" data-testid="reg-overdue" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />{c("f.overdue")}
        </label>
      </form>
      <ErrorLine msg={err} />
      <ul className="space-y-3" data-testid="cons-list" aria-busy={loading}>{shown.map((cs) => <ConsultationCard key={cs.id} cs={cs} />)}</ul>
      {loading && <p role="status" data-testid="reg-loading">{c("loading")}</p>}
      {!loading && !err && shown.length === 0 && <p data-testid="reg-empty" role="status">{c("reg.empty")}</p>}
      {cursor && !loading && <Btn secondary data-testid="reg-more" onClick={() => fetchPage(cursor, true)}>{c("loadMore")}</Btn>}
    </Page>
  );
}
