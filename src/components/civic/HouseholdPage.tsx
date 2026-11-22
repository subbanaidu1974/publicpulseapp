import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n";
import ConsentNotice from "./ConsentNotice";

const API = "/api/v1/civic/households";

interface Member { id: string; relation: string; status: string; isHead: boolean; isYou: boolean; personId?: string; yearOfBirth?: number }
interface Invite { id: string; relation: string; status: string; expiresAt: number }
interface Roster { id: string; isHead: boolean; members: Member[]; invites: Invite[] }

const ADULT_RELATIONS = ["spouse", "parent", "son", "daughter", "sibling", "relative", "other"];
const DEPENDENT_RELATIONS = ["son", "daughter", "grandchild", "sibling", "ward", "other"];
const PARENTAL_CONSENT_VERSION = "v1";

/** Household roster, adult invite, minor dependents. Shows members and statuses only, never answers or phone numbers. */
export default function HouseholdPage({ token }: { token?: string | null }) {
  const { lang } = useT();
  const te = lang === "te";
  const tx = (en: string, t: string) => (te ? t : en);
  const auth = token ?? (typeof localStorage !== "undefined" ? localStorage.getItem("pp-token") : null);

  const [roster, setRoster] = useState<Roster | null>(null);
  const [noHousehold, setNoHousehold] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [relation, setRelation] = useState("spouse");
  const [yob, setYob] = useState("");
  const [depRel, setDepRel] = useState("son");
  const [showConsent, setShowConsent] = useState(false);

  const call = useCallback(async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error ?? String(r.status)), { status: r.status });
    return j;
  }, [auth]);

  const load = useCallback(async () => {
    try { setRoster(await call("GET", "/mine")); setNoHousehold(false); }
    catch (e) { if ((e as { status?: number }).status === 404) { setNoHousehold(true); setRoster(null); } else setErr((e as Error).message); }
  }, [call]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setErr(null); setMsg(null);
    try { await fn(); setMsg(ok); await load(); } catch (e) { setErr((e as Error).message); }
  };

  const btn = "border border-black bg-black text-white px-4 py-1.5 uppercase tracking-widest text-[10px] font-black cursor-pointer disabled:opacity-40";
  const ghost = "border border-black bg-white text-black px-3 py-1 uppercase tracking-widest text-[10px] font-black cursor-pointer";
  const field = "border border-black bg-white text-xs font-sans p-2 min-w-0";

  return (
    <div className="space-y-8">
      <div className="bg-[#FAF8F5] p-6 sm:p-8 border-y border-black">
        <h2 className="text-2xl font-serif italic text-black">{tx("My household", "నా కుటుంబం")}</h2>
        <p className="text-xs text-slate-600 mt-2 max-w-2xl font-serif">
          {tx("The household head can see who is a member, never their answers. Adults join only by accepting an invite with their own PIN.",
            "కుటుంబ పెద్దకు సభ్యులు ఎవరో మాత్రమే తెలుస్తుంది, వారి సమాధానాలు కాదు. పెద్దలు తమ సొంత పిన్‌తో ఆహ్వానాన్ని అంగీకరించి మాత్రమే చేరతారు.")}
        </p>
      </div>

      {err && <p role="alert" data-testid="household-error" className="border border-red-700 bg-red-50 text-red-900 p-3 text-xs font-sans">{err}</p>}
      {msg && <p role="status" data-testid="household-message" className="text-xs font-sans text-green-900">{msg}</p>}

      {noHousehold && (
        <button data-testid="household-create" type="button" className={btn} onClick={() => act(() => call("POST", "/"), tx("Household created", "కుటుంబం సృష్టించబడింది"))}>
          {tx("Create household", "కుటుంబాన్ని సృష్టించు")}
        </button>
      )}

      {roster && (
        <>
          <section aria-labelledby="hh-roster" data-testid="household-roster" className="space-y-2">
            <h3 id="hh-roster" className="text-[10px] uppercase tracking-widest font-sans font-black">{tx("Members", "సభ్యులు")}</h3>
            <ul className="divide-y divide-black/20 border border-black bg-white">
              {roster.members.map((m) => (
                <li key={m.id} data-testid="household-member" className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs font-sans">
                  <span>
                    <strong>{m.isHead ? tx("Head", "పెద్ద") : m.relation}</strong>
                    {m.isYou && <em> ({tx("you", "మీరు")})</em>}
                    {m.status === "dependent" && <> · {tx("dependent, born", "ఆధారితుడు, పుట్టిన సంవత్సరం")} {m.yearOfBirth}</>}
                  </span>
                  <span className="flex gap-2 items-center">
                    <span className="text-slate-500">{m.status}</span>
                    {roster.isHead && m.status === "accepted" && !m.isHead && m.personId && (
                      <button data-testid="household-transfer" type="button" className={ghost} onClick={() => act(() => call("POST", "/transfer-head", { toPersonId: m.personId }), tx("Head role transferred", "పెద్ద బాధ్యత బదిలీ అయింది"))}>
                        {tx("Make head", "పెద్దగా చేయి")}
                      </button>
                    )}
                    {!m.isHead && (roster.isHead || m.isYou) && (
                      <button data-testid="household-remove" type="button" className={ghost} onClick={() => act(() => call("DELETE", `/members/${m.id}`), tx("Removed", "తొలగించబడింది"))}>
                        {m.isYou ? tx("Leave", "వైదొలగు") : tx("Remove", "తొలగించు")}
                      </button>
                    )}
                  </span>
                </li>
              ))}
              {roster.invites.map((i) => (
                <li key={i.id} data-testid="household-pending-invite" className="p-3 text-xs font-sans text-slate-600">
                  {i.relation} · {tx("invited, waiting for their acceptance. Expires", "ఆహ్వానించబడింది, వారి అంగీకారం కోసం వేచి ఉంది. ముగింపు")} {new Date(i.expiresAt).toLocaleString()}
                </li>
              ))}
            </ul>
          </section>

          {roster.isHead && (
            <>
              <section aria-labelledby="hh-invite" className="space-y-3 border border-black p-4">
                <h3 id="hh-invite" className="text-[10px] uppercase tracking-widest font-sans font-black">{tx("Invite an adult", "పెద్దవారిని ఆహ్వానించు")}</h3>
                <p className="text-xs font-serif text-slate-700">{tx("They receive a notice by SMS first. Nothing about them is stored until they accept. The invite expires in 72 hours.", "ముందుగా వారికి SMS ద్వారా నోటీసు వస్తుంది. వారు అంగీకరించే వరకు వారి గురించి ఏమీ నిల్వ చేయము. ఆహ్వానం 72 గంటల్లో ముగుస్తుంది.")}</p>
                <div className="flex flex-wrap gap-3 items-end">
                  <label className="text-[10px] uppercase font-sans font-bold flex flex-col gap-1">{tx("Mobile number", "మొబైల్ నంబర్")}
                    <input data-testid="invite-phone" className={field} inputMode="numeric" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} />
                  </label>
                  <label className="text-[10px] uppercase font-sans font-bold flex flex-col gap-1">{tx("Relation", "బంధుత్వం")}
                    <select data-testid="invite-relation" className={field} value={relation} onChange={(e) => setRelation(e.target.value)}>
                      {ADULT_RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </label>
                  <button data-testid="invite-submit" type="button" className={btn} disabled={!phone}
                    onClick={() => act(async () => { await call("POST", "/members/invite", { phone, relation }); setPhone(""); }, tx("Invitation notice sent", "ఆహ్వాన నోటీసు పంపబడింది"))}>
                    {tx("Send invite", "ఆహ్వానం పంపు")}
                  </button>
                </div>
              </section>

              <section aria-labelledby="hh-dep" className="space-y-3 border border-black p-4">
                <h3 id="hh-dep" className="text-[10px] uppercase tracking-widest font-sans font-black">{tx("Add a child (under 18)", "పిల్లవాడిని చేర్చు (18 లోపు)")}</h3>
                <div className="flex flex-wrap gap-3 items-end">
                  <label className="text-[10px] uppercase font-sans font-bold flex flex-col gap-1">{tx("Year of birth", "పుట్టిన సంవత్సరం")}
                    <input data-testid="dependent-yob" className={field} inputMode="numeric" maxLength={4} value={yob} onChange={(e) => setYob(e.target.value)} />
                  </label>
                  <label className="text-[10px] uppercase font-sans font-bold flex flex-col gap-1">{tx("Relation", "బంధుత్వం")}
                    <select data-testid="dependent-relation" className={field} value={depRel} onChange={(e) => setDepRel(e.target.value)}>
                      {DEPENDENT_RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </label>
                  <button data-testid="dependent-continue" type="button" className={btn} disabled={!/^\d{4}$/.test(yob)} onClick={() => setShowConsent(true)}>
                    {tx("Continue", "కొనసాగు")}
                  </button>
                </div>
                {showConsent && (
                  <ConsentNotice purpose="minor_dependent" version={PARENTAL_CONSENT_VERSION}
                    acceptLabel={tx("I consent as parent or guardian", "తల్లిదండ్రులు/సంరక్షకుడిగా అంగీకరిస్తున్నాను")}
                    onDecline={() => setShowConsent(false)}
                    onAccept={({ version }) => act(async () => {
                      await call("POST", "/dependents", { relation: depRel, yearOfBirth: Number(yob), parentalConsentVersion: version });
                      setShowConsent(false); setYob("");
                    }, tx("Dependent added", "ఆధారితుడు చేర్చబడ్డారు"))} />
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
