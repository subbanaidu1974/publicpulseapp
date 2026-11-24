import { useState } from "react";
import { notifyApi, type InboxItem, type Prefs } from "../../api/notify";
import { AntiPhishBanner, Btn, ErrorNote, Field, NeedSignIn, Shell, TextInput, card, categoryLabel, errorText, fmtTime, linkCls, signedIn, useLang, useLoad, usePolicy } from "./shared";
import { useNotifyT } from "./notifyText";

/** Inbox: every message shows the person's own anti-phishing word, and the standing banner says real messages show it. */
export function InboxPage() {
  const t = useNotifyT();
  const lang = useLang();
  const policy = usePolicy();
  const inbox = useLoad(() => (signedIn() ? notifyApi.inbox(50) : Promise.resolve(null)), []);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const markRead = async (i: InboxItem) => {
    setErr(null);
    try { await notifyApi.markRead(i.id); inbox.reload(); } catch (e) { setErr(errorText(t, e)); }
  };
  return (
    <Shell title={t("inbox.title")} testid="notify-inbox">
      <AntiPhishBanner />
      {!signedIn() ? <NeedSignIn /> : inbox.loading ? <p role="status">{t("loading")}</p> : inbox.error ? <p role="alert" data-testid="nt-load-fail" className="font-bold">{errorText(t, inbox.error)}</p> : (
        <>
          <p role="status" data-testid="inbox-unread">{t("inbox.unread", { n: inbox.data?.unread ?? 0 })}</p>
          <ErrorNote msg={err} />
          {(inbox.data?.items.length ?? 0) === 0 && <p data-testid="inbox-empty" className={card}>{t("inbox.empty")}</p>}
          <ul className="space-y-3" aria-label={t("inbox.title")}>
            {inbox.data?.items.map((i) => {
              const title = (lang === "te" ? i.title_te : i.title_en) || i.title;
              const text = (lang === "te" ? i.text_te : i.text_en) || i.text;
              return (
                <li key={i.id} data-testid="inbox-item" data-read={i.read ? "1" : "0"} className={`${card} ${i.read ? "" : "border-2 border-black"}`}>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-bold" data-testid="inbox-category">{categoryLabel(policy, i.category, lang)}</span>
                    <span>{i.sender.name}</span>
                    <span>{fmtTime(i.sent_at)}</span>
                    <span data-testid="inbox-state" className="px-2 border border-black font-bold">{i.read ? t("inbox.read") : t("inbox.new")}</span>
                  </div>
                  <h3 className="font-bold">{title}</h3>
                  <p>{text}</p>
                  <p data-testid="inbox-word" className="text-sm border border-black p-2">
                    {i.antiphish_word ? <>{t("inbox.yourWord")}: <strong>{i.antiphish_word}</strong></> : <>{t("inbox.noWord")} <a className={linkCls} href="#/notifications/settings">{t("inbox.setWord")}</a></>}
                  </p>
                  <p className="text-xs">{t("inbox.neverAsk")}</p>
                  <div className="flex flex-wrap gap-2 items-start">
                    {!i.read && <Btn secondary data-testid="inbox-mark-read" onClick={() => markRead(i)}>{t("inbox.markRead")}</Btn>}
                    <Btn secondary aria-expanded={open === i.id} data-testid="inbox-details" onClick={() => setOpen(open === i.id ? null : i.id)}>{t("inbox.details")}</Btn>
                  </div>
                  {open === i.id && (
                    <dl className="text-xs break-all space-y-1" data-testid="inbox-sig">
                      <dt className="font-bold">{t("inbox.keyId")}</dt><dd>{i.key_id ?? "-"}</dd>
                      <dt className="font-bold">{t("inbox.signature")}</dt><dd>{i.signature ?? "-"}</dd>
                      <dd><a className={linkCls} href="#/notifications/keys">{t("inbox.howVerify")}</a></dd>
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Shell>
  );
}

function AntiPhishWord({ onChanged }: { onChanged: () => void }) {
  const t = useNotifyT();
  const policy = usePolicy();
  const cur = useLoad(() => notifyApi.antiphish(), []);
  const [word, setWord] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null); setMsg(null);
    try { await notifyApi.setAntiphish(word.trim()); setMsg(t("word.saved")); setWord(""); cur.reload(); onChanged(); } catch (e) { setErr(errorText(t, e)); }
  };
  return (
    <section aria-labelledby="aw-h" className={card} data-testid="antiphish-panel">
      <h3 id="aw-h" className="font-bold text-lg">{t("word.title")}</h3>
      <p className="text-sm">{t("word.explain")}</p>
      <p role="note" className="text-sm font-bold border border-black p-2" data-testid="word-warning">{t("word.warn")}</p>
      <p className="text-sm" data-testid="word-current">{cur.data?.word ? <>{t("word.current")}: <strong>{cur.data.word}</strong></> : t("word.none")}</p>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-2">
        <Field id="aw-input" label={t("word.label", { min: policy?.limits.antiphish_min ?? 3, max: policy?.limits.antiphish_max ?? 30 })}>
          <TextInput id="aw-input" data-testid="word-input" autoComplete="off" maxLength={policy?.limits.antiphish_max ?? 30} value={word} onChange={(e) => setWord(e.target.value)} />
        </Field>
        <button type="submit" data-testid="word-save" disabled={word.trim().length < (policy?.limits.antiphish_min ?? 3)} className="min-h-[44px] px-4 border border-black bg-black text-white font-bold disabled:opacity-60">{t("word.save")}</button>
      </form>
      {msg && <p role="status" data-testid="word-msg">{msg}</p>}
      <ErrorNote msg={err} />
    </section>
  );
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function SettingsBody() {
  const t = useNotifyT();
  const lang = useLang();
  const policy = usePolicy();
  const prefs = useLoad(() => notifyApi.prefs(), []);
  const devices = useLoad(() => notifyApi.devices(), []);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [qs, setQs] = useState<string | null>(null);
  const [qe, setQe] = useState<string | null>(null);
  const [confirmUnsub, setConfirmUnsub] = useState(false);
  const p: Prefs | null = prefs.data;
  const apply = async (fn: () => Promise<unknown>, ok: string) => {
    setErr(null); setMsg(null);
    try { await fn(); setMsg(ok); prefs.reload(); devices.reload(); } catch (e) { setErr(errorText(t, e)); }
  };
  if (prefs.loading) return <p role="status">{t("loading")}</p>;
  if (prefs.error || !p) return <p role="alert" data-testid="nt-load-fail" className="font-bold">{errorText(t, prefs.error)}</p>;
  const start = qs ?? p.quiet_hours.start, end = qe ?? p.quiet_hours.end;
  const qOk = HHMM.test(start) && HHMM.test(end) && start !== end;
  return (
    <div className="space-y-5">
      <AntiPhishWord onChanged={prefs.reload} />
      <section aria-labelledby="cat-h" className={card} data-testid="categories-panel">
        <h3 id="cat-h" className="font-bold text-lg">{t("cat.title")}</h3>
        <p className="text-sm">{t("cat.explain")}</p>
        <ul className="space-y-1">
          {Object.entries(p.categories).map(([c, v]) => (
            <li key={c}>
              <label className="flex items-center gap-3 min-h-[44px]" data-testid={`cat-${c}`}>
                <input type="checkbox" checked={v.opted_in} disabled={v.locked} onChange={(e) => apply(() => notifyApi.putPrefs({ categories: { [c]: e.target.checked } }), t("saved"))} />
                <span>{categoryLabel(policy, c, lang)}{v.locked && <strong data-testid="cat-locked"> ({t("cat.always")})</strong>}</span>
              </label>
            </li>
          ))}
        </ul>
        <p className="text-sm" data-testid="emergency-note">{t("cat.emergencyNote")}</p>
      </section>
      <section aria-labelledby="qh-h" className={card} data-testid="quiet-panel">
        <h3 id="qh-h" className="font-bold text-lg">{t("quiet.title")}</h3>
        <p className="text-sm">{t("quiet.explain", { start: policy?.quiet_hours_default.start ?? "21:00", end: policy?.quiet_hours_default.end ?? "07:00" })}</p>
        <div className="flex flex-wrap gap-3 items-end">
          <Field id="q-start" label={t("quiet.start")}><input id="q-start" type="time" data-testid="quiet-start" className="min-h-[44px] border border-black bg-white text-black px-3 text-base" value={start} onChange={(e) => setQs(e.target.value)} /></Field>
          <Field id="q-end" label={t("quiet.end")}><input id="q-end" type="time" data-testid="quiet-end" className="min-h-[44px] border border-black bg-white text-black px-3 text-base" value={end} onChange={(e) => setQe(e.target.value)} /></Field>
          <Btn data-testid="quiet-save" disabled={!qOk} onClick={() => apply(() => notifyApi.putPrefs({ quiet_hours: { start, end } }), t("saved"))}>{t("quiet.save")}</Btn>
          <Btn secondary data-testid="quiet-reset" onClick={() => { const d = policy?.quiet_hours_default; if (d) { setQs(d.start); setQe(d.end); void apply(() => notifyApi.putPrefs({ quiet_hours: { start: d.start, end: d.end } }), t("saved")); } }}>{t("quiet.reset")}</Btn>
        </div>
        <p className="text-sm" data-testid="quiet-state">{p.quiet_hours.default ? t("quiet.isDefault") : t("quiet.isCustom")} {p.quiet_hours.start} to {p.quiet_hours.end} IST</p>
        {!qOk && <p role="alert" className="text-sm font-bold">{t("quiet.invalid")}</p>}
        <p className="text-sm">{t("quiet.bypass")}</p>
      </section>
      <section aria-labelledby="caps-h" className={card} data-testid="caps-panel">
        <h3 id="caps-h" className="font-bold text-lg">{t("caps.title")}</h3>
        <p className="text-sm">{t("caps.explain")}</p>
        <div className="overflow-x-auto">
          <table className="text-sm w-full border-collapse">
            <caption className="sr-only">{t("caps.title")}</caption>
            <thead><tr><th scope="col" className="text-left p-1 border border-black/40">{t("caps.category")}</th><th scope="col" className="text-left p-1 border border-black/40">{t("caps.daily")}</th><th scope="col" className="text-left p-1 border border-black/40">{t("caps.weekly")}</th></tr></thead>
            <tbody>{policy && Object.entries(policy.caps).map(([c, v]) => <tr key={c}><th scope="row" className="text-left p-1 border border-black/40 font-normal">{categoryLabel(policy, c, lang)}</th><td className="p-1 border border-black/40">{v.daily}</td><td className="p-1 border border-black/40">{v.weekly}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="ch-h" className={card} data-testid="channels-panel">
        <h3 id="ch-h" className="font-bold text-lg">{t("chan.title")}</h3>
        <label className="flex items-start gap-3 min-h-[44px]"><input type="checkbox" data-testid="sms-ok" checked={p.sms_ok} onChange={(e) => apply(() => notifyApi.putPrefs({ sms_ok: e.target.checked }), t("saved"))} /><span>{t("chan.sms")}</span></label>
        <p className="text-sm">{t("chan.smsNote")}</p>
        <label className="flex items-start gap-3 min-h-[44px]"><input type="checkbox" data-testid="push-blocked" checked={p.push_blocked} onChange={(e) => apply(() => notifyApi.putPrefs({ push_blocked: e.target.checked }), t("saved"))} /><span>{t("chan.pushBlock")}</span></label>
        <p className="text-sm" data-testid="push-state">{t("chan.pushState")}</p>
        <div data-testid="devices-panel" data-count={devices.data?.count ?? ""}>
          <h4 className="font-bold text-sm">{t("dev.title")}</h4>
          {devices.loading ? <p role="status" className="text-sm">{t("loading")}</p> : devices.error || !devices.data ? <p role="alert" className="text-sm">{errorText(t, devices.error)}</p> : devices.data.count === 0 ? <p className="text-sm" data-testid="devices-none">{t("dev.none")}</p> : (
            <>
              <p className="text-sm" data-testid="devices-count">{t("dev.count", { n: devices.data.count })}</p>
              <ul className="text-sm list-disc pl-5">{devices.data.devices.map((d) => <li key={d.id} data-testid="device-item" data-platform={d.platform}>{t("dev.item", { label: lang === "te" ? d.label_te : d.label_en, at: fmtTime(d.created_at) })}</li>)}</ul>
            </>
          )}
        </div>
        <Btn secondary data-testid="devices-remove" onClick={() => apply(() => notifyApi.removeDevices(), t("chan.devicesRemoved"))}>{t("chan.devicesRemove")}</Btn>
        <Field id="lang-sel" label={t("chan.lang")}>
          <select id="lang-sel" data-testid="pref-lang" className="min-h-[44px] border border-black bg-white text-black px-3 text-base" value={p.language} onChange={(e) => apply(() => notifyApi.putPrefs({ language: e.target.value === "en" ? "en" : "te" }), t("saved"))}>
            <option value="te">తెలుగు</option><option value="en">English</option>
          </select>
        </Field>
      </section>
      <section aria-labelledby="un-h" className={card} data-testid="unsub-panel">
        <h3 id="un-h" className="font-bold text-lg">{t("unsub.title")}</h3>
        <p className="text-sm">{t("unsub.explain")}</p>
        {!confirmUnsub ? <Btn secondary data-testid="unsub-start" onClick={() => setConfirmUnsub(true)}>{t("unsub.start")}</Btn> : (
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("unsub.title")}>
            <Btn data-testid="unsub-confirm" onClick={() => { setConfirmUnsub(false); void apply(() => notifyApi.unsubscribe(), t("unsub.done")); }}>{t("unsub.confirm")}</Btn>
            <Btn secondary onClick={() => setConfirmUnsub(false)}>{t("cancel")}</Btn>
          </div>
        )}
      </section>
      {msg && <p role="status" data-testid="settings-msg" className="font-bold">{msg}</p>}
      <ErrorNote msg={err} />
    </div>
  );
}

export function SettingsPage() {
  const t = useNotifyT();
  return (
    <Shell title={t("settings.title")} testid="notify-settings">
      <AntiPhishBanner />
      {signedIn() ? <SettingsBody /> : <NeedSignIn />}
    </Shell>
  );
}
