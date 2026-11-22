import { useEffect, useState } from "react";
import { errorCode, surveysApi, type Eligibility, type SurveyDetail } from "../../api/surveys";
import { useT } from "../../i18n";
import { useCreatorLabel, useScopeLabel } from "./Registry";
import { type Keyed, Btn, Disclaimer, ErrorLine, Page, ProtectionBox, StatusBadge, btnLink, card, fmtDate, linkCls, pickLang, shortHash, titleOf, useLoad, useMe } from "./shared";
import { useSurveyT, type SurveyKey } from "./surveysText";

export type TakeState =
  | { kind: "loading" } | { kind: "signin" } | { kind: "not_open"; why: "not_yet" | "closed" | "cancelled" | "hidden" }
  | { kind: "not_eligible"; code: string; message: string; eligible_from?: string } | { kind: "responded" } | { kind: "eligible"; elig: Eligibility };

/** Take-button state: public facts first, then the server's own eligibility decision (never decided on the client). */
export function useTakeState(sv: SurveyDetail | null): TakeState {
  const me = useMe();
  const [st, setSt] = useState<TakeState>({ kind: "loading" });
  useEffect(() => {
    if (!sv || me.loading) return;
    if (sv.hidden_reason) return setSt({ kind: "not_open", why: "hidden" });
    if (sv.status === "cancelled") return setSt({ kind: "not_open", why: "cancelled" });
    if (sv.status === "closed") return setSt({ kind: "not_open", why: "closed" });
    if (sv.status !== "open") return setSt({ kind: "not_open", why: "not_yet" });
    const now = Date.now();
    if (now < Date.parse(sv.opens_at)) return setSt({ kind: "not_open", why: "not_yet" });
    if (now >= Date.parse(sv.closes_at)) return setSt({ kind: "not_open", why: "closed" });
    if (!me.signedIn) return setSt({ kind: "signin" });
    let live = true;
    surveysApi.eligibility(sv.id).then((e) => {
      if (!live) return;
      if (e.eligible) setSt({ kind: "eligible", elig: e });
      else if (e.code === "already_responded") setSt({ kind: "responded" });
      else setSt({ kind: "not_eligible", code: e.code, message: e.message, eligible_from: e.eligible_from });
    }).catch((x) => {
      if (!live) return;
      if (errorCode(x) === "survey_not_open") setSt({ kind: "not_open", why: "closed" });
      else setSt({ kind: "signin" });
    });
    return () => { live = false; };
  }, [sv, me.loading, me.signedIn]);
  return st;
}

export function TakeBox({ sv }: { sv: SurveyDetail }) {
  const s = useSurveyT();
  const { lang } = useT();
  const st = useTakeState(sv);
  const msg = (() => {
    if (st.kind === "not_open") return s(`take.no.${st.why}` as SurveyKey);
    if (st.kind === "not_eligible") {
      const k = `elig.${st.code}` as SurveyKey;
      const base = s(k) === k ? st.message : s(k);
      return st.eligible_from ? `${base} ${s("elig.from")} ${fmtDate(st.eligible_from, lang)}.` : base;
    }
    if (st.kind === "responded") return s("take.no.responded");
    return "";
  })();
  return (
    <section className={card} aria-label={s("take.title")} data-testid="take-box" data-take-state={st.kind === "not_open" ? `not_open_${st.why}` : st.kind === "not_eligible" ? `not_eligible_${st.code}` : st.kind}>
      <h2 className="text-lg font-bold">{s("take.title")}</h2>
      {st.kind === "loading" && <p role="status">{s("loading")}</p>}
      {st.kind === "signin" && (
        <div className="space-y-2">
          <p data-testid="take-signin-msg">{s("take.signin")}</p>
          <Btn data-testid="take-signin" onClick={() => window.dispatchEvent(new CustomEvent("pp-nav", { detail: "civic" }))}>{s("take.signinBtn")}</Btn>
        </div>
      )}
      {msg && <p data-testid="take-msg" role="status" className="font-bold">{msg}</p>}
      {st.kind === "eligible" && (
        <div className="space-y-2">
          <p>{s("take.eligible")}</p>
          <a className={btnLink} href={`#/surveys/${sv.id}/take`} data-testid="take-button">{s("take.button")}</a>
        </div>
      )}
      {sv.status === "closed" && <a className={linkCls} href={`#/surveys/${sv.id}/figures`} data-testid="detail-figures-link">{s("a.figures")}</a>}
    </section>
  );
}

function VersionWording({ id, n }: { id: string; n: number }) {
  const s = useSurveyT();
  const { lang } = useT();
  const [open, setOpen] = useState(false);
  const r = useLoad(() => (open ? surveysApi.version(id, n) : Promise.resolve(null)), [id, n, open]);
  return (
    <div>
      <Btn secondary data-testid={`ver-toggle-${n}`} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? s("ver.hide") : s("ver.show")}</Btn>
      {open && r.error != null && <ErrorLine msg={s("err.load")} />}
      {open && r.data && (
        <div className="mt-2 text-sm space-y-2" data-testid={`ver-wording-${n}`}>
          <p className="font-bold">{pickLang(r.data.wording.title_en, r.data.wording.title_te, lang)}</p>
          <ol className="list-decimal pl-5 space-y-1">
            {r.data.wording.questions.map((q, i) => <li key={i}>{pickLang(q.text_en, q.text_te, lang)} <span className="text-xs">({q.options.map((o) => pickLang(o.label_en, o.label_te, lang)).join(" / ")})</span></li>)}
          </ol>
        </div>
      )}
    </div>
  );
}

