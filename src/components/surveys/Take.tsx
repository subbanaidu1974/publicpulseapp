import { useRef, useState } from "react";
import { blind, finalize, keyFromJwk, toB64, type BlindKey, type BlindState } from "../../lib/blind";
import { errorCode, errStatus, surveysApi, type QuestionDto, type SurveyDetail } from "../../api/surveys";
import { useT } from "../../i18n";
import { TakeBox, useTakeState } from "./Detail";
import { type Keyed, Btn, Disclaimer, ErrorLine, Page, ProtectionBox, card, linkCls, pickLang, titleOf, useLoad } from "./shared";
import { useSurveyT, type SurveyKey } from "./surveysText";

type Answer = string | string[] | number;
const AGE_BANDS = ["18-24", "25-34", "35-44", "45-59", "60+"];
const GENDERS = ["M", "F", "O", "NS"];

/** Everything secret lives here, in memory only (never storage, never logs): the blinding state, nonce and the unblinded signature. */
interface Secret { key: BlindKey; st: BlindState; nonce: string; signature: string | null }

const randomNonce = () => toB64(globalThis.crypto.getRandomValues(new Uint8Array(24)));

export function useErrorMessage() {
  const s = useSurveyT();
  return (e: unknown): string => {
    const code = errorCode(e), status = errStatus(e);
    if (status === 0) return s("err.network");
    const k = `err.${code}` as SurveyKey;
    if (s(k) !== k) return s(k);
    if (status === 429) return s("err.rate");
    if (status === 400 && code) return `${s("err.invalid")} (${code})`;
    if (status === 401) return s("err.401");
    if (status === 403) return s("err.403");
    return s("err.generic");
  };
}

async function retryNetwork<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (errStatus(e) !== 0) throw e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  throw last;
}

