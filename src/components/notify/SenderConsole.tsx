import { useEffect, useState } from "react";
import { CivicApiError } from "../../api/civic";
import { notifyApi, notifyErrCode, notifyErrRules, type LintResult, type MessageDraft, type NotifyMessage, type SenderMe, type Template } from "../../api/notify";
import { WebAuthnClientError, classify, createCredential, getAssertion, webauthnSupported } from "../../lib/webauthn";
import { AntiPhishBanner, Btn, type Keyed, ErrorNote, Field, NeedSignIn, Shell, TextInput, card, categoryLabel, errorText, fmtTime, linkCls, reasonText, signedIn, useLang, useLoad, usePolicy } from "./shared";
import { useNotifyT, type NotifyT } from "./notifyText";

const failText = (t: NotifyT, e: unknown): string => {
  if (e instanceof WebAuthnClientError) return t(`wa.${e.kind}`);
  return errorText(t, e);
};

/** FIDO2 key registration. The browser makes the key; the server verifies it. States: unsupported, cancelled, already registered, insecure context, failed. */
function KeyPanel({ me, onDone }: { me: SenderMe; onDone: () => void }) {
  const t = useNotifyT();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const supported = webauthnSupported();
  const register = async () => {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const opts = await notifyApi.registerOptions();
      const cred = await createCredential(opts);
      await notifyApi.registerVerify(cred);
      setMsg(t("key.done")); onDone();
    } catch (e) { setErr(failText(t, e instanceof CivicApiError ? e : classify(e))); } finally { setBusy(false); }
  };
  return (
    <section aria-labelledby="kp-h" className={card} data-testid="key-panel">
      <h3 id="kp-h" className="font-bold text-lg">{t("key.title")}</h3>
      <p className="text-sm">{t("key.explain")}</p>
      <p data-testid="key-count" role="status">{t("key.count", { n: me.credentials.length })}</p>
      {!supported && <p role="alert" data-testid="key-unsupported" className="font-bold">{t("wa.unsupported")}</p>}
      <Btn data-testid="key-register" disabled={!supported || busy} onClick={register}>{me.credentials.length ? t("key.addAnother") : t("key.register")}</Btn>
      {busy && <p role="status" data-testid="key-busy">{t("key.touch")}</p>}
      {msg && <p role="status" data-testid="key-msg" className="font-bold">{msg}</p>}
      <ErrorNote msg={err} />
    </section>
  );
}

function Timeline({ m }: { m: NotifyMessage }) {
  const t = useNotifyT();
  const steps: { k: string; done: boolean; text: string }[] = [
    { k: "created", done: true, text: `${t("tl.created")} ${fmtTime(m.created_at)}` },
    { k: "approval", done: m.status === "approved" || m.status === "sending" || m.status === "sent" || m.approvals >= m.approvals_required, text: t("tl.approvals", { n: m.approvals, of: m.approvals_required }) },
    { k: "sent", done: m.status === "sent", text: m.sent_at ? `${t("tl.sent")} ${fmtTime(m.sent_at)}` : t("tl.notSent") },
  ];
  return (
    <ol className="text-sm space-y-0.5" aria-label={t("tl.label")} data-testid="timeline">
      {steps.map((s) => <li key={s.k} data-done={s.done ? "1" : "0"}>{s.done ? "[x]" : "[ ]"} {s.text}</li>)}
      {m.status === "blocked" && <li data-testid="tl-blocked" className="font-bold">{t("tl.blocked")}: {reasonText(t, m.blocked_reason ?? "")}</li>}
      {m.status === "cancelled" && <li data-testid="tl-cancelled" className="font-bold">{t("tl.cancelled")}</li>}
    </ol>
  );
}

