import type { ReactNode } from "react";
import { consApi, errorCode, type AudioRef, type Clause, type ConsDetail, type LogEntry } from "../../api/consultations";
import { useT } from "../../i18n";
import { useConsT, type ConsKey, type ConsT } from "./consultationsText";
import { type Keyed, ClosingBadge, Disclaimer, ErrorLine, Page, StatusBadge, btnLink, card, chip, eligibilityText, fmtDate, isOpenNow, linkCls, scopeLabel, shortHash, titleOf, useLoad, useMe } from "./shared";

/** Where a reviewed recording is streamed from: the server answers 409 for a recording no panel member has marked reviewed. */
export const audioUrl = (id: string, n: number, group: string) => `/api/v1/civic/consultations/${id}/clauses/${n}/audio/${encodeURIComponent(group)}`;

function AudioLine({ id, n, group, audio }: Keyed & { id: string; n: number; group: string; audio: AudioRef | undefined }) {
  const c = useConsT();
  const reviewed = audio && audio.status === "reviewed" && !!audio.file_id;
  return (
    <li className="text-sm border border-black/30 p-2 space-y-1" data-testid="cons-audio" data-group={group} data-audio-status={audio?.status ?? "none"}>
      <p className="font-bold">{c("aud.for", { group })}</p>
      {reviewed ? (
        <div>
          {/* A player exists only for a recording a human panel reviewer has marked reviewed. */}
          <audio controls preload="none" src={audioUrl(id, n, group)} aria-label={c("aud.for", { group })} data-testid="cons-audio-player" className="w-full" />
          <p className="text-xs">{c("aud.reviewed", { s: audio!.duration_s })}</p>
        </div>
      ) : (
        <p data-testid="cons-audio-missing">{c("aud.none")}</p>
      )}
    </li>
  );
}

function ClauseItem({ cs, cl }: Keyed & { cs: ConsDetail; cl: Clause }) {
  const c = useConsT();
  const { lang } = useT();
  const first = lang === "te" ? "te" : "en", second = first === "te" ? "en" : "te";
  const sum = (l: "en" | "te") => (l === "te" ? cl.summary_te : cl.summary_en);
  return (
    <li className={card} data-testid="cons-clause" data-clause={cl.n}>
      <h3 className="font-bold text-lg">{c("cl.n", { n: cl.n })}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <section aria-label={c("cl.original")} className="border border-black/30 p-3 space-y-1">
          <h4 className="font-bold text-sm">{c("cl.original")}</h4>
          {cl.original_ref && <p className="text-sm break-words" data-testid="cons-clause-ref"><strong>{c("cl.ref")}:</strong> {cl.original_ref}</p>}
          {cl.original_text && <p className="text-sm whitespace-pre-line break-words" data-testid="cons-clause-original">{cl.original_text}</p>}
        </section>
        <section aria-label={c("cl.plain")} className="border border-black/30 p-3 space-y-2">
          <h4 className="font-bold text-sm">{c("cl.plain")}</h4>
          <p lang={first} className="text-base break-words" data-testid={`cons-summary-${first}`}><span className="text-xs font-bold block">{first === "te" ? "తెలుగు" : "English"}</span>{sum(first)}</p>
          <p lang={second} className="text-base break-words" data-testid={`cons-summary-${second}`}><span className="text-xs font-bold block">{second === "te" ? "తెలుగు" : "English"}</span>{sum(second)}</p>
        </section>
      </div>
      <details>
        <summary className="font-bold text-sm cursor-pointer min-h-[44px] flex items-center">{c("aud.title")}</summary>
        <ul className="space-y-2 mt-2">{cs.affected_groups.map((g) => <AudioLine key={g} id={cs.id} n={cl.n} group={g} audio={cl.audio.find((a) => a.group === g)} />)}</ul>
      </details>
    </li>
  );
}

function logText(e: LogEntry, c: ConsT, lang: "en" | "te"): string {
  const d = e.detail ?? {};
  const k = `log.${e.kind}` as ConsKey;
  let t = c(k) !== k ? c(k) : e.kind;
  if (e.kind === "panel_decision") t += `: ${d.decision === "approve" ? c("pan.approve") : c("pan.reject")}`;
  const reason = lang === "te" && d.reason_te ? d.reason_te : d.reason_en;
  if (reason) t += `: ${String(reason)}`;
  return t;
}

function ParticipateBox({ cs }: Keyed & { cs: ConsDetail }) {
  const c = useConsT();
  const { lang } = useT();
  const me = useMe();
  const open = isOpenNow(cs);
  const mine = useLoad(() => (open && me.signedIn ? consApi.mine(cs.id) : Promise.resolve(null)), [cs.id, open, me.signedIn, me.loading]);
  let state: string, body: ReactNode;
  if (cs.status === "closed" || cs.status === "completed") { state = "closed"; body = <p>{c("part.closed")}</p>; }
  else if (!open) { state = "not_open"; body = <p>{cs.status === "open" ? c("part.notYet", { d: fmtDate(cs.opens_at, lang, true) }) : c("part.notOpen")}</p>; }
  else if (me.loading || mine.loading) { state = "loading"; body = <p role="status">{c("loading")}</p>; }
  else if (!me.signedIn) { state = "signed_out"; body = <p>{c("part.signedOut")} <button type="button" className={linkCls + " min-h-[44px]"} data-testid="cons-signin" onClick={() => window.dispatchEvent(new CustomEvent("pp-nav", { detail: "civic" }))}>{c("part.signIn")}</button></p>; }
  else if (mine.error) { state = "error"; body = <ErrorLine msg={c("err.load")} />; }
  else if (mine.data && !mine.data.eligible) {
    state = "not_eligible";
    const inel = mine.data.ineligible;
    body = <p data-testid="cons-ineligible" data-code={inel?.code ?? ""}>{c("part.notEligible")} <strong>{inel ? eligibilityText(c, inel.code, inel.message) : ""}</strong></p>;
  } else {
    state = "eligible";
    body = <div className="space-y-2"><p>{c("part.eligible", { d: fmtDate(cs.closes_at, lang, true) })}</p><a className={btnLink} href={`#/consultations/${cs.id}/participate`} data-testid="cons-participate-link">{c("part.go")}</a></div>;
  }
  return (
    <section className={card} data-testid="cons-participate" data-state={state} aria-labelledby="who-h">
      <h2 id="who-h" className="text-lg font-bold">{c("who.title")}</h2>
      <ul className="list-disc pl-5 text-sm space-y-1" data-testid="cons-who">
        <li>{c("who.scope", { scope: scopeLabel(c, cs.scope) })}</li>
        <li>{c("who.rules")}</li>
        <li>{c("who.once")}</li>
      </ul>
      <div data-testid="cons-participate-state" aria-live="polite">{body}</div>
    </section>
  );
}

