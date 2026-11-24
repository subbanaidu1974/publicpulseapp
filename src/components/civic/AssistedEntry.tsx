import { useEffect, useState } from "react";
import { CivicApiError, assistedApi, civicIdentityApi, issuesApi, type AssistedConsent, type AssistedReceipt } from "../../api/civic";
import { useT } from "../../i18n";
import { useCategories } from "./categories";
import { useCivicT, type CivicKey } from "./civicText";
import { Btn, ErrorNote, Field, TextInput, inputCls } from "./ui";

type Step = "consent" | "partner" | "form" | "receipt";
const TICKS = ["adult", "explained", "willing_self", "deletion_known"] as const;
const EMPTY: AssistedConsent = { adult: false, explained: false, willing_self: false, deletion_known: false };
const SCRIPT: CivicKey[] = ["c.as.script1", "c.as.script2", "c.as.script3", "c.as.script4", "c.as.script5"];

const errorKey = (e: unknown): CivicKey => {
  if (!(e instanceof CivicApiError)) return "c.as.errGeneric";
  const code = String((e.body as { code?: unknown }).code ?? "");
  const map: Record<string, CivicKey> = {
    consent_required: "c.as.errConsent", adult_required: "c.as.errAdult", personal_field_not_allowed: "c.as.errPersonal", pair_daily_cap: "c.as.errPairCap", village_daily_cap: "c.as.errVillageCap",
    partner_auth_required: "c.as.errPartner", not_a_pair: "c.as.errPartner", two_assistants_required: "c.as.errPartner", pair_suspended: "c.as.errSuspended", rate_limited: "c.as.errRate", description_required: "c.as.errDesc",
  };
  return map[code] ?? (e.status === 429 ? "c.as.errRate" : "c.as.errGeneric");
};

/**
 * Assisted entry (S-49). Shown only to a volunteer who is in an active pair while the server has the feature on (it answers 404 assisted_disabled otherwise).
 * Order is fixed: consent first (both assistants tick every box), then the partner signs in with their own PIN, then the issue is written, then the receipt.
 * Nothing about the person is asked for or kept: no name, phone, age or photo.
 */