function MessageCard({ m, me, onChanged, onKill }: { m: NotifyMessage; me: SenderMe; onChanged: () => void; onKill: () => void } & Keyed) {
  const t = useNotifyT();
  const lang = useLang();
  const policy = usePolicy();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mine = m.created_by === me.person_id;
  const act = async (purpose: "approve" | "send") => {
    setErr(null); setBusy(purpose);
    try {
      const ch = await notifyApi.challenge(m.id, purpose);
      const assertion = await getAssertion(ch);
      if (purpose === "approve") await notifyApi.approve(m.id, assertion); else await notifyApi.send(m.id, assertion);
      onChanged();
    } catch (e) {
      if (notifyErrCode(e) === "kill_switch") onKill();
      setErr(failText(t, e)); onChanged();
    } finally { setBusy(null); }
  };
  const cancel = async () => { setErr(null); setBusy("cancel"); try { await notifyApi.cancel(m.id); onChanged(); } catch (e) { setErr(failText(t, e)); } finally { setBusy(null); } };
  return (
    <li className={card} data-testid="msg-row" data-status={m.status} data-id={m.id}>
      <div className="flex flex-wrap gap-2 items-center text-sm">
        <strong>{categoryLabel(policy, m.category, lang)}</strong>
        <span data-testid="msg-status" className="px-2 border border-black font-bold">{t(`status.${m.status}`)}</span>
        {mine && <span className="text-xs">{t("msg.yours")}</span>}
      </div>
      <p>{lang === "te" ? m.text_te : m.text_en}</p>
      <p className="text-xs break-all">{t("msg.hash")}: <code>{m.msg_hash.slice(0, 16)}</code></p>
      <Timeline m={m} />
      {m.status === "pending_approval" && mine && <p className="text-sm" data-testid="msg-wait-other">{t("msg.needOther")}</p>}
      <div className="flex flex-wrap gap-2">
        {m.status === "pending_approval" && !mine && <Btn data-testid="msg-approve" disabled={!!busy} onClick={() => act("approve")}>{t("msg.approve")}</Btn>}
        {m.status === "approved" && <Btn data-testid="msg-send" disabled={!!busy} onClick={() => act("send")}>{t("msg.send")}</Btn>}
        {(m.status === "pending_approval" || m.status === "approved") && <Btn secondary data-testid="msg-cancel" disabled={!!busy} onClick={cancel}>{t("msg.cancel")}</Btn>}
      </div>
      {busy && busy !== "cancel" && <p role="status" data-testid="msg-touch">{t("key.touch")}</p>}
      {m.status === "sent" && m.stats && <p className="text-sm" data-testid="msg-stats">{t("msg.stats", { n: m.stats.audience ?? 0, d: m.stats.delivered ?? 0 })}</p>}
      <ErrorNote msg={err} />
    </li>
  );
}

