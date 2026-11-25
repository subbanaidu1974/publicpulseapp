import { useState } from "react";
import type { FormEvent } from "react";
import type { StateCode } from "../../lib/states";
import { useT } from "../../i18n";

const MAX_BYTES = 2_000_000;
const RELATIONSHIPS = [["candidate", "prof.ph.rel.candidate"], ["party office", "prof.ph.rel.party"], ["authorised representative", "prof.ph.rel.rep"]] as const;
const b64 = (o: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))); // headers are Latin-1: encode the UTF-8 first

/**
 * S-200: "send a photo for this constituency". The photo is held until a reviewer approves it; there is no automatic identity check.
 * The contact is used only to confirm who sent it and is never shown. Nothing here claims the photo is the winner until it is approved.
 */
export default function PhotoSubmitForm({ state, acNo }: { state: StateCode; acNo: number }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setProblem(null);
    const f = new FormData(e.currentTarget);
    const file = f.get("photo") as File | null;
    if (!file || !file.size) return setProblem(t("prof.ph.errFile"));
    if (!/^image\/(jpeg|png)$/.test(file.type)) return setProblem(t("prof.ph.errType"));
    if (file.size > MAX_BYTES) return setProblem(t("prof.ph.errSize"));
    setBusy(true);
    try {
      const r = await fetch("/api/v1/photos/submissions", {
        method: "POST",
        headers: {
          "Content-Type": file.type,
          "X-Photo-Meta": b64({ state, acNo, relationship: f.get("relationship"), claimedName: f.get("claimedName"), holder: f.get("holder"), contact: f.get("contact"), consent: f.get("consent") === "on", website: f.get("website") }),
        },
        body: file,
      });
      if (r.ok) setDone(true);
      else setProblem(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? t("prof.ph.errGeneric"));
    } catch { setProblem(t("prof.ph.errGeneric")); } finally { setBusy(false); }
  }

  return (
    <details data-testid="photo-submit" className="border border-black/40 p-3 text-xs font-sans">
      <summary className="cursor-pointer font-bold">{t("prof.ph.summary")}</summary>
      {done ? (
        <p data-testid="photo-submit-done" role="status" className="mt-2">{t("prof.ph.done")}</p>
      ) : (
        <form onSubmit={submit} className="mt-2 space-y-2" noValidate>
          <p className="text-[11px]">{t("prof.ph.intro")}</p>
          <label className="block">{t("prof.ph.name")}<input name="claimedName" required maxLength={120} className="block w-full border border-black px-2 py-1 mt-1" /></label>
          <label className="block">{t("prof.ph.rel")}
            <select name="relationship" className="block w-full border border-black bg-white text-[#121212] px-2 py-1 mt-1">
              {RELATIONSHIPS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
            </select>
          </label>
          <label className="block">{t("prof.ph.credit")}<input name="holder" required maxLength={120} className="block w-full border border-black px-2 py-1 mt-1" /></label>
          <label className="block">{t("prof.ph.contact")}<input name="contact" required maxLength={200} autoComplete="off" className="block w-full border border-black px-2 py-1 mt-1" /></label>
          <label className="block">{t("prof.ph.file")}<input name="photo" type="file" accept="image/jpeg,image/png" className="block mt-1" /></label>
          <div aria-hidden="true" className="absolute -left-[9999px]"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
          <label className="flex items-start gap-2"><input name="consent" type="checkbox" className="mt-0.5" /><span>{t("prof.ph.consent")}</span></label>
          <p className="text-[10px] text-slate-600">{t("prof.ph.privacy")}</p>
          {problem && <p role="alert" data-testid="photo-submit-error" className="text-red-800">{problem}</p>}
          <button type="submit" disabled={busy} data-testid="photo-submit-send" className="border border-black bg-black text-white px-3 py-1 disabled:opacity-50">{busy ? t("prof.ph.sending") : t("prof.ph.send")}</button>
        </form>
      )}
    </details>
  );
}
