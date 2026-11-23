import { useState } from "react";
import { notifyApi, type AdminOrg, type AdminSender, type KillRow } from "../../api/notify";
import { AntiPhishBanner, Btn, type Keyed, ErrorNote, Field, NeedSignIn, Shell, TextInput, card, errorText, linkCls, signedIn, useLoad, usePolicy } from "./shared";
import { useNotifyT } from "./notifyText";

const sel = "min-h-[44px] border border-black bg-white text-black px-3 text-base w-full";

/** Admin side of notifications. Every change needs a current authenticator code (x-totp-code, used once, never kept); the server enforces the second person. */
function AdminBody() {
  const t = useNotifyT();
  const policy = usePolicy();
  const orgs = useLoad(() => notifyApi.adminOrgs(), []);
  const senders = useLoad(() => notifyApi.adminSenders(), []);
  const kills = useLoad(() => notifyApi.kills(), []);
  const [totp, setTotp] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [org, setOrg] = useState({ name: "", kind: "department", letter_ref: "", email_domain: "", contact: "" });
  const [snd, setSnd] = useState({ org_id: "", person_id: "", role: "" });
  const [kill, setKill] = useState({ scope: "org" as "all" | "org", org_id: "", reason: "" });
  const [credId, setCredId] = useState("");
  const code = totp.trim();
  const needCode = code.length !== 6;
  const run = async (fn: (c: string) => Promise<unknown>, ok: string) => {
    setErr(null); setMsg(null);
    try { await fn(code); setMsg(ok); orgs.reload(); senders.reload(); kills.reload(); } catch (e) { setErr(errorText(t, e)); } finally { setTotp(""); }
  };
  if (orgs.loading) return <p role="status">{t("loading")}</p>;
  if (orgs.error) return <p role="alert" data-testid="nt-load-fail" className="font-bold">{errorText(t, orgs.error)}</p>;
  const verified = (orgs.data ?? []).filter((o) => o.status === "verified");
  const roles = policy && org ? policy.org_kinds[verified.find((o) => o.id === snd.org_id)?.kind ?? ""]?.sender_roles ?? [] : [];
  const OrgRow = ({ o }: { o: AdminOrg } & Keyed) => (
    <li className={card} data-testid="adm-org" data-status={o.status} data-name={o.name}>
      <p className="font-bold">{o.name} <span className="text-sm">({t(`kind.${o.kind}`)}, {t(`ostatus.${o.status}`)})</span></p>
      <p className="text-xs break-all">{t("adm.letter")}: {o.letter_ref} - {o.email_domain} - {o.contact}<br />{t("adm.id")}: <code>{o.id}</code></p>
      {o.status === "pending" && (
        <div className="flex flex-wrap gap-2">
          <Btn data-testid="adm-org-verify" disabled={needCode} onClick={() => run((c) => notifyApi.decideOrg(o.id, true, c), t("adm.orgVerified"))}>{t("adm.verify")}</Btn>
          <Btn secondary data-testid="adm-org-reject" disabled={needCode} onClick={() => run((c) => notifyApi.decideOrg(o.id, false, c), t("adm.orgRejected"))}>{t("adm.reject")}</Btn>
        </div>
      )}
    </li>
  );
  const SenderRow = ({ s }: { s: AdminSender } & Keyed) => (
    <li className={card} data-testid="adm-sender" data-status={s.status}>
      <p className="font-bold">{s.org_name} - {t(`role.${s.role}`)} ({t(`sstatus.${s.status}`)})</p>
      <p className="text-xs break-all">{t("adm.person")}: <code>{s.person_id}</code> - {t("adm.keys")}: {s.credentials}</p>
      <div className="flex flex-wrap gap-2">
        {s.status === "pending" && <>
          <Btn data-testid="adm-sender-approve" disabled={needCode} onClick={() => run((c) => notifyApi.decideSender(s.id, "approve", c), t("adm.senderApproved"))}>{t("adm.approve")}</Btn>
          <Btn secondary disabled={needCode} onClick={() => run((c) => notifyApi.decideSender(s.id, "reject", c), t("adm.senderRejected"))}>{t("adm.reject")}</Btn>
        </>}
        {s.status === "active" && <Btn secondary data-testid="adm-sender-revoke" disabled={needCode} onClick={() => run((c) => notifyApi.decideSender(s.id, "revoke", c), t("adm.senderRevoked"))}>{t("adm.revoke")}</Btn>}
      </div>
    </li>
  );
  const KillItem = ({ k }: { k: KillRow } & Keyed) => (
    <li className={card} data-testid="adm-kill" data-released={k.released_at ? "1" : "0"} data-scope={k.scope}>
      <p className="font-bold">{k.scope === "all" ? t("kill.scopeAll") : t("kill.scopeOrg")} - {k.released_at ? t("kill.released") : t("kill.engaged")}</p>
      <p className="text-sm">{k.reason}</p>
      {!k.released_at && (
        <div className="flex flex-wrap gap-2 items-center">
          {!k.release_requested_by ? <Btn secondary data-testid="kill-release-request" disabled={needCode} onClick={() => run((c) => notifyApi.releaseRequest(k.id, c), t("kill.requested"))}>{t("kill.requestRelease")}</Btn> : (
            <>
              <span className="text-sm" data-testid="kill-release-pending">{t("kill.releasePending")}</span>
              <Btn data-testid="kill-release-approve" disabled={needCode} onClick={() => run((c) => notifyApi.releaseApprove(k.id, c), t("kill.releasedMsg"))}>{t("kill.approveRelease")}</Btn>
            </>
          )}
        </div>
      )}
    </li>
  );
  return (
    <div className="space-y-5">
      <section className={card} aria-labelledby="tp-h" data-testid="adm-totp">
        <h3 id="tp-h" className="font-bold text-lg">{t("adm.totpTitle")}</h3>
        <p className="text-sm">{t("adm.totpExplain")}</p>
        <Field id="adm-totp" label={t("adm.totp")}><TextInput id="adm-totp" data-testid="adm-totp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} /></Field>
      </section>
      {msg && <p role="status" data-testid="adm-msg" className="font-bold">{msg}</p>}
      <ErrorNote msg={err} />

      <section className="space-y-2" aria-labelledby="ao-h">
        <h3 id="ao-h" className="font-bold text-lg">{t("adm.orgsTitle")}</h3>
        <p className="text-sm">{t("adm.orgsExplain")}</p>
        <form className={`${card} space-y-2`} data-testid="adm-org-form" onSubmit={(e) => { e.preventDefault(); void run((c) => notifyApi.requestOrg(org, c), t("adm.orgFiled")); }}>
          <Field id="o-name" label={t("adm.orgName")}><TextInput id="o-name" data-testid="org-name" value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} /></Field>
          <Field id="o-kind" label={t("adm.orgKind")}><select id="o-kind" data-testid="org-kind" className={sel} value={org.kind} onChange={(e) => setOrg({ ...org, kind: e.target.value })}>{Object.keys(policy?.org_kinds ?? { department: 1 }).map((k) => <option key={k} value={k}>{t(`kind.${k}`)}</option>)}</select></Field>
          <Field id="o-letter" label={t("adm.letter")}><TextInput id="o-letter" data-testid="org-letter" value={org.letter_ref} onChange={(e) => setOrg({ ...org, letter_ref: e.target.value })} /></Field>
          <Field id="o-domain" label={t("adm.domain")}><TextInput id="o-domain" data-testid="org-domain" value={org.email_domain} onChange={(e) => setOrg({ ...org, email_domain: e.target.value })} /></Field>
          <Field id="o-contact" label={t("adm.contact")}><TextInput id="o-contact" data-testid="org-contact" value={org.contact} onChange={(e) => setOrg({ ...org, contact: e.target.value })} /></Field>
          <button type="submit" data-testid="org-file" disabled={needCode || !org.name || !org.letter_ref || !org.email_domain || !org.contact} className="min-h-[44px] px-4 border border-black bg-black text-white font-bold disabled:opacity-60">{t("adm.file")}</button>
        </form>
        <ul className="space-y-2">{(orgs.data ?? []).map((o) => <OrgRow key={o.id} o={o} />)}</ul>
      </section>

      <section className="space-y-2" aria-labelledby="as-h">
        <h3 id="as-h" className="font-bold text-lg">{t("adm.sendersTitle")}</h3>
        <p className="text-sm">{t("adm.sendersExplain")}</p>
        <form className={`${card} space-y-2`} data-testid="adm-sender-form" onSubmit={(e) => { e.preventDefault(); void run((c) => notifyApi.requestSender(snd, c), t("adm.senderFiled")); }}>
          <Field id="s-org" label={t("adm.pickOrg")}><select id="s-org" data-testid="sender-org" className={sel} value={snd.org_id} onChange={(e) => setSnd({ ...snd, org_id: e.target.value, role: "" })}><option value="">-</option>{verified.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>
          <Field id="s-person" label={t("adm.person")}><TextInput id="s-person" data-testid="sender-person" value={snd.person_id} onChange={(e) => setSnd({ ...snd, person_id: e.target.value.trim() })} /></Field>
          <Field id="s-role" label={t("adm.role")}><select id="s-role" data-testid="sender-role" className={sel} value={snd.role} onChange={(e) => setSnd({ ...snd, role: e.target.value })}><option value="">-</option>{roles.map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}</select></Field>
          <button type="submit" data-testid="sender-file" disabled={needCode || !snd.org_id || !snd.person_id || !snd.role} className="min-h-[44px] px-4 border border-black bg-black text-white font-bold disabled:opacity-60">{t("adm.file")}</button>
        </form>
        <ul className="space-y-2">{(senders.data ?? []).map((s) => <SenderRow key={s.id} s={s} />)}</ul>
        <form className={`${card} space-y-2`} data-testid="adm-cred-form" onSubmit={(e) => { e.preventDefault(); void run((c) => notifyApi.revokeCredential(credId.trim(), c), t("adm.credRevoked")); }}>
          <Field id="c-id" label={t("adm.credId")}><TextInput id="c-id" data-testid="cred-id" value={credId} onChange={(e) => setCredId(e.target.value)} /></Field>
          <button type="submit" data-testid="cred-revoke" disabled={needCode || !credId.trim()} className="min-h-[44px] px-4 border border-black bg-white text-black font-bold disabled:opacity-60">{t("adm.credRevoke")}</button>
        </form>
      </section>

      <section className="space-y-2" aria-labelledby="ak-h" data-testid="adm-kill-panel">
        <h3 id="ak-h" className="font-bold text-lg">{t("kill.title")}</h3>
        <p className="text-sm">{t("kill.explain")}</p>
        {(kills.data ?? []).some((k) => !k.released_at) && <p role="alert" data-testid="kill-active" className="border-2 border-black bg-red-100 text-black p-2 font-bold">{t("kill.banner")}</p>}
        <form className={`${card} space-y-2`} data-testid="kill-form" onSubmit={(e) => { e.preventDefault(); void run((c) => notifyApi.engageKill({ scope: kill.scope, ...(kill.scope === "org" ? { org_id: kill.org_id } : {}), reason: kill.reason.trim() }, c), t("kill.engagedMsg")); }}>
          <Field id="k-scope" label={t("kill.scope")}><select id="k-scope" data-testid="kill-scope" className={sel} value={kill.scope} onChange={(e) => setKill({ ...kill, scope: e.target.value === "all" ? "all" : "org" })}><option value="org">{t("kill.scopeOrg")}</option><option value="all">{t("kill.scopeAll")}</option></select></Field>
          {kill.scope === "org" && <Field id="k-org" label={t("adm.pickOrg")}><select id="k-org" data-testid="kill-org" className={sel} value={kill.org_id} onChange={(e) => setKill({ ...kill, org_id: e.target.value })}><option value="">-</option>{(orgs.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>}
          <Field id="k-reason" label={t("kill.reason")}><TextInput id="k-reason" data-testid="kill-reason" value={kill.reason} onChange={(e) => setKill({ ...kill, reason: e.target.value })} /></Field>
          <button type="submit" data-testid="kill-engage" disabled={needCode || kill.reason.trim().length < 5 || (kill.scope === "org" && !kill.org_id)} className="min-h-[44px] px-4 border border-black bg-black text-white font-bold disabled:opacity-60">{t("kill.engage")}</button>
        </form>
        <ul className="space-y-2">{(kills.data ?? []).map((k) => <KillItem key={k.id} k={k} />)}</ul>
      </section>
    </div>
  );
}

export function AdminNotifyPage() {
  const t = useNotifyT();
  return (
    <Shell title={t("adm.title")} testid="notify-admin">
      <AntiPhishBanner />
      <p className="text-sm">{t("adm.mfaNote")}</p>
      {signedIn() ? <AdminBody /> : <NeedSignIn />}
      <p><a className={linkCls} href="#/notifications/send">{t("adm.backSend")}</a></p>
    </Shell>
  );
}
