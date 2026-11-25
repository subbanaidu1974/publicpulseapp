import { useState } from "react";
import { civicIdentityApi, errCode } from "../../api/civic";
import { useCivicT } from "./civicText";
import { Btn, ErrorNote, Field, TextInput } from "./ui";

/** S-167: shown to an email-only account. A code texted to a phone number lets the account take part in surveys. */
export default function AddPhone({ onAdded }: { onAdded: () => void }) {
  const c = useCivicT();
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(errCode(e) === "sim_full" ? c("c.addphone.full") : c("c.error")); } finally { setBusy(false); }
  };
  return (
    <section data-testid="add-phone" aria-label={c("c.addphone.title")} className="border border-black p-3 space-y-3 max-w-md">
      <h3 className="font-bold">{c("c.addphone.title")}</h3>
      <p className="text-sm">{c("c.addphone.help")}</p>
      <Field id="ap-phone" label={c("c.phone")}>
        <TextInput id="ap-phone" data-testid="ap-phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
      </Field>
      {!sent ? (
        <Btn data-testid="ap-send" disabled={busy || phone.length !== 10} onClick={() => run(async () => { const r = await civicIdentityApi.requestCode(phone); setDevOtp(r.devOtp ?? null); setSent(true); })}>{c("c.sendOtp")}</Btn>
      ) : (
        <>
          {devOtp && <p data-testid="ap-dev-otp" className="text-xs font-mono border border-dashed border-black p-2">{c("c.devOtp")}: {devOtp}</p>}
          <Field id="ap-otp" label={c("c.otp")}>
            <TextInput id="ap-otp" data-testid="ap-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Btn data-testid="ap-submit" disabled={busy || otp.length < 6} onClick={() => run(async () => { await civicIdentityApi.addPhone({ phone, otp }); onAdded(); })}>{c("c.submit")}</Btn>
        </>
      )}
      <ErrorNote msg={err} />
    </section>
  );
}
