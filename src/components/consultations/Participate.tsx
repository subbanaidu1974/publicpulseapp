import { useEffect, useState } from "react";
import { consApi, errBody, errorCode, type ConsDetail, type FeedbackSaved, type Mine, type MineFeedback, type StanceId } from "../../api/consultations";
import { useT } from "../../i18n";
import { useConsT, type ConsKey } from "./consultationsText";
import { type Keyed, Btn, Disclaimer, ErrorLine, Page, btnLinkSecondary, card, eligibilityText, fmtDate, isOpenNow, titleOf, useErrMsg, useLoad, useMe } from "./shared";

const MAX = 1500;
const latinOrTelugu = (t: string): boolean => {
  const letters = [...t].filter((ch) => /\p{L}/u.test(ch));
  return !letters.length || letters.filter((ch) => /[A-Za-zఀ-౿]/.test(ch)).length / letters.length >= 0.9;
};

interface Row { stance: StanceId | ""; comment: string; publicOk: boolean; saved: MineFeedback | null; result: FeedbackSaved | null; err: string | null; busy: boolean }

function ClauseForm({ cs, n, row, set, onSave }: Keyed & { cs: ConsDetail; n: number; row: Row; set: (p: Partial<Row>) => void; onSave: () => void }) {
  const c = useConsT();
  const { lang } = useT();
  const cl = cs.clauses.find((x) => x.n === n)!;
  const summary = lang === "te" && cl.summary_te ? cl.summary_te : cl.summary_en;
  const len = [...row.comment].length;
  const badLang = !latinOrTelugu(row.comment);
  return (
    <li>
      <form className={card} data-testid="fb-clause" data-clause={n} onSubmit={(e) => { e.preventDefault(); onSave(); }}>
        <fieldset className="space-y-1">
          <legend className="font-bold break-words">{c("cl.n", { n })}: {summary}</legend>
          {cs.stances.map((s) => (
            <label key={s.id} className="flex items-center gap-3 min-h-[44px] text-base cursor-pointer">
              <input type="radio" name={`stance-${n}`} value={s.id} data-testid={`fb-stance-${s.id}`} checked={row.stance === s.id} onChange={() => set({ stance: s.id })} />
              <span>{lang === "te" ? s.te : s.en}</span>
            </label>
          ))}
        </fieldset>
        <div className="space-y-1">
          <label htmlFor={`cm-${n}`} className="block text-sm font-bold">{c("fb.comment")}</label>
          <textarea id={`cm-${n}`} data-testid="fb-comment" className="w-full border border-black bg-white text-black px-3 py-2 text-base min-h-[96px]" rows={3} maxLength={MAX} value={row.comment}
            aria-describedby={`cmh-${n}`} lang={latinOrTelugu(row.comment) ? undefined : lang} onChange={(e) => set({ comment: e.target.value })} />
          <p id={`cmh-${n}`} className="text-xs flex flex-wrap justify-between gap-2">
            <span data-testid="fb-lang-hint" className={badLang ? "font-bold text-red-900" : ""}>{badLang ? c("fb.langBad") : c("fb.langHint")}</span>
            <span data-testid="fb-counter">{c("fb.counter", { n: len, max: MAX })}</span>
          </p>
        </div>
        <label className="flex items-start gap-3 text-sm min-h-[44px]">
          <input type="checkbox" data-testid="fb-public" checked={row.publicOk} disabled={!row.comment.trim()} onChange={(e) => set({ publicOk: e.target.checked })} />
          <span><strong>{c("fb.public")}</strong><br />{c("fb.publicWhy")}</span>
        </label>
        <ErrorLine msg={row.err} />
        {row.result && (
          <p role="status" data-testid="fb-result" data-comment-status={row.result.comment_status} data-public={row.result.comment_public ? "1" : "0"} className="text-sm border border-black/40 bg-slate-100 px-3 py-2">
            {row.result.edited ? c("fb.edited") : c("fb.saved")}{" "}
            {row.result.comment_status === "held" ? c("fb.held") : row.result.comment_public ? c("fb.willBePublic") : row.result.comment_status === "ok" ? c("fb.private") : ""}
          </p>
        )}
        <Btn type="submit" data-testid="fb-save" disabled={!row.stance || row.busy || badLang}>{row.saved ? c("fb.update") : c("fb.save")}</Btn>
      </form>
    </li>
  );
}

