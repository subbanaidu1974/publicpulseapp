import { useEffect, useRef, useState } from "react";
import { civicIdentityApi, errKind, tokenStore, type Session, type SimMember } from "../../api/civic";
import { useCivicT } from "./civicText";
import { Btn, ErrorNote, Field, TextInput, primaryBtnCls } from "./ui";

/**
 * Login. On a shared SIM the server answers person_required with the adults on that number; each is shown by the
 * name or initials chosen at sign-up (never a PIN), the person picks themselves, then enters their own PIN.
 */
export default function LoginFlow({ onDone, onForgot }: { onDone: (s: Session) => void; onForgot?: () => void }) {
  const c = useCivicT();
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [members, setMembers] = useState<SimMember[] | null>(null);
  const [personId, setPersonId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);
  const legendRef = useRef<HTMLLegendElement>(null);

  // Move focus to the picker when it appears, and to the PIN after a pick, so keyboard and screen-reader users are not lost.
  useEffect(() => { if (members) legendRef.current?.focus(); }, [members]);
  useEffect(() => { if (personId) pinRef.current?.focus(); }, [personId]);

  const adultName = (m: SimMember, i: number) => m.label.trim() || `${c("c.login.adult")} ${i + 1}`;

  return (
    <form data-testid="login-flow" className="space-y-4 max-w-md" aria-label={c("c.login")} onSubmit={async (e) => {
      e.preventDefault(); setErr(null); setNotice(null);
      if (members && !personId) { setErr(c("c.login.pickNeed")); return; }
      setBusy(true);
      try {
        const s = await civicIdentityApi.loginAs({ phone, pin, personId: personId || undefined });
        tokenStore.set(s.token); onDone(s);
      } catch (x) {
        setPin("");
        const k = errKind(x);
        if (k === "person_required") {
          const m = civicIdentityApi.membersFrom(x);
          if (m.length) { setMembers(m); setPersonId(""); } else setErr(c("c.error"));
        } else if (k === "locked") setNotice(c("c.login.locked"));
        else if (k === "limited") setNotice(c("c.login.limited"));
        else if (k === "wrong") setErr(c("c.login.wrong"));
        else setErr(c("c.error"));
      } finally { setBusy(false); }
    }}>
      <h2 className="text-xl font-bold">{c("c.login")}</h2>
      <Field id="li-phone" label={c("c.phone")}>
        <TextInput id="li-phone" data-testid="li-phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={10} value={phone}
          onChange={(e) => { setPhone(e.target.value.replace(/\D/g, "")); setMembers(null); setPersonId(""); }} />
      </Field>
      {members && (
        <fieldset data-testid="li-picker" className="border border-black p-3 space-y-2">
          <legend ref={legendRef} tabIndex={-1} className="text-sm font-bold px-1">{c("c.login.who")}</legend>
          <p className="text-xs">{c("c.login.whoHelp")}</p>
          <div role="radiogroup" aria-label={c("c.login.who")} className="space-y-2">
            {members.map((m, i) => (
              <label key={m.personId} className="flex items-center gap-3 border border-black p-2 min-h-[44px] cursor-pointer">
                <input type="radio" name="li-person" data-testid="li-person" value={m.personId} checked={personId === m.personId} onChange={() => setPersonId(m.personId)} />
                <span className="font-bold break-words">{adultName(m, i)}</span>
                {m.locked && <span data-testid="li-person-locked" className="text-xs">({c("c.login.memberLocked")})</span>}
              </label>
            ))}
          </div>
          <button type="button" className="text-xs underline min-h-[44px]" onClick={() => { setMembers(null); setPersonId(""); }}>{c("c.login.change")}</button>
        </fieldset>
      )}
      <Field id="li-pin" label={c("c.pinLogin")}>
        <input ref={pinRef} id="li-pin" data-testid="li-pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6} value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} className="w-full min-h-[44px] border border-black bg-white text-black px-3 py-2 text-base" />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" data-testid="li-submit" disabled={busy || phone.length !== 10 || pin.length < 4} className={primaryBtnCls}>{c("c.login")}</button>
        {onForgot && <Btn secondary data-testid="li-forgot" onClick={onForgot}>{c("c.login.forgot")}</Btn>}
      </div>
      {notice && <p role="alert" data-testid="li-notice" className="border border-black bg-amber-50 text-black text-sm p-3">{notice}</p>}
      <ErrorNote msg={err} />
    </form>
  );
}
