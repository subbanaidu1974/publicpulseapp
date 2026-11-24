import { notifyApi } from "../../api/notify";
import { AntiPhishBanner, Shell, btnLinkSecondary, card, categoryLabel, errorText, fmtTime, linkCls, reasonText, useLang, useLoad, usePolicy } from "./shared";
import { useNotifyT } from "./notifyText";

/** Current election-window state per state, from the same calendar-driven, fail-closed service the server uses. */
export function MccNotice() {
  const t = useNotifyT();
  const lang = useLang();
  const w = useLoad(() => Promise.all([notifyApi.status("AP"), notifyApi.status("TG")]), []);
  return (
    <section aria-labelledby="mcc-h" className={card} data-testid="mcc-notice">
      <h3 id="mcc-h" className="font-bold text-lg">{t("mcc.title")}</h3>
      <p className="text-sm">{t("mcc.explain")}</p>
      {w.loading ? <p role="status">{t("loading")}</p> : w.error || !w.data ? <p role="alert">{t("mcc.unavailable")}</p> : (
        <>
          {w.data[0].kill.engaged && <p role="alert" data-testid="mcc-kill" data-scope={w.data[0].kill.scope ?? ""} className="border-2 border-black bg-red-100 text-black p-2 font-bold text-sm">{t("status.kill")}: {lang === "te" ? w.data[0].kill.notice_te : w.data[0].kill.notice_en}</p>}
          <ul className="text-sm space-y-1">{w.data.map((s) => (
            <li key={s.window.state} data-testid={`mcc-${s.window.state}`} data-window={s.window.status}><strong>{s.window.state}</strong>: {t(`mcc.state.${s.window.status}`)}<br /><span data-testid={`mcc-notice-${s.window.state}`}>{lang === "te" ? s.window.notice_te : s.window.notice_en}</span></li>
          ))}</ul>
        </>
      )}
    </section>
  );
}

/** Landing page: what this is, the standing rules, the directory of verified senders (public, no private data). */
export function HomePage() {
  const t = useNotifyT();
  const dir = useLoad(() => notifyApi.senders(), []);
  return (
    <Shell title={t("home.title")} testid="notify-home">
      <AntiPhishBanner />
      <p>{t("home.intro")}</p>
      <ul className="list-disc pl-6 text-sm space-y-1">
        <li>{t("home.rule1")}</li><li>{t("home.rule2")}</li><li>{t("home.rule3")}</li><li>{t("home.rule4")}</li>
      </ul>
      <MccNotice />
      <section aria-labelledby="dir-h" className={card} data-testid="sender-directory">
        <h3 id="dir-h" className="font-bold text-lg">{t("dir.title")}</h3>
        <p className="text-sm">{t("dir.explain")}</p>
        {dir.loading ? <p role="status">{t("loading")}</p> : dir.error ? <p role="alert">{errorText(t, dir.error)}</p> : (dir.data?.length ?? 0) === 0 ? <p data-testid="dir-empty">{t("dir.empty")}</p> : (
          <ul className="space-y-1">{dir.data?.map((o) => (
            <li key={o.id} data-testid="dir-org" className="flex flex-wrap items-center gap-2">
              <span className="font-bold">{o.name}</span><span className="text-sm">({t(`kind.${o.kind}`)})</span>
              <a className={`${linkCls} min-h-[44px] inline-flex items-center`} href={`#/notifications/log/${encodeURIComponent(o.id)}`}>{t("dir.sentLog")}</a>
            </li>
          ))}</ul>
        )}
      </section>
      <p className="flex flex-wrap gap-3">
        <a className={btnLinkSecondary} href="#/notifications/log">{t("nav.log")}</a>
        <a className={btnLinkSecondary} href="#/notifications/keys">{t("nav.keys")}</a>
      </p>
    </Shell>
  );
}

