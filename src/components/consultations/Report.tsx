import { consApi, errBody, errorCode, type ClosingState, type ReportSnapshot, type StanceDef } from "../../api/consultations";
import { useT } from "../../i18n";
import { useConsT, type ConsT } from "./consultationsText";
import { ClauseFigure, ParticipationBlock } from "./Figures";
import { type Keyed, ClosingBadge, Disclaimer, ErrorLine, Page, card, fmtDate, linkCls, pickLang, titleOf, useLoad } from "./shared";

const STANCES: StanceDef[] = [
  { id: "support", en: "Support", te: "మద్దతు" }, { id: "support_changes", en: "Support with changes", te: "మార్పులతో మద్దతు" },
  { id: "oppose", en: "Oppose", te: "వ్యతిరేకం" }, { id: "unclear", en: "Unclear", te: "స్పష్టత లేదు" }, { id: "prefer_not", en: "Prefer not to say", te: "చెప్పడానికి ఇష్టపడను" },
];

/** Plain-language flags: what was detected, what it means for the figures (it never changes them). */
function Flags({ r, c }: { r: ReportSnapshot; c: ConsT }) {
  const a = r.anti_astroturf;
  const { lang } = useT();
  return (
    <section className={card} data-testid="rep-flags" aria-labelledby="fl-h">
      <h2 id="fl-h" className="text-lg font-bold">{c("rep.flags")}</h2>
      <p className="text-sm">{c("rep.flagsIntro")}</p>
      <ul className="list-disc pl-5 text-sm space-y-1">
        <li data-testid="rep-flag-clusters">{a.flagged_clusters > 0 ? c("rep.clusters", { n: a.flagged_clusters, m: a.cluster_flag_min }) : c("rep.noClusters")}</li>
        {a.clusters.filter((x) => x.flagged).map((x, i) => <li key={i} data-testid="rep-cluster">{c("rep.cluster", { n: x.clause, s: x.size, d: fmtDate(x.first_at, lang, true) })}</li>)}
        <li data-testid="rep-flag-bursts">{a.bursts.length ? c("rep.bursts", { n: a.bursts.length, t: a.burst_threshold_per_minute }) : c("rep.noBursts", { t: a.burst_threshold_per_minute })}</li>
        <li data-testid="rep-flag-limited">{a.rate_limited_requests > 0 ? c("rep.limited", { n: a.rate_limited_requests }) : c("rep.noLimited")}</li>
      </ul>
      <p className="text-sm font-bold">{c("rep.countingRule")}</p>
    </section>
  );
}