function Compose({ me, templates, onCreated, onKill }: { me: SenderMe; templates: Template[]; onCreated: () => void; onKill: () => void }) {
  const t = useNotifyT();
  const lang = useLang();
  const policy = usePolicy();
  const org = me.senders.find((s) => s.status === "active")?.org;
  const kindCats = policy && org ? policy.org_kinds[org.kind]?.categories ?? policy.categories : policy?.categories ?? [];
  const [category, setCategory] = useState("");
  const cat = category || kindCats[0] || "civic";
  const [tpl, setTpl] = useState("");
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [en, setEn] = useState("");
  const [te, setTe] = useState("");
  const [state, setState] = useState("AP");
  const [allIn, setAllIn] = useState(false);
  const [units, setUnits] = useState("");
  const [decl, setDecl] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [rules, setRules] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const win = useLoad(() => notifyApi.status(state, org?.id), [state, org?.id]);
  const tpls = templates.filter((x) => x.category === cat);
  const chosen = tpls.find((x) => x.id === tpl);
  const fill = (s: string) => s.replace(/\{([a-z0-9_]+)\}/gi, (_m, n: string) => slots[n] || `{${n}}`);
  const needDecl = win.data ? win.data.window.declaration_needed : true;
  const minReason = policy?.declaration.min_reason_chars ?? 10;
  const max = policy?.limits.text_chars ?? 300;

  // Live check: the server lints what is typed (nothing is created or logged); the answer is advice, the server still checks at create and send.
  const [live, setLive] = useState<{ state: "idle" | "ok" | "fail"; r: LintResult | null }>({ state: "idle", r: null });
  const slotKey = JSON.stringify(slots);
  useEffect(() => {
    const payload = chosen ? { slots, state } : { text_en: en, text_te: te, state };
    const empty = chosen ? Object.values(slots).every((v) => !String(v).trim()) : !en.trim() && !te.trim();
    if (empty) { setLive({ state: "idle", r: null }); return; }
    let on = true;
    const h = setTimeout(() => { notifyApi.lint(payload).then((r) => { if (on) setLive({ state: "ok", r }); }, () => { if (on) setLive({ state: "fail", r: null }); }); }, 400);
    return () => { on = false; clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [en, te, slotKey, state, chosen?.id]);

  const submit = async () => {
    setErr(null); setRules([]); setMsg(null); setBusy(true);
    const unitList = units.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
    const draft: MessageDraft = { category: cat, target: allIn ? { state, all_in_state: true } : { state, units: unitList }, ...(chosen ? { template_id: chosen.id, slots } : { text_en: en.trim(), text_te: te.trim() }), ...(decl ? { declaration: { accepted: true, reason: reason.trim() } } : {}) };
    try {
      await notifyApi.create(draft);
      setMsg(t("compose.created")); setEn(""); setTe(""); setSlots({}); setTpl(""); onCreated();
    } catch (e) {
      const code = notifyErrCode(e);
      if (code === "kill_switch") onKill();
      setErr(errorText(t, e)); setRules(notifyErrRules(e));
      onCreated();
    } finally { setBusy(false); }
  };
  const textOk = chosen ? Object.keys(chosen.slots).every((k) => (slots[k] ?? "").trim()) : en.trim() && te.trim();
  const sel = "min-h-[44px] border border-black bg-white text-black px-3 text-base w-full";
  return (
    <section aria-labelledby="cp-h" className={card} data-testid="compose">
      <h3 id="cp-h" className="font-bold text-lg">{t("compose.title")}</h3>
      <p role="note" className="text-sm font-bold border border-black p-2" data-testid="compose-rules">{t("compose.rules")}</p>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field id="cp-cat" label={t("compose.category")}>
          <select id="cp-cat" data-testid="compose-category" className={sel} value={cat} onChange={(e) => { setCategory(e.target.value); setTpl(""); setSlots({}); }}>
            {kindCats.map((c) => <option key={c} value={c}>{categoryLabel(policy, c, lang)}</option>)}
          </select>
        </Field>
        <Field id="cp-tpl" label={t("compose.template")}>
          <select id="cp-tpl" data-testid="compose-template" className={sel} value={tpl} onChange={(e) => { setTpl(e.target.value); setSlots({}); }}>
            <option value="">{t("compose.freeText")}</option>
            {tpls.map((x) => <option key={x.id} value={x.id}>{x.id} - {x.cleared ? t("tpl.cleared") : t("tpl.notCleared")}</option>)}
          </select>
        </Field>
        {chosen && (
          <div className="space-y-2" data-testid="template-detail" data-cleared={chosen.cleared ? "1" : "0"}>
            <p className="text-sm font-bold" data-testid="template-status">{chosen.cleared ? t("tpl.clearedBy", { by: chosen.cleared_by ?? "", on: chosen.cleared_on ?? "" }) : t("tpl.notClearedLong")}</p>
            {Object.entries(chosen.slots).map(([k, v]) => (
              <div key={k}><Field id={`slot-${k}`} label={`${k} (${t("compose.max", { n: v.max })})`}>
                <TextInput id={`slot-${k}`} data-testid={`slot-${k}`} maxLength={v.max} value={slots[k] ?? ""} onChange={(e) => setSlots({ ...slots, [k]: e.target.value })} />
              </Field></div>
            ))}
            <p className="text-sm" data-testid="template-preview">{fill(lang === "te" ? chosen.text_te : chosen.text_en)}</p>
          </div>
        )}
        {!chosen && (
          <>
            <Field id="cp-en" label={`${t("compose.textEn")} (${en.length}/${max})`}><textarea id="cp-en" data-testid="compose-en" maxLength={max} rows={3} className={sel} value={en} onChange={(e) => setEn(e.target.value)} /></Field>
            <Field id="cp-te" label={`${t("compose.textTe")} (${te.length}/${max})`}><textarea id="cp-te" data-testid="compose-te" lang="te" maxLength={max} rows={3} className={sel} value={te} onChange={(e) => setTe(e.target.value)} /></Field>
          </>
        )}
        <fieldset className="space-y-2 border border-black/40 p-3">
          <legend className="font-bold text-sm">{t("compose.target")}</legend>
          <p className="text-xs">{t("compose.targetRule")}</p>
          <Field id="cp-state" label={t("compose.state")}>
            <select id="cp-state" data-testid="compose-state" className={sel} value={state} onChange={(e) => setState(e.target.value)}><option value="AP">AP</option><option value="TG">TG</option></select>
          </Field>
          <label className="flex items-center gap-3 min-h-[44px]"><input type="checkbox" data-testid="compose-all" checked={allIn} onChange={(e) => setAllIn(e.target.checked)} /><span>{t("compose.allInState")}</span></label>
          {!allIn && <Field id="cp-units" label={t("compose.units")}><TextInput id="cp-units" data-testid="compose-units" value={units} onChange={(e) => setUnits(e.target.value)} /></Field>}
        </fieldset>
        <div role="status" data-testid="compose-window" data-window={win.data?.window.status ?? "unknown"} className="text-sm border border-black p-2">
          {win.loading ? t("loading") : win.error || !win.data ? t("mcc.unavailable") : <>{t(`mcc.state.${win.data.window.status}`)} <span data-testid="compose-window-notice">{lang === "te" ? win.data.window.notice_te : win.data.window.notice_en}</span> {needDecl ? t("compose.declNeeded") : t("compose.declOptional")}</>}
        </div>
        <div role="status" aria-live="polite" data-testid="lint-live" data-state={live.state} data-clean={live.r ? (live.r.clean ? "1" : "0") : ""} className="text-sm border border-black/40 p-2">
          <strong>{t("lint.live")}: </strong>
          {live.state === "idle" ? null : live.state === "fail" ? t("lint.liveFail") : live.r?.clean ? t("lint.liveClean") : (
            <>{t("lint.liveFound")}<ul className="list-disc pl-5">{[...new Set(live.r?.rules ?? [])].map((r) => <li key={r} data-rule={r}>{t(`rule.${r}`)}</li>)}</ul></>
          )}
        </div>
        <fieldset className="space-y-2 border border-black/40 p-3" data-testid="declaration">
          <legend className="font-bold text-sm">{t("compose.declTitle")}</legend>
          <label className="flex items-start gap-3 min-h-[44px]"><input type="checkbox" data-testid="decl-check" checked={decl} onChange={(e) => setDecl(e.target.checked)} /><span className="text-sm">{lang === "te" ? policy?.declaration.text_te : policy?.declaration.text_en}</span></label>
          {decl && <Field id="decl-reason" label={t("compose.declReason", { n: minReason })}><textarea id="decl-reason" data-testid="decl-reason" rows={2} className={sel} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
          {decl && reason.trim().length < minReason && <p className="text-xs" role="note">{t("compose.declShort", { n: minReason })}</p>}
        </fieldset>
        <button type="submit" data-testid="compose-submit" disabled={busy || !textOk || (!allIn && !units.trim()) || (decl && reason.trim().length < minReason)} className="min-h-[44px] px-4 border border-black bg-black text-white font-bold disabled:opacity-60">{t("compose.submit")}</button>
      </form>
      {msg && <p role="status" data-testid="compose-msg" className="font-bold">{msg}</p>}
      <ErrorNote msg={err} />
      {rules.length > 0 && (
        <div data-testid="lint-findings" role="alert" className="border-2 border-black p-2 text-sm">
          <p className="font-bold">{t("lint.title")}</p>
          <ul className="list-disc pl-5">{rules.map((r) => <li key={r} data-rule={r}>{t(`rule.${r}`)}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

/** What the public status route says about sending right now: a standing banner when sending is suspended, before anyone tries to send. */
function StatusBanner({ orgId, tick }: { orgId?: string; tick: number }) {
  const t = useNotifyT();
  const lang = useLang();
  const st = useLoad(() => notifyApi.status("AP", orgId), [orgId, tick]);
  const k = st.data?.kill;
  if (!k?.engaged) return null;
  return (
    <div role="alert" data-testid="status-kill" data-scope={k.scope ?? ""} className="border-2 border-black bg-red-100 text-black p-3 font-bold space-y-1">
      <p>{t("status.kill")}: {lang === "te" ? k.notice_te : k.notice_en}</p>
      {k.since && <p className="text-sm font-normal">{fmtTime(k.since)}</p>}
    </div>
  );
}

function ConsoleBody() {
  const t = useNotifyT();
  const me = useLoad(() => notifyApi.me(), []);
  const [tick, setTick] = useState(0);
  const tpls = useLoad(() => notifyApi.templates(), []);
  const msgs = useLoad(() => (me.data?.can_send ? notifyApi.messages() : Promise.resolve([] as NotifyMessage[])), [me.data?.can_send]);
  const [killed, setKilled] = useState(false);
  if (me.loading) return <p role="status">{t("loading")}</p>;
  if (me.error || !me.data) return <p role="alert" data-testid="nt-load-fail" className="font-bold">{errorText(t, me.error)}</p>;
  const d = me.data;
  const active = d.senders.filter((s) => s.status === "active" && s.org.status === "verified");
  const list = msgs.data ?? [];
  const waiting = list.filter((m) => m.status === "pending_approval" && m.created_by !== d.person_id);
  const rest = list.filter((m) => !waiting.includes(m));
  const refresh = () => { msgs.reload(); me.reload(); setTick((x) => x + 1); };
  const killFromMsgs = killed || list.some((m) => m.blocked_reason === "kill_switch");
  return (
    <div className="space-y-5">
      <StatusBanner orgId={active[0]?.org.id} tick={tick} />
      {killFromMsgs && <p role="alert" data-testid="kill-banner" className="border-2 border-black bg-red-100 text-black p-3 font-bold">{t("kill.banner")}</p>}
      <section className={card} data-testid="sender-status" aria-labelledby="ss-h">
        <h3 id="ss-h" className="font-bold text-lg">{t("sender.title")}</h3>
        {d.senders.length === 0 ? <p data-testid="not-sender">{t("sender.none")}</p> : d.senders.map((s) => (
          <p key={s.sender_id} data-testid="sender-binding" data-status={s.status}>{s.org.name} - {t(`role.${s.role}`)} - {t(`sstatus.${s.status}`)}{s.org.status !== "verified" ? ` (${t("sender.orgNotVerified")})` : ""}</p>
        ))}
      </section>
      {active.length > 0 && <KeyPanel me={d} onDone={refresh} />}
      {d.can_send ? (
        <>
          <Compose me={d} templates={tpls.data ?? []} onCreated={refresh} onKill={() => setKilled(true)} />
          <section aria-labelledby="aq-h" className="space-y-2" data-testid="approval-queue">
            <h3 id="aq-h" className="font-bold text-lg">{t("queue.title")}</h3>
            <p className="text-sm">{t("queue.explain")}</p>
            {waiting.length === 0 ? <p data-testid="queue-empty">{t("queue.empty")}</p> : <ul className="space-y-3">{waiting.map((m) => <MessageCard key={m.id} m={m} me={d} onChanged={refresh} onKill={() => setKilled(true)} />)}</ul>}
          </section>
          <section aria-labelledby="ml-h" className="space-y-2" data-testid="my-messages">
            <h3 id="ml-h" className="font-bold text-lg">{t("msgs.title")}</h3>
            {rest.length === 0 ? <p>{t("msgs.empty")}</p> : <ul className="space-y-3">{rest.map((m) => <MessageCard key={m.id} m={m} me={d} onChanged={refresh} onKill={() => setKilled(true)} />)}</ul>}
          </section>
        </>
      ) : active.length > 0 && <p role="note" data-testid="need-key" className="font-bold">{t("sender.needKey")}</p>}
    </div>
  );
}

export function SendPage() {
  const t = useNotifyT();
  return (
    <Shell title={t("send.title")} testid="notify-send">
      <AntiPhishBanner />
      <p className="text-sm">{t("send.intro")}</p>
      {signedIn() ? <ConsoleBody /> : <NeedSignIn />}
      <p className="text-sm"><a className={linkCls} href="#/notifications/admin">{t("send.adminLink")}</a></p>
    </Shell>
  );
}
