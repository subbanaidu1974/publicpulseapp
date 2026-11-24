import { useState } from "react";
import { civicApi, civicIdentityApi, smsFailed, tokenStore, type Session } from "../../api/civic";
import { QueuedNotice, ShedNotice } from "../DegradedBanner";
import { shedOf, type ShedInfo } from "../../lib/degraded";
import { useCivicT } from "./civicText";
import ConsentNotice from "./ConsentNotice";
import GrievanceContact from "./GrievanceContact";
import { Btn, ErrorNote, Field, TextInput } from "./ui";

type Step = "consent" | "phone" | "otp" | "pin";

/** Consent notice first (before any data is collected), then phone, OTP and a personal PIN. */
export default function SignUpFlow({ onDone }: { onDone: (s: Session) => void }) {
  const c = useCivicT();
  const [step, setStep] = useState<Step>("consent");
  const [consentVersion, setConsentVersion] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [pin, setPin] = useState("");
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [already, setAlready] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shed, setShed] = useState<ShedInfo | null>(null);
  const [queued, setQueued] = useState<{ s: number; at: number } | null>(null);
  const [delivery, setDelivery] = useState<"sent" | "queued" | "failed" | null>(null); // S-164: what the server really did with the text

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null); setShed(null);
    try { await fn(); } catch (e) { const sh = shedOf(e); if (sh) setShed(sh); else if (smsFailed(e)) setErr(c("c.sms.failed")); else setErr(c("c.error")); } finally { setBusy(false); }
  };

  return (
    <form data-testid="signup-flow" className="space-y-4 max-w-md" onSubmit={(e) => e.preventDefault()} aria-label={c("c.signup")}>
      <h2 className="text-xl font-bold">{c("c.signup")}</h2>
      <p className="text-sm">{c("c.scam")}</p>
      {step === "consent" && (
        <>
          <ConsentNotice purpose="signup" onAccept={(n) => { setConsentVersion(n.version); setStep("phone"); }} />
          <GrievanceContact />
        </>
      )}
      {step === "phone" && (
        <>
          <Field id="su-phone" label={c("c.phone")}>
            <TextInput id="su-phone" data-testid="su-phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Btn data-testid="su-send-otp" disabled={busy || phone.length !== 10} onClick={() => run(async () => { const r = await civicIdentityApi.requestCode(phone); setDevOtp(r.devOtp ?? null); setAlready(r.alreadySent); setDelivery(r.delivery ?? null); setQueued(r.queued ? { s: r.expectedDelayS ?? 0, at: Date.now() } : null); setStep("otp"); })}>{c("c.sendOtp")}</Btn>
        </>
      )}
      {step === "otp" && (
        <>
          {queued && <QueuedNotice seconds={queued.s} startedAt={queued.at} />}
          {delivery === "queued" && !queued && !already && <p role="status" data-testid="su-delivery-queued" className="border border-black p-3 text-sm">{c("c.sms.queued")}</p>}
          {already && <p role="status" data-testid="su-already" className="border border-black p-3 text-sm">{c("c.recover.already")}</p>}
          {devOtp && <p data-testid="dev-otp" className="text-xs font-mono border border-dashed border-black p-2">{c("c.devOtp")}: {devOtp}</p>}
          <Field id="su-otp" label={c("c.otp")}>
            <TextInput id="su-otp" data-testid="su-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Btn data-testid="su-otp-next" disabled={otp.length < 4} onClick={() => setStep("pin")}>{c("c.next")}</Btn>
          <Btn secondary data-testid="su-resend" disabled={busy} onClick={() => run(async () => { const r = await civicIdentityApi.requestCode(phone); setDevOtp(r.devOtp ?? devOtp); setAlready(r.alreadySent); setDelivery(r.delivery ?? null); })}>{c("c.sms.resend")}</Btn>
        </>
      )}
      {step === "pin" && (
        <>
          <Field id="su-pin" label={c("c.pin")}>
            <TextInput id="su-pin" data-testid="su-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Btn data-testid="su-submit" disabled={busy || pin.length < 4} onClick={() => run(async () => {
            const s = await civicApi.signUp({ phone, otp, pin, consentVersion });
            tokenStore.set(s.token); onDone(s);
          })}>{c("c.submit")}</Btn>
        </>
      )}
      {shed && <ShedNotice shed={shed} testid="signup-shed" onRetry={() => setShed(null)} />}
      <ErrorNote msg={err} />
    </form>
  );
}
