import { useCallback, useEffect, useState } from "react";
import { civicIdentityApi, errKind, tokenStore, type EnrolmentRow, type Session } from "../../api/civic";
import { useCivicT } from "./civicText";
import { Btn, ErrorNote, Field, TextInput, inputCls } from "./ui";

interface Req { personId: string; label: string; village: string }

/**
 * Volunteer screen: people waiting for a village confirmation, and enrolment of an adult.
 * The volunteer enters a phone number and context only; the adult sets their own PIN on their own device (see VolunteerActivate).
 */
export default function Attestation({ isVolunteer }: { isVolunteer: boolean }) {
  const c = useCivicT();
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [manual, setManual] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [context, setContext] = useState<"household" | "shg">("household");
  const [label, setLabel] = useState("");
  const [mine, setMine] = useState<EnrolmentRow[]>([]);
  const loadMine = useCallback(() => { civicIdentityApi.listEnrolments().then(setMine).catch(() => setMine([])); }, []);
  const [enrolMsg, setEnrolMsg] = useState<string | null>(null);

  const load = useCallback(() => { civicIdentityApi.attestRequests().then(setReqs).catch(() => setReqs([])); }, []);
  useEffect(() => { if (isVolunteer) { load(); loadMine(); } }, [isVolunteer, load, loadMine]);

  const fail = (x: unknown) => {
    const k = errKind(x);
    setErr(k === "forbidden" ? c("c.att.notVolunteer") : k === "limited" ? c("c.att.limitDay") : k === "conflict" ? c("c.att.same") : c("c.error"));
  };
  const confirm = async (id: string) => {
    setErr(null); setMsg(null);
    try { const r = await civicIdentityApi.attest(id); setMsg(`${c("c.att.confirmed")}: ${r.attestors}`); setManual(""); load(); } catch (x) { fail(x); }
  };

  return (
    <section data-testid="attestation" aria-labelledby="att-title" className="space-y-4 max-w-md">
      <h2 id="att-title" className="text-xl font-bold">{c("c.att.title")}</h2>
      <p className="text-sm">{c("c.att.intro")}</p>
      <p data-testid="att-two" className="border border-black bg-[#FAF8F5] p-3 text-sm">{c("c.att.two")}</p>
      {!isVolunteer ? (
        <p data-testid="att-not-volunteer" className="text-sm">{c("c.att.notVolunteer")}</p>
      ) : (
        <>
          <h3 className="font-bold">{c("c.att.requests")}</h3>
          {reqs && reqs.length === 0 && <p data-testid="att-none" className="text-sm">{c("c.att.none")}</p>}
          <ul className="space-y-2">
            {(reqs ?? []).map((r, i) => (
              <li key={r.personId} data-testid="att-request" className="border border-black p-3 space-y-2">
                <p className="font-bold break-words">{r.label.trim() || `${c("c.login.adult")} ${i + 1}`}</p>
                {r.village && <p className="text-sm break-words">{r.village}</p>}
                <Btn data-testid="att-confirm" onClick={() => confirm(r.personId)}>{c("c.att.confirm")}</Btn>
              </li>
            ))}
          </ul>
          <Field id="att-manual" label={c("c.att.manual")}>
            <TextInput id="att-manual" data-testid="att-manual" value={manual} maxLength={64} onChange={(e) => setManual(e.target.value.trim())} />
          </Field>
          <Btn secondary data-testid="att-manual-confirm" disabled={manual.length < 8} onClick={() => confirm(manual)}>{c("c.att.confirm")}</Btn>
          {msg && <p role="status" data-testid="att-done" className="text-sm font-bold">{msg}</p>}

          <h3 className="font-bold pt-2">{c("c.att.enrolTitle")}</h3>
          <p className="text-sm">{c("c.att.enrolNote")}</p>
          <Field id="enrol-phone" label={c("c.phone")}>
            <TextInput id="enrol-phone" data-testid="enrol-phone" type="tel" inputMode="numeric" autoComplete="off" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field id="enrol-context" label={c("c.att.context")}>
            <select id="enrol-context" data-testid="enrol-context" className={inputCls} value={context} onChange={(e) => setContext(e.target.value as "household" | "shg")}>
              <option value="household">{c("c.att.ctxHousehold")}</option>
              <option value="shg">{c("c.att.ctxShg")}</option>
            </select>
          </Field>
          <Field id="enrol-label" label={c("c.att.label")}>
            <TextInput id="enrol-label" data-testid="enrol-label" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          {/* Deliberately no PIN field: the volunteer never chooses, hears or sees an adult's PIN. */}
          <Btn data-testid="enrol-send" disabled={phone.length !== 10} onClick={async () => {
            setErr(null); setEnrolMsg(null);
            try { await civicIdentityApi.enrolAdult({ phone, context, label: label.trim() || undefined }); setEnrolMsg(c("c.att.enrolSent")); setPhone(""); setLabel(""); loadMine(); } catch (x) { fail(x); }
          }}>{c("c.att.enrolSend")}</Btn>
          {enrolMsg && <p role="status" data-testid="enrol-sent" className="text-sm font-bold">{enrolMsg}</p>}
          <h3 className="font-bold pt-2">{c("c.att.mine")}</h3>
          {mine.length === 0 && <p data-testid="enrol-none" className="text-sm">{c("c.att.mineNone")}</p>}
          <ul className="space-y-2">
            {mine.map((e) => (
              <li key={e.id} data-testid="enrol-row" className="border border-black p-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm break-words min-w-0">{e.label || c(e.contextKind === "shg" ? "c.att.ctxShg" : "c.att.ctxHousehold")} - {c(`c.att.st.${e.status}` as "c.att.st.pending")}</span>
                {e.status === "pending" && <Btn secondary data-testid="enrol-cancel" onClick={async () => { try { await civicIdentityApi.cancelEnrolment(e.id); setEnrolMsg(c("c.att.cancelled")); loadMine(); } catch (x) { fail(x); } }}>{c("c.att.cancel")}</Btn>}
              </li>
            ))}
          </ul>
        </>
      )}
      <ErrorNote msg={err} />
    </section>
  );
}