/** scale5 shows the five scale points (answered 1 to 5) then the optional prefer-not option (answered with its option id). */
function Question({ q, idx, value, onChange }: Keyed & { q: QuestionDto; idx: number; value: Answer | undefined; onChange: (v: Answer) => void }) {
  const s = useSurveyT();
  const { lang } = useT();
  const legend = `${idx + 1}. ${pickLang(q.text_en, q.text_te, lang)}`;
  const opts = q.options.map((o, i) => ({ o, i }));
  const scale = q.kind === "scale5";
  const items = opts.map(({ o, i }) => ({ id: o.id, label: pickLang(o.label_en, o.label_te, lang), preferNot: o.prefer_not, value: scale && !o.prefer_not ? i + 1 : o.id }));
  const name = `q-${q.id}`;
  return (
    <fieldset className={card} data-testid="take-question" data-kind={q.kind}>
      <legend className="font-bold px-1 break-words">{legend}</legend>
      {q.kind === "multi" && <p className="text-xs">{s("take.multiHint").replace("{n}", String(q.max_select ?? 2))}</p>}
      <div className="space-y-1">
        {items.map((it) => {
          const checked = q.kind === "multi" ? Array.isArray(value) && value.includes(String(it.value)) : value === it.value;
          return (
            <label key={it.id} className="flex items-center gap-3 min-h-[44px] text-base cursor-pointer">
              <input
                type={q.kind === "multi" ? "checkbox" : "radio"} name={name} data-testid="take-option" data-prefer-not={it.preferNot ? "1" : undefined} checked={checked}
                onChange={() => {
                  if (q.kind !== "multi") return onChange(it.value);
                  const cur = Array.isArray(value) ? value : [];
                  if (it.preferNot) return onChange(checked ? [] : [String(it.value)]);
                  const without = cur.filter((x) => x !== String(it.value) && !q.options.find((o) => o.id === x)?.prefer_not);
                  if (checked) return onChange(without);
                  if (q.max_select && without.length >= q.max_select) return onChange(without);
                  onChange([...without, String(it.value)]);
                }}
              />
              <span>{it.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function TakePage({ id }: Keyed & { id: string }) {
  const s = useSurveyT();
  const { lang } = useT();
  const errMsg = useErrorMessage();
  const r = useLoad(() => surveysApi.get(id), [id]);
  const sv: SurveyDetail | null = r.data;
  const st = useTakeState(sv);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [age, setAge] = useState(""), [gender, setGender] = useState(""), [shareMandal, setShareMandal] = useState(true), [final, setFinal] = useState(false);
  const [phase, setPhase] = useState<"form" | "working" | "done">("form");
  const [step, setStep] = useState<SurveyKey | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const secret = useRef<Secret | null>(null);

  if (r.loading && !sv) return <Page title={s("loading")}><p role="status">{s("loading")}</p></Page>;
  if (!sv) return <Page title={s("det.notFound")} back={{ label: s("nav.registry"), to: "#/surveys" }}><ErrorLine msg={s("err.load")} /></Page>;

  const complete = sv.questions.every((q) => { const a = answers[q.id]; return Array.isArray(a) ? a.length > 0 : a !== undefined; }) && !!age && !!gender && final;

  const submit = async () => {
    if (st.kind !== "eligible") return;
    setErr(null); setPhase("working");
    try {
      setStep("take.step.key");
      const k = await retryNetwork(() => surveysApi.credentialKey(sv.id, st.elig.key_class));
      if (k.wording_hash !== sv.wording_hash) { const x = new Error("wording"); (x as Error & { code?: string }).code = "wording_changed"; throw x; }
      if (!secret.current) { const key = keyFromJwk(k.key); secret.current = { key, st: await blind(key), nonce: randomNonce(), signature: null }; }
      const sec = secret.current;
      if (!sec.signature) {
        setStep("take.step.credential");
        // The same nonce and the same blinded value are repeated on a retry: the server returns the same signature within 10 minutes.
        const cred = await retryNetwork(() => surveysApi.requestCredential(sv.id, { blinded: sec.st.blindedB64, nonce: sec.nonce, key_class: st.elig.key_class }));
        sec.signature = await finalize(sec.key, sec.st, cred.blind_signature);
      }
      setStep("take.step.send");
      await surveysApi.respondAnonymously(sv.id, {
        token: sec.st.tokenB64, prefix: sec.st.prefixB64, signature: sec.signature, answers,
        strata: { age_band: age, gender, mandal: shareMandal && st.elig.mandal ? st.elig.mandal : "NA" },
      });
      secret.current = null; setAnswers({});
      setPhase("done");
    } catch (e) {
      if ((e as { code?: string }).code === "wording_changed") setErr(s("err.wording_changed"));
      else {
        const code = errorCode(e);
        // a spent credential, a closed survey or an invalid credential cannot be retried with the same material
        if (["token_spent", "invalid_credential", "already_responded", "survey_not_open", "invalid_response", "not_eligible"].includes(code) && code !== "invalid_response") secret.current = null;
        setErr(errMsg(e));
      }
      setPhase("form");
    }
  };

  if (phase === "done") {
    return (
      <Page title={titleOf(sv, lang)}>
        <Disclaimer en={sv.disclaimer_en} te={sv.disclaimer_te} />
        <section className={card} data-testid="take-done" role="status">
          <h2 className="text-lg font-bold">{s("take.done.title")}</h2>
          <p>{s("take.done.body")}</p>
          <p className="text-sm">{s("take.done.noReceipt")}</p>
          <a className={linkCls} href="#/surveys" data-testid="take-done-back">{s("nav.registry")}</a>
        </section>
      </Page>
    );
  }

  return (
    <Page title={titleOf(sv, lang)} back={{ label: s("a.details"), to: `#/surveys/${sv.id}` }}>
      <Disclaimer en={sv.disclaimer_en} te={sv.disclaimer_te} />
      <ProtectionBox />
      <TakeBox sv={sv} />
      {st.kind === "eligible" && (
        <form className="space-y-4" data-testid="take-form" onSubmit={(e) => { e.preventDefault(); if (complete && phase === "form") void submit(); }}>
          {sv.questions.map((q, i) => <Question key={q.id} q={q} idx={i} value={answers[q.id]} onChange={(v) => setAnswers((p) => ({ ...p, [q.id]: v }))} />)}
          <fieldset className={card} data-testid="take-strata">
            <legend className="font-bold px-1">{s("take.strata.title")}</legend>
            <p className="text-sm">{s("take.strata.why")}</p>
            <label className="block text-sm font-bold">{s("take.age")}
              <select data-testid="take-age" className="block w-full border border-black bg-white text-black px-2 text-base font-normal" value={age} onChange={(e) => setAge(e.target.value)}>
                <option value="">{s("take.choose")}</option>{AGE_BANDS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label className="block text-sm font-bold">{s("take.gender")}
              <select data-testid="take-gender" className="block w-full border border-black bg-white text-black px-2 text-base font-normal" value={gender} onChange={(e) => setGender(e.target.value)}>
                <option value="">{s("take.choose")}</option>{GENDERS.map((g) => <option key={g} value={g}>{s(`gender.${g}` as SurveyKey)}</option>)}
              </select>
            </label>
            <p className="text-xs">{s("take.gender.ns")}</p>
            {st.elig.mandal && (
              <label className="flex items-start gap-3 text-sm min-h-[44px]">
                <input type="checkbox" data-testid="take-mandal" checked={shareMandal} onChange={(e) => setShareMandal(e.target.checked)} /><span>{s("take.mandal")}</span>
              </label>
            )}
          </fieldset>
          <label className="flex items-start gap-3 text-sm font-bold min-h-[44px]">
            <input type="checkbox" data-testid="take-final" checked={final} onChange={(e) => setFinal(e.target.checked)} /><span>{s("take.final")}</span>
          </label>
          <ErrorLine msg={err} />
          {phase === "working" && step && <p role="status" data-testid="take-step">{s(step)}</p>}
          <div className="flex flex-wrap gap-3 items-center">
            <Btn type="submit" data-testid="take-submit" disabled={!complete || phase === "working"}>{err && secret.current ? s("take.retry") : s("take.submit")}</Btn>
            {!complete && <span className="text-xs" data-testid="take-incomplete">{s("take.incomplete")}</span>}
          </div>
        </form>
      )}
    </Page>
  );
}
