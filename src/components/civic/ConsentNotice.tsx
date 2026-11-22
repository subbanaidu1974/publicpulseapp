import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useCivicT } from "./civicText";

interface Notice { purpose: string; version: string; status: string; title: { en: string; te: string }; text: { en: string; te: string } }

const API = "/api/v1/civic/households";

/**
 * Shows a versioned consent notice (Telugu or English, following the app language) and an explicit accept action.
 * Legal wording is a DRAFT served from server data; the banner says so. Does not store anything itself.
 */
export default function ConsentNotice({ purpose, version, onAccept, onDecline, acceptLabel }: {
  purpose: string;
  version?: string;
  onAccept?: (notice: { purpose: string; version: string }) => void;
  onDecline?: () => void;
  acceptLabel?: string;
}) {
  const { lang } = useT();
  const c = useCivicT();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [failed, setFailed] = useState(false);
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    let live = true;
    setNotice(null); setFailed(false);
    fetch(`${API}/notices/${encodeURIComponent(purpose)}${version ? `?version=${encodeURIComponent(version)}` : ""}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((n: Notice) => { if (live) setNotice(n); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [purpose, version]);

  const te = lang === "te";
  if (failed) return <p role="alert" data-testid="consent-notice-error" className="text-xs text-red-900 font-sans border border-red-700 bg-red-50 p-3">{c("c.noticeFail")}</p>;
  if (!notice) return <p role="status" className="text-xs text-slate-800 font-sans">{c("c.loading")}</p>;

  return (
    <section data-testid="consent-notice" aria-labelledby="consent-notice-title" className="border border-black bg-[#FAF8F5] p-4 space-y-3">
      <span data-testid="consent-notice-draft" className="inline-block text-[9px] font-sans font-black uppercase tracking-widest bg-amber-200 text-amber-950 border border-amber-700 px-2 py-0.5">
        {c("c.draft")}
      </span>
      <h3 id="consent-notice-title" lang={te ? "te" : "en"} className="text-lg font-serif italic text-black">{notice.title[te ? "te" : "en"]}</h3>
      <p lang={te ? "te" : "en"} data-testid="consent-notice-text" className="text-sm font-serif text-slate-800 leading-relaxed">{notice.text[te ? "te" : "en"]}</p>
      <p className="text-xs font-sans text-slate-800">{c("c.version")}: {notice.version}</p>
      {onAccept && (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-xs font-sans">
            <input data-testid="consent-notice-check" type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
            <span>{c("c.agree")}</span>
          </label>
          <div className="flex gap-3">
            <button data-testid="consent-notice-accept" type="button" disabled={!agreed} onClick={() => onAccept({ purpose: notice.purpose, version: notice.version })}
              className="border border-black bg-black text-white px-4 py-1.5 uppercase tracking-widest text-xs font-black cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed">
              {acceptLabel ?? c("c.accept")}
            </button>
            {onDecline && (
              <button data-testid="consent-notice-decline" type="button" onClick={onDecline}
                className="border border-black bg-white text-black px-4 py-1.5 uppercase tracking-widest text-xs font-black cursor-pointer">
                {c("c.decline")}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