export function SurveyDetailPage({ id, focus }: Keyed & { id: string; focus?: "versions" }) {
  const s = useSurveyT();
  const { lang } = useT();
  const org = useCreatorLabel(), scope = useScopeLabel();
  const r = useLoad(() => surveysApi.get(id), [id]);
  const sv = r.data;
  useEffect(() => { if (sv && focus === "versions") document.getElementById("sv-versions")?.scrollIntoView?.(); }, [sv, focus]);
  if (r.loading && !sv) return <Page title={s("loading")}><p role="status">{s("loading")}</p></Page>;
  if (!sv) return <Page title={s("det.notFound")} back={{ label: s("nav.registry"), to: "#/surveys" }}><ErrorLine msg={errorCode(r.error) === "not_found" ? s("det.notFound") : s("err.load")} /></Page>;
  return (
    <Page title={titleOf(sv, lang)} back={{ label: s("nav.registry"), to: "#/surveys" }}>
      <div className="flex flex-wrap items-center gap-2"><StatusBadge status={sv.status} /><span className="text-sm">{s(`topic.${sv.topic_class}` as SurveyKey)}</span></div>
      <Disclaimer en={sv.disclaimer_en} te={sv.disclaimer_te} />
      {sv.hidden_reason === "election_window" && <p data-testid="survey-hidden-notice" role="note" className="text-sm border border-black/50 bg-slate-100 px-3 py-2">{s("hidden.election")}</p>}
      {sv.cancellation && (
        <p data-testid="survey-cancel-reason" className="text-sm border border-red-800 bg-red-50 text-black px-3 py-2">
          <strong>{s("cancel.public")}</strong> {s(`reason.${sv.cancellation.reason_code}` as SurveyKey)}: {sv.cancellation.reason_text} ({fmtDate(sv.cancellation.at, lang)})
        </p>
      )}
      <TakeBox sv={sv} />
      <ProtectionBox />
      <section className={card} aria-label={s("det.facts")}>
        <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="font-bold">{s("f.creator")}</dt><dd>{org(sv.creator)}</dd>
          <dt className="font-bold">{s("f.scope")}</dt><dd>{scope(sv.scope)}</dd>
          <dt className="font-bold">{s("f.window")}</dt><dd>{fmtDate(sv.opens_at, lang, true)} - {fmtDate(sv.closes_at, lang, true)}</dd>
          <dt className="font-bold">{s("f.hash")}</dt><dd><code data-testid="detail-hash" title={sv.wording_hash}>{shortHash(sv.wording_hash)}</code> (v{sv.version})</dd>
        </dl>
        <h2 className="font-bold pt-2">{s("det.who")}</h2>
        <p className="text-sm" data-testid="detail-who">{s("det.whoText")}</p>
      </section>
      <section className={card} aria-label={s("det.wording")}>
        <h2 className="text-lg font-bold">{s("det.wording")}</h2>
        {sv.hidden_reason ? <p className="text-sm">{s("hidden.wording")}</p> : (
          <ol className="space-y-3 list-decimal pl-5" data-testid="detail-questions">
            {sv.questions.map((q) => (
              <li key={q.id}>
                <p className="font-bold">{pickLang(q.text_en, q.text_te, lang)}</p>
                <ul className="list-disc pl-5 text-sm">{q.options.map((o) => <li key={o.id}>{pickLang(o.label_en, o.label_te, lang)}</li>)}</ul>
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs">{s("det.frozen")}</p>
      </section>
      <section id="sv-versions" className={card} aria-label={s("det.versions")}>
        <h2 className="text-lg font-bold">{s("det.versions")}</h2>
        <ul className="space-y-2" data-testid="detail-versions">
          {sv.versions.map((v) => (
            <li key={v.version} className="text-sm border-t border-black/20 pt-2" data-testid="version-row">
              <p>v{v.version} - {fmtDate(v.registered_at, lang, true)} - <code title={v.wording_hash}>{shortHash(v.wording_hash)}</code>{v.wording_hash === sv.wording_hash ? ` (${s("ver.current")})` : ""}</p>
              {!sv.hidden_reason && <VersionWording id={sv.id} n={v.version} />}
            </li>
          ))}
        </ul>
        <p className="text-xs">{s("ver.hashNote")}</p>
      </section>
      <section className={card} aria-label={s("det.panel")}>
        <h2 className="text-lg font-bold">{s("det.panel")}</h2>
        <p className="text-sm" data-testid="detail-panel">{s("det.panelSummary").replace("{a}", String(sv.panel.approvals)).replace("{r}", String(sv.panel.required_approvals))}</p>
        <ul className="text-sm space-y-1">
          {sv.panel.decisions.map((d, i) => (
            <li key={i} data-testid="panel-decision">v{d.version}: {d.decision === "approve" ? s("pan.approve") : s("pan.reject")} ({fmtDate(d.at, lang)}){d.current ? "" : ` - ${s("det.olderWording")}`}{d.notes ? ` - ${d.notes}` : ""}</li>
          ))}
        </ul>
        <p className="text-xs">{s("det.panelNote")}</p>
      </section>
    </Page>
  );
}