/** Deep link ?activate=<code>: the enrolled adult enters the SMS code and chooses their own PIN on their own device. */
export function VolunteerActivate({ code: initialCode, onDone }: { code: string; onDone: (s: Session) => void }) {
  const c = useCivicT();
  const [code, setCode] = useState(initialCode);
  const [otp, setOtp] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form data-testid="activate-flow" aria-label={c("c.att.actTitle")} className="space-y-4 max-w-md" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try { const s = await civicIdentityApi.activate({ code, otp, pin }); tokenStore.set(s.token); onDone(s); }
      catch (x) { setErr(errKind(x) === "weak_pin" ? c("c.recover.weak") : errKind(x) === "network" ? c("c.error") : c("c.att.actBad")); } finally { setBusy(false); }
    }}>
      <h2 className="text-xl font-bold">{c("c.att.actTitle")}</h2>
      <p className="text-sm">{c("c.att.actIntro")}</p>
      <p className="text-sm">{c("c.scam")}</p>
      <Field id="act-code" label={c("c.att.code")}>
        <TextInput id="act-code" data-testid="act-code" autoCapitalize="characters" autoComplete="off" maxLength={20} value={code} onChange={(e) => setCode(e.target.value.trim().toUpperCase())} />
      </Field>
      <Field id="act-otp" label={c("c.otp")}>
        <TextInput id="act-otp" data-testid="act-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} />
      </Field>
      <Field id="act-pin" label={c("c.att.actPin")}>
        <TextInput id="act-pin" data-testid="act-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
      </Field>
      <button type="submit" data-testid="act-submit" disabled={busy || code.length < 4 || otp.length < 6 || pin.length < 4} className="min-h-[44px] min-w-[44px] px-4 py-2 text-sm font-bold border border-black bg-black text-white disabled:opacity-60">{c("c.submit")}</button>
      <ErrorNote msg={err} />
    </form>
  );
}