export function ParticipatePage({ id }: Keyed & { id: string }) {
  const c = useConsT();
  const { lang } = useT();
  const msg = useErrMsg();
  const me = useMe();
  const r = useLoad(() => consApi.get(id), [id]);
  const mineQ = useLoad<Mine | null>(() => (me.signedIn ? consApi.mine(id) : Promise.resolve(null)), [id, me.signedIn, me.loading]);
  const [rows, setRows] = useState<Record<number, Row>>({});
  const cs = r.data;
  useEffect(() => {
    if (!cs) return;
    const m = new Map((mineQ.data?.feedback ?? []).map((f) => [f.clause, f]));
    setRows(Object.fromEntries(cs.clauses.map((cl): [number, Row] => {
      const f = m.get(cl.n);
      return [cl.n, { stance: f?.stance ?? "", comment: f?.comment ?? "", publicOk: f?.public_ok ?? false, saved: f ?? null, result: null, err: null, busy: false }];
    })));
  }, [cs, mineQ.data]);

  if (r.loading && !cs) return <Page title={c("loading")}><p role="status">{c("loading")}</p></Page>;
  if (!cs) return <Page title={c("det.notFound")} back={{ label: c("nav.registry"), to: "#/consultations" }}><ErrorLine msg={c("err.load")} /></Page>;
  const back = { label: c("a.details"), to: `#/consultations/${cs.id}` };
  const title = titleOf(cs, lang);
  const gate = (text: string, state: string) => (
    <Page title={title} back={back}><Disclaimer en={cs.disclaimer_en} te={cs.disclaimer_te} /><p data-testid="part-gate" data-state={state} role="status" className={card}>{text}</p></Page>
  );
  if (!isOpenNow(cs)) return gate(cs.status === "closed" || cs.status === "completed" ? c("part.closed") : c("part.notOpen"), "closed");
  if (me.loading || mineQ.loading) return gate(c("loading"), "loading");
  if (!me.signedIn) return gate(c("part.signedOut"), "signed_out");
  const m = mineQ.data;
  if (m && !m.eligible) return gate(`${c("part.notEligible")} ${m.ineligible ? eligibilityText(c, m.ineligible.code, m.ineligible.message) : ""}`, "not_eligible");

  const set = (n: number, p: Partial<Row>) => setRows((x) => ({ ...x, [n]: { ...x[n], ...p } }));
  const save = async (n: number) => {
    const row = rows[n];
    if (!row?.stance) return;
    set(n, { busy: true, err: null, result: null });
    try {
      const res = await consApi.feedback(cs.id, { clause: n, stance: row.stance, comment: row.comment.trim() ? row.comment : "", public_ok: row.publicOk && !!row.comment.trim() });
      set(n, { busy: false, result: res, saved: { clause: n, stance: res.stance, comment: row.comment.trim() || null, public_ok: row.publicOk && !!row.comment.trim(), comment_status: res.comment_status, created_at: "", updated_at: new Date().toISOString(), edits: 0 } });
    } catch (e) {
      const code = errorCode(e);
      const extra = code === "comment_too_long" ? ` (${String(errBody(e).max_chars ?? MAX)})` : "";
      set(n, { busy: false, err: msg(e) + extra });
    }
  };
  const mineList = (Object.entries(rows) as [string, Row][]).filter(([, x]) => x.saved).map(([n, x]) => ({ n: Number(n), ...x.saved! }));
  return (
    <Page title={title} back={back}>
      <Disclaimer en={cs.disclaimer_en} te={cs.disclaimer_te} />
      <section className={card} data-testid="part-honest" aria-labelledby="hon-h">
        <h2 id="hon-h" className="font-bold">{c("fb.honestTitle")}</h2>
        <ul className="list-disc pl-5 text-sm space-y-1">
          <li>{c("fb.honest1")}</li><li>{c("fb.honest2")}</li><li>{c("fb.honest3", { d: fmtDate(cs.closes_at, lang, true) })}</li><li>{c("fb.honest4")}</li>
        </ul>
      </section>
      <ul className="space-y-3" data-testid="part-form">{cs.clauses.map((cl) => rows[cl.n] && <ClauseForm key={String(cl.n)} cs={cs} n={cl.n} row={rows[cl.n]} set={(p) => set(cl.n, p)} onSave={() => void save(cl.n)} />)}</ul>
      <section className={card} data-testid="part-mine" aria-labelledby="mine-h">
        <h2 id="mine-h" className="text-lg font-bold">{c("fb.mineTitle")}</h2>
        {mineList.length === 0 ? <p className="text-sm" data-testid="part-mine-empty">{c("fb.mineEmpty")}</p> : (
          <ul className="space-y-1 text-sm">
            {mineList.map((f) => (
              <li key={f.n} data-testid="part-mine-item" data-clause={f.n} data-comment-status={f.comment_status}>
                <strong>{c("cl.n", { n: f.n })}</strong>: {cs.stances.find((s) => s.id === f.stance)?.[lang] ?? f.stance}
                {f.comment ? ` - ${c(`fb.cs.${f.comment_status}` as ConsKey)}` : ""}{f.public_ok ? ` - ${c("fb.publicYes")}` : ""}
              </li>
            ))}
          </ul>
        )}
        <a className={btnLinkSecondary} href={`#/consultations/${cs.id}`}>{c("a.details")}</a>
      </section>
    </Page>
  );
}