export default function AssistedEntry() {
  const c = useCivicT();
  const { lang } = useT();
  const { cats, label } = useCategories();
  const [pair, setPair] = useState<{ village: { name_en: string; name_te: string | null } | null } | null | undefined>(undefined); // undefined = loading, null = no pair
  const [shown, setShown] = useState(false);
  const [myId, setMyId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("consent");
  const [a, setA] = useState<AssistedConsent>(EMPTY);
  const [b, setB] = useState<AssistedConsent>(EMPTY);
  const [phone, setPhone] = useState(""); const [pin, setPin] = useState("");
  const [partner, setPartner] = useState<string | null>(null);
  const [category, setCategory] = useState("water");
  const [words, setWords] = useState(""); const [wordsLang, setWordsLang] = useState<"en" | "te">(lang === "te" ? "te" : "en");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AssistedReceipt | null>(null);

  useEffect(() => {
    let live = true;
    assistedApi.myPair().then((p) => { if (!live) return; setShown(true); setPair(p ? { village: p.village } : null); issuesApi.me().then((m) => { if (live) setMyId(m.personId ?? null); }).catch(() => { /* optional */ }); })
      .catch(() => { if (live) setShown(false); }); // 404 assisted_disabled (feature off) or 403 (not a volunteer): show nothing
    return () => { live = false; };
  }, []);
  if (!shown || pair === undefined) return null;

  const allTicked = (t: AssistedConsent) => TICKS.every((k) => t[k]);
  const reset = () => { setStep("consent"); setA(EMPTY); setB(EMPTY); setPhone(""); setPin(""); setPartner(null); setWords(""); setReceipt(null); setErr(null); };
  const signInPartner = async () => {
    setErr(null); setBusy(true);
    try { const s = await civicIdentityApi.loginAs({ phone, pin }); setPartner(s.token); setPin(""); setStep("form"); }
    catch { setErr(c("c.as.partnerFail")); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!partner) return;
    if (!words.trim()) return void setErr(c("c.as.errDesc"));
    setErr(null); setBusy(true);
    try {
      const r = await assistedApi.record(partner, { category, ...(wordsLang === "te" ? { description_te: words.trim() } : { description_en: words.trim() }), consent_a: a, consent_b: b });
      setReceipt(r); setPartner(null); setWords(""); setStep("receipt");
    } catch (e) { setErr(c(errorKey(e))); } finally { setBusy(false); }
  };
  const tickBox = (who: "a" | "b", t: AssistedConsent, set: (v: AssistedConsent) => void) => (
    <fieldset className="border border-black p-3 space-y-1">
      <legend className="px-1 font-bold text-sm">{c(who === "a" ? "c.as.assistantA" : "c.as.assistantB")}</legend>
      {TICKS.map((k) => (
        <label key={k} className="flex items-start gap-2 text-sm min-h-[44px]">
          <input type="checkbox" data-testid={`as-tick-${who}-${k}`} checked={t[k]} onChange={(e) => set({ ...t, [k]: e.target.checked })} className="mt-1" />
          <span>{c(`c.as.tick.${k}` as CivicKey)}</span>
        </label>
      ))}
    </fieldset>
  );

  return (
    <section data-testid="assisted-entry" aria-labelledby="as-h" className="space-y-3 border-t border-black pt-4">
      <h2 id="as-h" className="text-xl font-bold">{c("c.as.title")}</h2>
      {pair === null ? <p className="text-sm" data-testid="as-nopair">{c("c.as.noPair")}</p> : (
        <>
          <p className="text-sm">{c("c.as.help")}</p>
          <p className="text-sm" data-testid="as-pair">{c("c.as.pairOf")}: <strong>{(lang === "te" ? pair.village?.name_te : null) ?? pair.village?.name_en}</strong></p>
          {myId && <p className="text-xs break-all">{c("c.as.myId")}: <code data-testid="as-myid">{myId}</code></p>}
          {step === "consent" && (
            <div className="space-y-3" data-testid="as-step-consent">
              <h3 className="font-bold">{c("c.as.s1")}</h3>
              <div className="border border-black p-3 space-y-2 text-sm" data-testid="as-script">
                <p className="font-bold">{c("c.as.scriptTitle")}</p>
                <ol className="list-decimal pl-5 space-y-1">{SCRIPT.map((k) => <li key={k}>{c(k)}</li>)}</ol>
              </div>
              {tickBox("a", a, setA)}
              {tickBox("b", b, setB)}
              <Btn data-testid="as-consent-next" disabled={!allTicked(a) || !allTicked(b)} onClick={() => setStep("partner")}>{c("c.as.next")}</Btn>
            </div>
          )}
          {step === "partner" && (
            <div className="space-y-3" data-testid="as-step-partner">
              <h3 className="font-bold">{c("c.as.s2")}</h3>
              <p className="text-xs">{c("c.as.partnerHelp")}</p>
              <Field id="as-pp" label={c("c.as.partnerPhone")}><TextInput id="as-pp" data-testid="as-partner-phone" inputMode="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
              <Field id="as-pn" label={c("c.as.partnerPin")}><TextInput id="as-pn" data-testid="as-partner-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
              <div className="flex gap-2 flex-wrap">
                <Btn secondary onClick={() => setStep("consent")}>{c("c.as.back")}</Btn>
                <Btn data-testid="as-partner-signin" disabled={busy || !phone || !pin} onClick={() => void signInPartner()}>{c("c.as.partnerSignIn")}</Btn>
              </div>
            </div>
          )}
          {step === "form" && (
            <div className="space-y-3" data-testid="as-step-form">
              <h3 className="font-bold">{c("c.as.s3")}</h3>
              <p role="status" className="text-sm" data-testid="as-partner-ok">{c("c.as.partnerOk")}</p>
              <Field id="as-cat" label={c("c.as.category")}>
                <select id="as-cat" data-testid="as-category" className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>{cats.map((k) => <option key={k.id} value={k.id}>{label(k.id)}</option>)}</select>
              </Field>
              <Field id="as-lang" label={c("c.as.wordsLang")}>
                <select id="as-lang" data-testid="as-lang" className={inputCls} value={wordsLang} onChange={(e) => setWordsLang(e.target.value as "en" | "te")}><option value="en">{c("c.as.langEn")}</option><option value="te">{c("c.as.langTe")}</option></select>
              </Field>
              <Field id="as-words" label={c("c.as.words")}>
                <textarea id="as-words" data-testid="as-words" className={inputCls} rows={4} maxLength={2000} aria-describedby="as-words-h" value={words} onChange={(e) => setWords(e.target.value)} />
              </Field>
              <p id="as-words-h" className="text-xs">{c("c.as.wordsHelp")}</p>
              <ErrorNote msg={err} />
              <Btn data-testid="as-save" disabled={busy} onClick={() => void save()}>{busy ? c("c.as.saving") : c("c.as.save")}</Btn>
            </div>
          )}
          {step !== "form" && <ErrorNote msg={err} />}
          {step === "receipt" && receipt && (
            <div className="space-y-3 border border-black p-3" data-testid="as-step-receipt" role="status">
              <h3 className="font-bold">{c("c.as.receiptTitle")}</h3>
              <p className="text-sm">{c("c.as.receiptCode")}</p>
              <p className="text-3xl font-mono font-bold tracking-widest break-all" data-testid="as-receipt-code">{receipt.receiptCode}</p>
              <p className="text-sm">{c("c.as.receiptHelp")}</p>
              {receipt.held && <p className="text-sm font-bold" data-testid="as-held">{c("c.as.held")}</p>}
              {receipt.recheckQueued && <p className="text-xs">{c("c.as.queued")}</p>}
              <Btn data-testid="as-another" onClick={reset}>{c("c.as.another")}</Btn>
            </div>
          )}
        </>
      )}
    </section>
  );
}