/** Per-sender public audit: every message that org sent, with its signature and any declaration. */
export function SenderLogPage({ orgId }: { orgId: string }) {
  const t = useNotifyT();
  const lang = useLang();
  const policy = usePolicy();
  const log = useLoad(() => notifyApi.senderLog(orgId), [orgId]);
  return (
    <Shell title={log.data ? t("slog.title", { name: log.data.org.name }) : t("slog.titleShort")} testid="notify-sender-log">
      <AntiPhishBanner />
      <p className="text-sm">{t("slog.explain")}</p>
      {log.loading ? <p role="status">{t("loading")}</p> : log.error || !log.data ? <p role="alert" data-testid="nt-load-fail">{errorText(t, log.error)}</p> : (
        log.data.messages.length === 0 ? <p data-testid="slog-empty" className={card}>{t("slog.empty")}</p> : (
          <ul className="space-y-3">{log.data.messages.map((m) => (
            <li key={m.id} data-testid="slog-item" className={card}>
              <p className="text-sm font-bold">{categoryLabel(policy, m.category, lang)} - {fmtTime(m.sent_at)}</p>
              <p>{lang === "te" ? m.text_te : m.text_en}</p>
              <p className="text-xs break-all" data-testid="slog-sig">{t("slog.signature")}: {m.signature}<br />{t("inbox.keyId")}: {m.key_id}</p>
              {m.declaration && <p className="text-sm border border-black p-2" data-testid="slog-declaration">{t("slog.declared")}: {m.declaration.reason}</p>}
              {m.mcc_window && m.mcc_window !== "open" && <p className="text-xs">{t("slog.window", { w: t(`mcc.state.${m.mcc_window}`) })}</p>}
            </li>
          ))}</ul>
        )
      )}
      <p><a className={linkCls} href="#/notifications">{t("back")}</a></p>
    </Shell>
  );
}

/** The public block log: when (hour bucket), which organisation, which category and why, never message content. */
export function BlockLogPage() {
  const t = useNotifyT();
  const lang = useLang();
  const policy = usePolicy();
  const log = useLoad(() => notifyApi.blockLog(200), []);
  return (
    <Shell title={t("block.title")} testid="notify-block-log">
      <AntiPhishBanner />
      <p className="text-sm">{t("block.explain")}</p>
      {log.loading ? <p role="status">{t("loading")}</p> : log.error ? <p role="alert" data-testid="nt-load-fail">{errorText(t, log.error)}</p> : (log.data?.length ?? 0) === 0 ? <p data-testid="block-empty" className={card}>{t("block.empty")}</p> : (
        <div className="overflow-x-auto">
          <table className="text-sm w-full border-collapse bg-white text-black" data-testid="block-table">
            <caption className="sr-only">{t("block.title")}</caption>
            <thead><tr>{(["block.when", "block.org", "block.category", "block.reason"] as const).map((k) => <th key={k} scope="col" className="text-left p-2 border border-black/40">{t(k)}</th>)}</tr></thead>
            <tbody>{log.data?.map((b) => (
              <tr key={b.id} data-testid="block-row" data-code={b.reason_code}>
                <td className="p-2 border border-black/40">{fmtTime(b.time_bucket)}</td>
                <td className="p-2 border border-black/40">{b.sender_org}</td>
                <td className="p-2 border border-black/40">{categoryLabel(policy, b.category, lang)}</td>
                <td className="p-2 border border-black/40">{reasonText(t, b.reason_code)} <span className="text-xs">({b.reason_code})</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p><a className={linkCls} href="#/notifications">{t("back")}</a></p>
    </Shell>
  );
}

/** Published signing keys and how to check a message against them. */
export function KeysPage() {
  const t = useNotifyT();
  const keys = useLoad(() => notifyApi.keys(), []);
  return (
    <Shell title={t("keys.title")} testid="notify-keys">
      <AntiPhishBanner />
      <p>{t("keys.intro")}</p>
      <section aria-labelledby="hv-h" className={card} data-testid="how-verify">
        <h3 id="hv-h" className="font-bold text-lg">{t("keys.howTitle")}</h3>
        <ol className="list-decimal pl-6 text-sm space-y-1">
          <li>{t("keys.how1")}</li><li>{t("keys.how2")}</li><li>{t("keys.how3")}</li><li>{t("keys.how4")}</li>
        </ol>
        <p className="text-sm font-bold">{t("keys.limit")}</p>
      </section>
      {keys.loading ? <p role="status">{t("loading")}</p> : keys.error ? <p role="alert" data-testid="nt-load-fail">{errorText(t, keys.error)}</p> : (
        <ul className="space-y-3">{keys.data?.map((k) => (
          <li key={k.key_id} data-testid="key-item" className={card}>
            <p className="font-bold">{t("keys.keyId")}: <span data-testid="key-id">{k.key_id}</span> ({k.alg}, v{k.version})</p>
            <p className="text-xs break-all">{t("keys.public")}: <code data-testid="key-public">{k.public_key}</code></p>
          </li>
        ))}</ul>
      )}
      <p><a className={linkCls} href="#/notifications">{t("back")}</a></p>
    </Shell>
  );
}
