import { useEffect, useState } from "react";
import { civicIdentityApi, errCode, errKind, tokenStore, type InviteNotice, type Session } from "../../api/civic";
import { useT } from "../../i18n";
import { useCivicT } from "./civicText";
import LoginFlow from "./LoginFlow";
import SignUpFlow from "./SignUpFlow";
import { Btn, ErrorNote, Field, TextInput } from "./ui";

type Outcome = "accepted" | "declined" | "reported" | null;

/**
 * Deep link ?invite=<code>. The notice is fetched and shown before anything is stored (the notice route needs no sign-in).
 * Answering needs the invited person's own sign-in; accepting sets (or verifies) their own PIN.
 */
export default function InviteAccept({ inviteId, session, onSession, onFinish }: {
  inviteId: string; session: Session | null; onSession: (s: Session) => void; onFinish: () => void;
}) {
  const c = useCivicT();
  const { lang } = useT();
  const te = lang === "te";
  const [info, setInfo] = useState<InviteNotice | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "gone" | "failed">("loading");
  const [read, setRead] = useState(false);
  const [pin, setPin] = useState("");
  const [existingPin, setExistingPin] = useState(false);
  const [signup, setSignup] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    civicIdentityApi.inviteNotice(inviteId)
      .then((n) => { if (live) { setInfo(n); setState("ok"); } })
      .catch((x) => { if (live) setState(errKind(x) === "gone" ? "gone" : "failed"); });
    return () => { live = false; };
  }, [inviteId]);

  const answer = async (fn: () => Promise<unknown>, done: Outcome) => {
    setBusy(true); setErr(null);
    try { await fn(); setOutcome(done); } catch (x) {
      const k = errKind(x), code = errCode(x);
      if (code === "phone_mismatch") setErr(c("c.inv.wrongPhone"));
      else if (code === "wrong_pin") { setErr(c("c.inv.wrongPin")); setExistingPin(true); }
      else if (code === "pin_locked" || k === "locked") setErr(c("c.inv.pinLocked"));
      else if (code === "weak_pin") setErr(c("c.recover.weak"));
      else if (k === "gone") setErr(c("c.inv.expired"));
      else if (k === "conflict") setErr(c("c.inv.used"));
      else setErr(c("c.error"));
    } finally { setBusy(false); }
  };

  const status = info?.status;
  const notice = info?.notice;
  return (
    <section data-testid="invite-accept" aria-labelledby="inv-title" className="space-y-4 max-w-md">
      <h2 id="inv-title" className="text-xl font-bold">{c("c.inv.title")}</h2>
      {state === "loading" && <p role="status" className="text-sm">{c("c.loading")}</p>}
      {state === "gone" && <p role="alert" data-testid="inv-gone" className="border border-black p-3 text-sm font-bold">{c("c.inv.gone")}</p>}
      {state === "failed" && <p role="alert" data-testid="inv-failed" className="border border-black p-3 text-sm font-bold">{c("c.noticeFail")}</p>}
      {state === "ok" && (status === "expired") && <p role="alert" data-testid="inv-expired" className="border border-black p-3 text-sm font-bold">{c("c.inv.expired")}</p>}
      {state === "ok" && status !== "pending" && status !== "expired" && <p role="alert" data-testid="inv-used" className="border border-black p-3 text-sm font-bold">{c("c.inv.used")}</p>}
      {state === "ok" && status === "pending" && !outcome && (
        <>
          <p className="text-sm font-bold">{c("c.inv.before")}</p>
          {notice && (
            <div data-testid="inv-notice" className="border border-black bg-[#FAF8F5] p-4 space-y-2">
              <span className="inline-block text-[10px] font-black uppercase bg-amber-200 text-amber-950 border border-amber-700 px-2 py-0.5">{c("c.draft")}</span>
              <h3 lang={te ? "te" : "en"} className="text-lg font-bold">{notice.title[te ? "te" : "en"]}</h3>
              <p lang={te ? "te" : "en"} data-testid="inv-notice-text" className="text-sm leading-relaxed">{notice.text[te ? "te" : "en"]}</p>
              <p className="text-xs">{c("c.version")}: {notice.version}</p>
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input data-testid="inv-read" type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} className="mt-0.5" />
            <span>{c("c.agree")}</span>
          </label>
          {!session ? (
            <div data-testid="inv-signin" className="space-y-3">
              <p className="text-sm">{c("c.inv.signin")}</p>
              {signup ? <SignUpFlow onDone={onSession} /> : <LoginFlow onDone={onSession} />}
              <button type="button" className="underline text-sm min-h-[44px]" onClick={() => setSignup((v) => !v)}>{signup ? c("c.login") : c("c.signup")}</button>
            </div>
          ) : (
            <div className="space-y-3">
              <Field id="inv-pin" label={existingPin ? c("c.inv.pinOwn") : c("c.inv.pinNew")}>
                <TextInput id="inv-pin" data-testid="inv-pin" type="password" inputMode="numeric" autoComplete={existingPin ? "current-password" : "new-password"} maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
              </Field>
              <div className="flex flex-wrap gap-3">
                <Btn data-testid="inv-accept" disabled={busy || !read || pin.length < 4} onClick={() => answer(() => civicIdentityApi.acceptInvite(inviteId, pin), "accepted")}>{c("c.inv.accept")}</Btn>
                <Btn secondary data-testid="inv-decline" disabled={busy} onClick={() => answer(() => civicIdentityApi.declineInvite(inviteId), "declined")}>{c("c.inv.decline")}</Btn>
              </div>
              <Btn secondary data-testid="inv-notagreed" disabled={busy} onClick={() => answer(() => civicIdentityApi.reportNotAgreed(inviteId), "reported")}>{c("c.inv.notAgreed")}</Btn>
            </div>
          )}
        </>
      )}
      {outcome && <p role="status" data-testid={`inv-${outcome}`} className="border border-black p-3 text-sm font-bold">{c(`c.inv.${outcome}` as "c.inv.accepted")}</p>}
      <ErrorNote msg={err} />
      <Btn secondary data-testid="inv-home" onClick={() => { if (!session) tokenStore.clear(); onFinish(); }}>{c("c.inv.home")}</Btn>
    </section>
  );
}
