import { useEffect, useState } from "react";

/** Consent for third-party requests (S-129). Today only the Esri map tiles; fonts are self-hosted (S-130). */
export type TilesConsent = "granted" | "declined" | "unset";
const KEY = "pp-tiles-consent";
const EVT = "pp-consent";

export function getTilesConsent(): TilesConsent {
  try {
    const v = localStorage.getItem(KEY);
    return v === "granted" || v === "declined" ? v : "unset";
  } catch { return "unset"; }
}

export function setTilesConsent(v: TilesConsent): void {
  try { if (v === "unset") localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch { /* storage unavailable: the choice lasts for this page view only via the event */ }
  window.dispatchEvent(new CustomEvent(EVT, { detail: v }));
}

/** Only an explicit grant allows a third-party tile request; unset and declined both mean no request. */
export function tilesAllowed(): boolean { return getTilesConsent() === "granted"; }

export function useTilesConsent(): TilesConsent {
  const [v, setV] = useState<TilesConsent>(getTilesConsent);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail; setV(d === "granted" || d === "declined" ? d : "unset"); };
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  return v;
}