export function ConsultationDetailPage({ id }: Keyed & { id: string }) {
  const c = useConsT();
  const { lang } = useT();
  const r = useLoad(() => consApi.get(id), [id]);
  const log = useLoad(() => consApi.log(id), [id]);
  const cs = r.data;
  if (r.loading && !cs) return <Page title={c("loading")}><p role="status">{c("loading")}</p></Page>;
  if (!cs) return <Page title={c("det.notFound")} back={{ label: c("nav.registry"), to: "#/consultations" }}><ErrorLine msg={errorCode(r.error) === "not_found" ? c("det.notFound") : c("err.load")} /></Page>;
  return (
    <Page title={titleOf(cs, lang)} back={{ label: c("nav.registry"), to: "#/consultations" }}>
      <Disclaimer en={cs.disclaimer_en} te={cs.disclaimer_te} />
      <div className="flex flex-wrap items-center gap-2"><StatusBadge status={cs.status} /><ClosingBadge cr={cs.closing_report} /></div>
      <section className={card} aria-label={c("det.facts")}>
        <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="font-bold">{c("f.department")}</dt><dd data-testid="cons-dept">{cs.department}</dd>
          <dt className="font-bold">{c("f.bill")}</dt>
          <dd className="break-words">{cs.bill_ref} <a className={linkCls} href={cs.source_url} target="_blank" rel="noopener noreferrer" data-testid="cons-source">{c("a.source")}<span className="sr-only"> ({c("a.newTab")})</span></a></dd>
          <dt className="font-bold">{c("f.window")}</dt><dd>{fmtDate(cs.opens_at, lang, true)} - {fmtDate(cs.closes_at, lang, true)}</dd>
          <dt className="font-bold">{c("f.scope")}</dt><dd>{scopeLabel(c, cs.scope)}</dd>
          <dt className="font-bold">{c("f.hash")}</dt><dd><code className="break-all" data-testid="cons-hash">{cs.content_hash}</code> (v{cs.version})</dd>
        </dl>
        <h2 className="font-bold text-sm">{c("f.groups")}</h2>
        <ul className="flex flex-wrap gap-1" data-testid="cons-groups">{cs.affected_groups.map((g) => <li key={g} className={chip}>{g}</li>)}</ul>
        {(cs.status === "closed" || cs.status === "completed") && (
          <div className="flex flex-wrap gap-x-4 text-sm">
            <a className={linkCls + " min-h-[44px] inline-flex items-center"} href={`#/consultations/${cs.id}/figures`} data-testid="cons-figures-link">{c("a.figures")}</a>
            <a className={linkCls + " min-h-[44px] inline-flex items-center"} href={`#/consultations/${cs.id}/report`} data-testid="cons-report-link">{c("a.report")}</a>
          </div>
        )}
      </section>
      <ParticipateBox cs={cs} />
      <section aria-labelledby="clauses-h" className="space-y-3">
        <h2 id="clauses-h" className="text-xl font-bold">{c("det.clauses")}</h2>
        <ul className="space-y-3" data-testid="cons-clauses">{cs.clauses.map((cl) => <ClauseItem key={String(cl.n)} cs={cs} cl={cl} />)}</ul>
      </section>
      <section aria-labelledby="ver-h" className={card} data-testid="cons-versions">
        <h2 id="ver-h" className="text-xl font-bold">{c("ver.title")}</h2>
        <p className="text-sm">{c("ver.hint")}</p>
        <ol className="space-y-2">
          {cs.versions.map((v) => (
            <li key={v.version} className="text-sm border border-black/30 p-2" data-testid="cons-version" data-version={v.version}>
              <strong>v{v.version}</strong> {fmtDate(v.created_at, lang, true)} <code className="break-all" title={v.content_hash}>{shortHash(v.content_hash)}</code>
              {(lang === "te" ? v.note_te || v.note_en : v.note_en) && <p>{c("ver.reason")}: {lang === "te" ? v.note_te || v.note_en : v.note_en}</p>}
            </li>
          ))}
        </ol>
        <h3 className="font-bold">{c("log.title")}</h3>
        <ol className="space-y-1 text-sm" data-testid="cons-log">
          {(log.data?.entries ?? []).map((e) => <li key={e.seq} data-kind={e.kind} data-testid="cons-log-entry">#{e.seq} {fmtDate(e.at, lang, true)} - {logText(e, c, lang)}</li>)}
        </ol>
        <h3 className="font-bold">{c("pan.title")}</h3>
        <p className="text-sm" data-testid="cons-panel">{c("pan.summary", { a: cs.panel.approvals, n: cs.panel.required_approvals })}</p>
      </section>
    </Page>
  );
}
