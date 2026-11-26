import { useState } from "react";
import { tokenStore } from "../../api/civic";
import { mediaApi } from "../../api/mediahub";
import { useT } from "../../i18n";
import { mediaText as mt, type MediaKey } from "./mediaText";

const REASONS = ["wrong", "partisan", "offensive", "broken", "other"] as const;

/** A plain Report control on every Media item (S-234). It goes to the admin queue; a person can report an item once. */
export default function ReportButton({ kind, id }: { kind: "video" | "news" | "live"; id: string }) {
  const { lang } = useT();
  const t = (k: MediaKey) => mt(lang, k);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!tokenStore.get()) return <span className="text-xs" data-testid="report-signin">{t("m.report.signin")}</span>;
  const send = async () => {
    setMsg(null);
    try { await mediaApi.report({ kind, id, reason, note: note.trim() || undefined }); setDone(true); setOpen(false); }
    catch (e) {
      const code = (e as { body?: { code?: string; message?: string } }).body;
      setMsg(code?.code === "already_reported" ? t("m.report.dup") : code?.message ?? (e as Error).message);
    }
  };
  if (done) return <p role="status" data-testid="report-done" className="text-xs font-bold">{t("m.report.thanks")}</p>;
  return (
    <div className="text-xs">
      <button type="button" data-testid="report-open" aria-expanded={open} onClick={() => setOpen(!open)} className="underline min-h-[44px] min-w-[44px] px-2">{t("m.report")}</button>
      {open && (
        <div data-testid="report-form" className="mt-1 space-y-2 border border-black p-2">
          <label className="block font-bold" htmlFor={`rr-${kind}-${id}`}>{t("m.report.why")}</label>
          <select id={`rr-${kind}-${id}`} data-testid="report-reason" value={reason} onChange={(e) => setReason(e.target.value)} className="border border-black bg-transparent p-1 text-sm">
            {REASONS.map((r) => <option key={r} value={r}>{t(`m.reason.${r}` as MediaKey)}</option>)}
          </select>
          <input data-testid="report-note" aria-label={t("m.report.why")} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} className="block w-full border border-black bg-transparent p-1 text-sm" />
          <button type="button" data-testid="report-send" onClick={send} className="border border-black bg-black px-3 py-1 text-sm font-bold text-white min-h-[44px]">{t("m.report.send")}</button>
          {msg && <p role="alert" data-testid="report-msg" className="font-bold">{msg}</p>}
        </div>
      )}
    </div>
  );
}
