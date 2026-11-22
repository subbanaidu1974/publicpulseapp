import { useState } from "react";
import { civicApi, tokenStore, type Session } from "../../api/civic";
import { useCivicT } from "./civicText";
import { ErrorNote, Field, TextInput, primaryBtnCls } from "./ui";

export default function LoginFlow({ onDone }: { onDone: (s: Session) => void }) {
  const c = useCivicT();
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form data-testid="login-flow" className="space-y-4 max-w-md" aria-label={c("c.login")} onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try { const s = await civicApi.login({ phone, pin }); tokenStore.set(s.token); onDone(s); } catch { setErr(c("c.error")); } finally { setBusy(false); }
    }}>
      <h2 className="text-xl font-bold">{c("c.login")}</h2>
      <Field id="li-phone" label={c("c.phone")}>
        <TextInput id="li-phone" data-testid="li-phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
      </Field>
      <Field id="li-pin" label={c("c.pinLogin")}>
        <TextInput id="li-pin" data-testid="li-pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
      </Field>
      <button type="submit" data-testid="li-submit" disabled={busy || phone.length !== 10 || pin.length < 4} className={primaryBtnCls}>{c("c.login")}</button>
      <ErrorNote msg={err} />
    </form>
  );
}
