import { useState } from "react";
import { civicIdentityApi, errKind, tokenStore } from "../../api/civic";
import { useCivicT } from "./civicText";
import { Btn, ErrorNote, Field, TextInput } from "./ui";

type Step = "phone" | "reset" | "done";

/** PIN recovery by one-time code to the SIM number. A reset signs the person out on every device. */
export default function PinRecovery({ onBack }: { onBack: () => void }) {
  const c = useCivicT();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [pin, setPin] = useState("");
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [already, setAlready] = useState(false);
  const [needWho, setNeedWho] = useState(false);
  const [personId, setPersonId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<{ personId: string; label: string }[]>([]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (x) {
      const k = errKind(x);
      if (k === "person_required") {
        const m = civicIdentityApi.membersFrom(x);
        setNeedWho(true); setMembers(m);
        if (!m.length) setErr(c("c.error"));
      } else if (k === "weak_pin") setErr(c("c.recover.weak"));
      else if (k === "limited") setErr(c("c.recover.limited"));
      else if (k === "other") setErr(c("c.recover.badCode"));
      else setErr(c("c.error"));
    } finally { setBusy(false); }
  };

  return (
    <form data-testid="recover-flow" className="space-y-4 max-w-md" aria-label={c("c.recover.title")} onSubmit={(e) => e.preventDefault()}>
      <h2 className="text-xl font-bold">{c("c.recover.title")}</h2>
      <p className="text-sm">{c("c.scam")}</p>
      {step === "phone" && (
        <>
          <p className="text-sm">{c("c.recover.intro")}</p>
          <Field id="rc-phone" label={c("c.phone")}>
            <TextInput id="rc-phone" data-testid="rc-phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Btn data-testid="rc-send" disabled={busy || phone.length !== 10} onClick={() => run(async () => { const r = await civicIdentityApi.requestCode(phone, "recovery"); setDevOtp(r.devOtp ?? null); setAlready(r.alreadySent); setStep("reset"); })}>{c("c.sendOtp")}</Btn>
        </>
      )}
      {step === "reset" && (
        <>
          {already && <p role="status" data-testid="rc-already" className="border border-black p-3 text-sm">{c("c.recover.already")}</p>}
          {devOtp && <p data-testid="dev-otp" className="text-xs font-mono border border-dashed border-black p-2">{c("c.devOtp")}: {devOtp}</p>}
          <Field id="rc-otp" label={c("c.otp")}>
            <TextInput id="rc-otp" data-testid="rc-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} />
          </Field>
          {needWho && members.length > 0 && (
            <fieldset className="border border-black p-3 space-y-2" data-testid="rc-picker">
              <legend className="text-sm font-bold px-1">{c("c.recover.who")}</legend>
              {members.map((m, i) => (
                <label key={m.personId} className="flex items-center gap-3 min-h-[44px]">
                  <input type="radio" name="rc-person" data-testid="rc-person" checked={personId === m.personId} onChange={() => setPersonId(m.personId)} />
                  <span className="font-bold break-words">{m.label.trim() || `${c("c.login.adult")} ${i + 1}`}</span>
                </label>
              ))}
            </fieldset>
          )}
          <Field id="rc-pin" label={c("c.recover.newPin")}>
            <TextInput id="rc-pin" data-testid="rc-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Btn data-testid="rc-submit" disabled={busy || otp.length < 6 || pin.length < 4 || (needWho && !personId)} onClick={() => run(async () => {
            await civicIdentityApi.recoverPin({ phone, otp, newPin: pin, personId: personId || undefined });
            tokenStore.clear(); setPin(""); setStep("done");
          })}>{c("c.recover.reset")}</Btn>
        </>
      )}
      {step === "done" && <p role="status" data-testid="rc-done" className="border border-black p-3 text-sm font-bold">{c("c.recover.done")}</p>}
      <ErrorNote msg={err} />
      <Btn secondary data-testid="rc-back" onClick={onBack}>{step === "done" ? c("c.recover.toLogin") : c("c.login.back")}</Btn>
    </form>
  );
}
