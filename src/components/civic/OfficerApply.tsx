import { useEffect, useState, type FormEvent } from "react";
import { CivicApiError, issuesApi, officersApi, type OfficerApplication } from "../../api/civic";
import { useCivicT, type CivicKey } from "./civicText";
import { Btn, ErrorNote, Field, TextInput, inputCls } from "./ui";

const errKey = (code: string): CivicKey => ({
  domain_not_allowed: "c.off.errDomain", bad_email: "c.off.errEmail", letter_required: "c.off.errLetter", application_open: "c.off.errOpen", rate_limited: "c.off.errRate",
  already_officer: "c.off.errAlready", name_required: "c.off.errName", unknown_department: "c.off.errDept", jurisdiction_format: "c.off.errArea", unknown_jurisdiction: "c.off.errArea",
} as Record<string, CivicKey>)[code] ?? "c.error";

/**
 * Apply to be a verified government officer (S-141). The server does the domain check and every later step; this form only collects the
 * details, uploads the letter through the ordinary photo upload (so the same size, scan and metadata rules apply) and shows where the
 * application stands. Nobody becomes an officer here: two admins decide.
 */
export default function OfficerApply() {
  const c = useCivicT();
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<OfficerApplication[]>([]);
  const [info, setInfo] = useState<{ domains: { domain: string }[]; departments: string[] } | null>(null);
  const [name, setName] = useState(""), [dept, setDept] = useState(""), [desig, setDesig] = useState(""), [email, setEmail] = useState(""), [area, setArea] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = () => { officersApi.mine().then(setApps).catch(() => { /* signed out */ }); };
  useEffect(reload, []);
  useEffect(() => { if (open && !info) officersApi.domains().then(setInfo).catch(() => { /* the form still works; the server checks */ }); }, [open, info]);
  const openApp = apps.some((a) => a.status === "submitted" || a.status === "awaiting_second_admin");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setMsg(null);
    if (!file) return setErr(c("c.off.errLetter"));
    setBusy(true);
    try {
      const up = await issuesApi.uploadMedia(file);
      await officersApi.apply({ fullName: name.trim(), department: dept, designation: desig.trim(), email: email.trim(), jurisdiction: area.trim(), letterRef: up.ref });
      setMsg(c("c.off.sent")); setFile(null); setName(""); setEmail(""); setDesig(""); setArea(""); setOpen(false); reload();
    } catch (x) { setErr(c(x instanceof CivicApiError ? errKey(String((x.body as { code?: unknown }).code ?? "")) : "c.error")); } finally { setBusy(false); }
  };
  return (
    <section data-testid="officer-apply" aria-labelledby="oa-h" className="space-y-3 border-t border-black pt-4">
      <h2 id="oa-h" className="text-xl font-bold">{c("c.off.title")}</h2>
      {apps.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="font-bold">{c("c.off.mine")}</p>
          <ul className="space-y-1">
            {apps.map((a) => (
              <li key={a.id} data-testid="officer-app" className="border border-black p-2 break-words">
                <span data-testid="officer-app-status">{c(`c.off.s.${a.status}` as CivicKey)}</span> - {a.department}
                {a.canWithdraw && <Btn secondary data-testid="officer-app-withdraw" onClick={async () => { try { await officersApi.withdraw(a.id); setMsg(c("c.off.withdrawn")); reload(); } catch { setErr(c("c.error")); } }}>{c("c.off.withdraw")}</Btn>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!open && !openApp && <Btn secondary data-testid="officer-apply-open" onClick={() => setOpen(true)}>{c("c.off.open")}</Btn>}
      {open && (
        <form className="space-y-2 max-w-md" data-testid="officer-apply-form" onSubmit={(e) => void submit(e)}>
          <p className="text-sm">{c("c.off.help")}</p>
          <Field id="oa-name" label={c("c.off.name")}><TextInput id="oa-name" data-testid="oa-name" autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field id="oa-dept" label={c("c.off.dept")}>
            <select id="oa-dept" data-testid="oa-dept" className={inputCls} value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">{c("c.off.pick")}</option>
              {(info?.departments ?? []).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <Field id="oa-desig" label={c("c.off.desig")}><TextInput id="oa-desig" data-testid="oa-desig" maxLength={80} value={desig} onChange={(e) => setDesig(e.target.value)} /></Field>
          <Field id="oa-email" label={c("c.off.email")}><TextInput id="oa-email" data-testid="oa-email" type="email" inputMode="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {info && info.domains.length > 0 && <p className="text-xs" data-testid="oa-domains">{c("c.off.emailHelp")}: {info.domains.map((d) => d.domain).join(", ")}</p>}
          <Field id="oa-area" label={c("c.off.area")}><TextInput id="oa-area" data-testid="oa-area" maxLength={40} value={area} onChange={(e) => setArea(e.target.value)} /></Field>
          <Field id="oa-letter" label={c("c.off.letter")}><input id="oa-letter" data-testid="oa-letter" type="file" accept="image/jpeg,image/png" className={inputCls} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <p className="text-xs">{c("c.off.privacy")}</p>
          <button type="submit" data-testid="oa-submit" disabled={busy || name.trim().length < 3 || !dept || !email.includes("@") || !file} className="min-h-[44px] px-4 border border-black bg-black text-white font-bold disabled:opacity-60">{c("c.off.submit")}</button>
          <Btn secondary onClick={() => setOpen(false)}>{c("c.chpin.cancel")}</Btn>
        </form>
      )}
      {msg && <p role="status" data-testid="oa-msg">{msg}</p>}
      <ErrorNote msg={err} />
    </section>
  );
}
