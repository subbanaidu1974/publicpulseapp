import { useState } from "react";
import { CivicApiError } from "../../api/civic";
import { surveysApi, type SurveyDetail } from "../../api/surveys";
import { useT } from "../../i18n";
import { useCreatorGate } from "./Creator";
import { useCreatorLabel } from "./Registry";
import { useErrorMessage } from "./Take";
import { Btn, Disclaimer, ErrorLine, Page, card, fmtDate, inputCls, pickLang, shortHash, titleOf, useLoad } from "./shared";
import { useSurveyT, type SurveyKey } from "./surveysText";

function ReviewCard({ id, onDone }: { id: string; onDone: (status: string) => void }) {
  const s = useSurveyT();
  const { lang } = useT();
  const errMsg = useErrorMessage();
  const org = useCreatorLabel();
  const r = useLoad(() => surveysApi.get(id), [id]);
  const [notes, setNotes] = useState(""), [err, setErr] = useState<string | null>(null);
  const sv: SurveyDetail | null = r.data;
  if (!sv) return <p role="status">{s("loading")}</p>;
  const decide = async (d: "approve" | "reject") => {
    setErr(null);
    try { const out = await surveysApi.review(sv.id, d, notes.trim()); onDone(out.status); }
    catch (x) {
      if (x instanceof CivicApiError && x.body.code === "reviewer_conflict") setErr(`${s("err.reviewer_conflict")} (${s(`conflict.${String(x.body.reason)}` as SurveyKey) === `conflict.${String(x.body.reason)}` ? String(x.body.reason) : s(`conflict.${String(x.body.reason)}` as SurveyKey)})`);
      else setErr(errMsg(x));
    }
  };
  return (
    <section className={card} data-testid="review-card" data-survey-id={sv.id}>
      <h3 className="font-bold break-words">{titleOf(sv, lang)}</h3>
      <p className="text-sm">{org(sv.creator)} - {fmtDate(sv.opens_at, lang)} - {fmtDate(sv.closes_at, lang)} - <code>{shortHash(sv.wording_hash)}</code></p>
      <ol className="list-decimal pl-5 space-y-2 text-sm" data-testid="review-wording">
        {sv.questions.map((q) => <li key={q.id}><span className="font-bold">{pickLang(q.text_en, q.text_te, lang)}</span> <span>({q.options.map((o) => pickLang(o.label_en, o.label_te, lang)).join(" / ")})</span></li>)}
      </ol>
      <p className="text-sm">{s("det.panelSummary").replace("{a}", String(sv.panel.approvals)).replace("{r}", String(sv.panel.required_approvals))}</p>
      <label className="block text-sm font-bold">{s("pan.notes")}
        <textarea data-testid="review-notes" className={inputCls + " font-normal"} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <p className="text-xs">{s("pan.notesHint")}</p>
      <ErrorLine msg={err} />
      <div className="flex flex-wrap gap-3">
        <Btn data-testid="review-approve" onClick={() => void decide("approve")}>{s("pan.approve")}</Btn>
        <Btn secondary data-testid="review-reject" onClick={() => void decide("reject")}>{s("pan.reject")}</Btn>
      </div>
    </section>
  );
}

export function PanelPage() {
  const s = useSurveyT();
  const { lang } = useT();
  const me = useCreatorGate();
  const q = useLoad(() => surveysApi.list({ status: "in_review", limit: 50, include_hidden: "1" }), [me.isPanel]);
  const [sel, setSel] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  return (
    <Page title={s("pan.title")} back={{ label: s("con.title"), to: "#/surveys/console" }}>
      <Disclaimer />
      <p className="text-sm max-w-2xl">{s("pan.intro")}</p>
      {me.loading ? <p role="status">{s("loading")}</p> : !me.signedIn ? <p data-testid="console-signin">{s("take.signin")}</p> : !me.isPanel ? <p role="alert" data-testid="console-forbidden" className="font-bold">{s("pan.noRole")}</p> : (
        <>
          {recorded && <p role="status" data-testid="review-done" data-status={recorded} className="font-bold">{s("pan.recorded")} {s(`st.${recorded}` as SurveyKey)}</p>}
          <ul className="space-y-2" data-testid="panel-queue">
            {(q.data?.surveys ?? []).map((sv) => (
              <li key={sv.id} className={card} data-testid="queue-item" data-survey-id={sv.id}>
                <p className="font-bold break-words">{titleOf(sv, lang)}</p>
                <Btn secondary aria-expanded={sel === sv.id} data-testid="queue-open" onClick={() => setSel(sel === sv.id ? null : sv.id)}>{s("pan.review")}</Btn>
                {sel === sv.id && <ReviewCard id={sv.id} onDone={(st) => { setRecorded(st); setSel(null); q.reload(); }} />}
              </li>
            ))}
          </ul>
          {q.data && q.data.surveys.length === 0 && <p role="status" data-testid="queue-empty">{s("pan.empty")}</p>}
        </>
      )}
    </Page>
  );
}
