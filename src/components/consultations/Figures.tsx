import { useState } from "react";
import { consApi, errBody, errorCode, type ConsDetail, type FigClause, type Participation, type StanceDef } from "../../api/consultations";
import { useT } from "../../i18n";
import { useConsT } from "./consultationsText";
import { type Keyed, Disclaimer, ErrorLine, Page, StatusBadge, card, fmtDate, linkCls, pct, titleOf, useLoad } from "./shared";

export function ParticipationBlock({ p }: Keyed & { p: Participation | null }) {
  const c = useConsT();
  if (!p) return <p data-testid="fig-participation-hidden">{c("fig.tooFew")}</p>;
  return (
    <section className={card} data-testid="fig-participation" aria-labelledby="pp-h">
      <h2 id="pp-h" className="text-lg font-bold">{c("fig.participation")}</h2>
      {p.participants === null ? <p data-testid="fig-participants-hidden">{c("fig.tooFew")}</p> : <p><strong data-testid="fig-participants">{p.participants}</strong> {c("fig.people", { r: p.rounded_to })}</p>}
      {p.by_tier ? <ul className="text-sm list-disc pl-5">{p.by_tier.map((t) => <li key={t.tier}>{c("fig.tier", { t: t.tier })}: {t.participants}</li>)}</ul> : <p className="text-sm" data-testid="fig-tier-hidden">{c("fig.tierHidden")}</p>}
      <p className="text-xs">{c("fig.minCell", { k: p.min_cell })}</p>
    </section>
  );
}

export function ClauseFigure({ fc, label, stances }: Keyed & { fc: FigClause | null; label: string; stances: StanceDef[] }) {
  const c = useConsT();
  const { lang } = useT();
  return (
    <li className={card} data-testid="fig-clause" data-published={fc?.published ? "1" : "0"}>
      <h3 className="font-bold break-words">{label}</h3>
      {!fc || !fc.published ? <p data-testid="fig-suppressed" className="text-sm border border-black/40 bg-slate-100 px-3 py-2">{c("fig.tooFew")}</p> : (
        <>
          <p className="text-sm">{c("fig.clauseN", { n: fc.participants ?? 0 })}</p>
          <table className="w-full text-sm">
            <caption className="sr-only">{label}</caption>
            <thead><tr><th scope="col" className="text-left">{c("fig.stance")}</th><th scope="col" className="text-right">{c("fig.share")}</th></tr></thead>
            <tbody>
              {fc.stances.map((o) => (
                <tr key={o.id} className="border-t border-black/20" data-testid="fig-row" data-stance={o.id}>
                  <th scope="row" className="text-left font-normal py-1 pr-2">{stances.find((s) => s.id === o.id)?.[lang] ?? o.id}
                    <div className="h-2 bg-slate-200 border border-black/30" aria-hidden="true"><div className="h-full bg-black" style={{ width: `${Math.min(100, o.share)}%` }} /></div></th>
                  <td className="text-right align-top py-1">{pct(o.share)}</td>
                </tr>
              ))}
              {fc.other && <tr className="border-t border-black/20"><th scope="row" className="text-left font-normal py-1">{c("fig.other")}</th><td className="text-right">{pct(fc.other.share)}</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </li>
  );
}

export function FiguresPage({ id }: Keyed & { id: string }) {
  const c = useConsT();
  const { lang } = useT();
  const cs = useLoad(() => consApi.get(id), [id]);
  const fig = useLoad(() => consApi.figures(id), [id]);
  const [clause, setClause] = useState(0);
  const com = useLoad(() => consApi.comments(id, clause || undefined).catch(() => null), [id, clause]);
  const det: ConsDetail | null = cs.data;
  if (cs.loading && !det) return <Page title={c("loading")}><p role="status">{c("loading")}</p></Page>;
  if (!det) return <Page title={c("det.notFound")} back={{ label: c("nav.registry"), to: "#/consultations" }}><ErrorLine msg={c("err.load")} /></Page>;
  const back = { label: c("a.details"), to: `#/consultations/${det.id}` };
  const code = errorCode(fig.error), body = errBody(fig.error);
  const f = fig.data;
  return (
    <Page title={`${c("fig.title")}: ${titleOf(det, lang)}`} back={back}>
      <Disclaimer en={f?.disclaimer_en ?? det.disclaimer_en} te={f?.disclaimer_te ?? det.disclaimer_te} />
      <div className="flex items-center gap-2"><StatusBadge status={det.status} /></div>
      {fig.loading && !f && <p role="status">{c("loading")}</p>}
      {fig.error && code === "not_published" && (
        <section className={card} role="status" data-testid="fig-not-published" data-reason={String(body.reason ?? "")}>
          <h2 className="font-bold text-lg">{c("fig.notPublished")}</h2>
          <p>{body.reason === "too_early" && typeof body.due_at === "string" ? c("fig.tooEarly", { d: fmtDate(body.due_at, lang, true) }) : c("fig.afterClose", { d: fmtDate(det.closes_at, lang, true) })}</p>
        </section>
      )}
      {fig.error && code !== "not_published" && <ErrorLine msg={c("err.load")} />}
      {f && (
        <>
          <p className="border border-black bg-white px-3 py-2 text-sm font-bold" data-testid="fig-unweighted">{c("fig.unweighted")}</p>
          <ParticipationBlock p={f.participation} />
          <ul className="space-y-3" data-testid="fig-clauses">
            {det.clauses.map((cl) => <ClauseFigure key={String(cl.n)} fc={f.clauses.find((x) => x.clause === cl.n) ?? null} label={`${c("cl.n", { n: cl.n })}: ${lang === "te" && cl.summary_te ? cl.summary_te : cl.summary_en}`} stances={det.stances} />)}
          </ul>
          <p className="text-xs" data-testid="fig-method">{f.method_note}</p>
          <p className="text-xs">{c("fig.counting")}</p>
          <section className={card} aria-labelledby="cm-h" data-testid="fig-comments">
            <h2 id="cm-h" className="text-lg font-bold">{c("cm.title")}</h2>
            <p className="text-sm">{c("cm.intro")}</p>
            <label className="block text-sm font-bold">{c("cm.filter")}
              <select data-testid="cm-clause" className="block w-full border border-black bg-white text-black px-2 text-base font-normal min-h-[44px]" value={clause} onChange={(e) => setClause(Number(e.target.value))}>
                <option value={0}>{c("f.any")}</option>{det.clauses.map((cl) => <option key={cl.n} value={cl.n}>{c("cl.n", { n: cl.n })}</option>)}
              </select>
            </label>
            {com.data && com.data.comments.length === 0 && <p data-testid="cm-empty">{c("cm.empty")}</p>}
            <ul className="space-y-2">
              {(com.data?.comments ?? []).map((m) => (
                <li key={m.ref} className="border border-black/30 p-2 text-sm space-y-1" data-testid="cm-item" data-flag={m.flag ?? ""}>
                  <p className="whitespace-pre-line break-words">{m.comment}</p>
                  <p className="text-xs">{c("cl.n", { n: m.clause })}{m.location ? ` - ${(lang === "te" && m.location.name_te) || m.location.name_en || ""}` : ""}
                    {m.flag ? ` - ${c("cm.dup", { n: m.cluster_size ?? 0 })}` : ""}</p>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      <a className={linkCls + " min-h-[44px] inline-flex items-center"} href={`#/consultations/${det.id}/report`} data-testid="fig-to-report">{c("a.report")}</a>
    </Page>
  );
}
