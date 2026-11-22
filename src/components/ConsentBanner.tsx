import { useT } from "../i18n";
import { setTilesConsent, useTilesConsent } from "../lib/consent";

/** Consent for the one third-party request the app can make (Esri map tiles). Decline keeps the map without tiles. */
export default function ConsentBanner({ forceOpen = false, onClose }: { forceOpen?: boolean; onClose?: () => void }) {
  const { t } = useT();
  const v = useTilesConsent();
  if (v !== "unset" && !forceOpen) return null;
  const choose = (c: "granted" | "declined") => { setTilesConsent(c); onClose?.(); };
  return (
    <section role="dialog" aria-modal="false" aria-labelledby="consent-title" data-testid="consent-banner"
      className="w-full bg-[#FAF8F5] text-[#121212] border-b-2 border-black p-4 sm:px-8">
      <div className="max-w-4xl mx-auto space-y-2 font-sans">
        <h2 id="consent-title" className="text-xs font-black uppercase tracking-widest">{t("consent.title")}</h2>
        <p className="text-xs leading-relaxed">{t("consent.body")}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <button data-testid="consent-decline" type="button" onClick={() => choose("declined")}
            className="border border-black bg-white px-4 py-2 text-[10px] uppercase tracking-widest font-black cursor-pointer">{t("consent.decline")}</button>
          <button data-testid="consent-allow" type="button" onClick={() => choose("granted")}
            className="border border-black bg-black text-[#F9F7F2] px-4 py-2 text-[10px] uppercase tracking-widest font-black cursor-pointer">{t("consent.allow")}</button>
        </div>
      </div>
    </section>
  );
}
