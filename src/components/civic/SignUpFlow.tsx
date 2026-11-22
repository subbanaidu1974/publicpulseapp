import { useState } from "react";
import { civicApi, tokenStore, type Session } from "../../api/civic";
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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch { setErr(c("c.error")); } finally { setBusy(false); }
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
          <Btn data-testid="su-send-otp" disabled={busy || phone.length !== 10} onClick={() => run(async () => { const r = await civicApi.requestOtp(phone); setDevOtp(r.devOtp ?? null); setStep("otp"); })}>{c("c.sendOtp")}</Btn>
        </>
      )}
      {step === "otp" && (
        <>
          {devOtp && <p data-testid="dev-otp" className="text-xs font-mono border border-dashed border-black p-2">{c("c.devOtp")}: {devOtp}</p>}
          <Field id="su-otp" label={c("c.otp")}>
            <TextInput id="su-otp" data-testid="su-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Btn data-testid="su-otp-next" disabled={otp.length < 4} onClick={() => setStep("pin")}>{c("c.next")}</Btn>
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
      <ErrorNote msg={err} />
    </form>
  );
}
