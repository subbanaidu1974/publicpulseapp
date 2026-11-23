import { AdminNotifyPage } from "./AdminNotify";
import { InboxPage, SettingsPage } from "./Recipient";
import { BlockLogPage, HomePage, KeysPage, SenderLogPage } from "./Public";
import { SendPage } from "./SenderConsole";
import { useNotifyT } from "./notifyText";
import { useHash } from "./shared";

export const isNotifyHash = (h: string) => /^#\/notifications(\/|$)/.test(h);

/** Hash router for the notifications area: #/notifications, /inbox, /settings, /send, /log, /log/<org>, /keys, /admin. */
export default function NotifyRoot() {
  const hash = useHash();
  const [a, b] = hash.replace(/^#\/notifications\/?/, "").split("/").filter(Boolean);
  if (a === "inbox") return <InboxPage />;
  if (a === "settings") return <SettingsPage />;
  if (a === "send") return <SendPage />;
  if (a === "admin") return <AdminNotifyPage />;
  if (a === "keys") return <KeysPage />;
  if (a === "log" && b) return <SenderLogPage orgId={decodeURIComponent(b)} />;
  if (a === "log") return <BlockLogPage />;
  return <HomePage />;
}

/** A small link from the Civic tab. */
export function NotifyLink() {
  const t = useNotifyT();
  return <p><a href="#/notifications" data-testid="civic-to-notifications" className="underline font-bold min-h-[44px] inline-flex items-center">{t("link.civic")}</a></p>;
}
