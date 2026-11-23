import { useState } from "react";
import { civicIdentityApi, errKind, tokenStore } from "../../api/civic";
import { useCivicT, type CivicKey } from "./civicText";
import { Btn, ErrorNote, Field, TextInput } from "./ui";

/**
 * S-158 Change PIN, linked from the sessions area. Proves the current PIN, refuses weak PINs (the server's weak_pin answer is explained), and on
 * success the server signs out every OTHER device and sends a fresh token for this one, which replaces the stored token.
 */
export default function ChangePin() {
  const c = useCivicT();
  const [open, setOpen] = useState(false);
  const [oldPin, setOld] = useState("");
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const reset = () => { setOld(""); setPin(""); setAgain(""); setErr(null); };
  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 6);
  const valid = /^\d{4,6}$/.test(oldPin) && /^\d{4,6}$/.test(pin) && again.length > 0;

  const submit = async () => {
    setErr(null); setDone(false);
    if (pin !== again) return setErr(c("c.chpin.mismatch"));
    if (pin === oldPin) return setErr(c("c.chpin.same"));
    setBusy(true);
    try {
      const r = await civicIdentityApi.changePin({ oldPin, newPin: pin });
      if (r.token) tokenStore.set(r.token);
      reset(); setDone(true); setOpen(false);
    } catch (e) {
      const k = errKind(e);
      const key: CivicKey = k === "weak_pin" ? "c.chpin.weak" : k === "locked" ? "c.chpin.locked" : k === "limited" ? "c.chpin.limited" : k === "wrong" ? "c.chpin.wrong" : "c.error";
      setErr(c(key));
    } finally { setBusy(false); }
  };

  return (
    <section data-testid="change-pin" aria-labelledby="chpin-h" className="space-y-3 max-w-md">
      {!open && (
        <div className="space-y-2">
          <Btn secondary data-testid="chpin-open" onClick={() => { setOpen(true); setDone(false); }}>{c("c.chpin.open")}</Btn>
          {done && <p role="status" data-testid="chpin-done" className="text-sm font-bold">{c("c.chpin.done")}</p>}
        </div>
      )}
      {open && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void submit(); }}>
          <h2 id="chpin-h" className="text-xl font-bold">{c("c.chpin.title")}</h2>
          <p className="text-xs">{c("c.chpin.hint")}</p>
          <Field id="cp-old" label={c("c.chpin.old")}>
            <TextInput id="cp-old" data-testid="chpin-old" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6} value={oldPin} onChange={(e) => setOld(digits(e.target.value))} />
          </Field>
          <Field id="cp-new" label={c("c.chpin.new")}>
            <TextInput id="cp-new" data-testid="chpin-new" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin} onChange={(e) => setPin(digits(e.target.value))} />
          </Field>
          <Field id="cp-again" label={c("c.chpin.again")}>
            <TextInput id="cp-again" data-testid="chpin-again" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={again} onChange={(e) => setAgain(digits(e.target.value))} />
          </Field>
          <div className="flex gap-2 flex-wrap">
            <button type="submit" data-testid="chpin-submit" disabled={!valid || busy} className="min-h-[44px] min-w-[44px] px-4 py-2 text-sm font-bold border border-black bg-black text-white disabled:opacity-60">{c("c.chpin.submit")}</button>
            <Btn secondary data-testid="chpin-cancel" onClick={() => { reset(); setOpen(false); }}>{c("c.chpin.cancel")}</Btn>
          </div>
          <ErrorNote msg={err} />
        </form>
      )}
    </section>
  );
}