export function ReportView({ r }: Keyed & { r: ReportSnapshot }) {
  const c = useConsT();
  const { lang } = useT();
  const cov = r.review_coverage;
  return (
    <div className="space-y-4" data-testid="rep-body">
      <ParticipationBlock p={r.participation} />
      <section aria-labelledby="rc-h" className="space-y-3">
        <h2 id="rc-h" className="text-xl font-bold">{c("rep.perClause")}</h2>
        <ul className="space-y-3">
          {r.clauses.map((cl) => (
            <li key={cl.n} className="space-y-2" data-testid="rep-clause" data-clause={cl.n}>
              <ul><ClauseFigure fc={cl.figures} label={`${c("cl.n", { n: cl.n })}: ${pickLang(cl.summary_en, cl.summary_te, lang)}`} stances={STANCES} /></ul>
              {cl.themes.length > 0 && <ul className="list-disc pl-5 text-sm" data-testid="rep-clause-themes">{cl.themes.map((t, i) => <li key={i}>{pickLang(t.label_en, t.label_te, lang)} <span className="text-xs">({t.source === "human" ? c("rep.byHuman") : c("rep.byMachine")})</span></li>)}</ul>}
              <div className="border-2 border-black p-3 bg-white text-sm" data-testid="rep-response" data-kind={cl.department_response?.kind ?? "none"}>
                <h3 className="font-bold">{c("rep.deptResponse")}</h3>
                {cl.department_response
                  ? <p><strong>{cl.department_response.kind === "no_change" ? c("rep.noChange") : c("rep.changed")}</strong>{" "}{pickLang(cl.department_response.text_en, cl.department_response.text_te, lang)}</p>
                  : <p>{c("rep.noResponse")}</p>}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className={card} data-testid="rep-themes" aria-labelledby="th-h">
        <h2 id="th-h" className="text-lg font-bold">{c("rep.themes")}</h2>
        {r.themes.length === 0 ? <p className="text-sm">{c("rep.noThemes")}</p> : <ul className="list-disc pl-5 text-sm">{r.themes.map((t, i) => <li key={i}>{pickLang(t.label_en, t.label_te, lang)} <span className="text-xs">({t.source === "human" ? c("rep.byHuman") : c("rep.byMachine")})</span></li>)}</ul>}
      </section>
      <Flags r={r} c={c} />
      <section className={card} data-testid="rep-coverage" aria-labelledby="cv-h">
        <h2 id="cv-h" className="text-lg font-bold">{c("rep.coverage")}</h2>
        <p data-testid="rep-coverage-line">{c("rep.coverageLine", { n: cov.comments_total, h: cov.reviewed_by_human, m: cov.machine_summarised })}</p>
        <p className="text-sm" data-testid="rep-coverage-how">{c("rep.coverageHow")} {cov.machine_assisted ? c("rep.machineUsed") : c("rep.machineNone")}</p>
        {cov.human_reviewer_roles.length > 0 && <p className="text-sm">{c("rep.readBy")}: {cov.human_reviewer_roles.map((x) => `${x.role} (${x.comments_read})`).join(", ")}</p>}
      </section>
      {r.method_note && <p className="text-xs">{r.method_note}</p>}
    </div>
  );
}

export function ReportStateNote({ cr, due }: { cr: ClosingState; due: string }) {
  const c = useConsT();
  return (
    <section className={card + (cr.overdue ? " border-2 border-red-800" : "")} role="status" data-testid="rep-pending" data-overdue={cr.overdue ? "1" : "0"}>
      <h2 className="font-bold text-lg">{cr.overdue ? c("cr.overdue") : cr.status === "not_due" ? c("rep.notClosed") : c("cr.pending")}</h2>
      <p>{cr.overdue ? c("rep.overdueText", { d: due }) : cr.status === "not_due" ? c("rep.notClosedText") : c("rep.pendingText", { d: due })}</p>
    </section>
  );
}

export function ReportPage({ id }: Keyed & { id: string }) {
  const c = useConsT();
  const { lang } = useT();
  const cs = useLoad(() => consApi.get(id), [id]);
  const rep = useLoad(() => consApi.closingReport(id), [id]);
  const det = cs.data;
  if (cs.loading && !det) return <Page title={c("loading")}><p role="status">{c("loading")}</p></Page>;
  if (!det) return <Page title={c("det.notFound")} back={{ label: c("nav.registry"), to: "#/consultations" }}><ErrorLine msg={c("err.load")} /></Page>;
  const notPub = errorCode(rep.error) === "report_not_published";
  const cr: ClosingState = ((errBody(rep.error).closing_report as ClosingState | undefined) ?? det.closing_report);
  const r = rep.data;
  return (
    <Page title={`${c("rep.title")}: ${titleOf(det, lang)}`} back={{ label: c("a.details"), to: `#/consultations/${det.id}` }}>
      <Disclaimer en={r?.disclaimer_en ?? det.disclaimer_en} te={r?.disclaimer_te ?? det.disclaimer_te} />
      <div className="flex gap-2"><ClosingBadge cr={cr} /></div>
      {rep.loading && !r && <p role="status">{c("loading")}</p>}
      {notPub && <ReportStateNote cr={cr} due={fmtDate(cr.due_at, lang)} />}
      {rep.error && !notPub && <ErrorLine msg={c("err.load")} />}
      {r && (
        <>
          <p className="text-sm" data-testid="rep-published">{c("rep.publishedAt", { d: fmtDate(r.published_at, lang, true) })} <code className="break-all" title={r.hash_algorithm}>{r.snapshot_hash.slice(0, 16)}</code></p>
          <ReportView r={r.report} />
          <a className={linkCls + " min-h-[44px] inline-flex items-center"} href={`#/consultations/${det.id}/figures`}>{c("a.figures")}</a>
        </>
      )}
    </Page>
  );
}
