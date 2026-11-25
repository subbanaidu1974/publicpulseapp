import type L from "leaflet";

/**
 * Self-hosted map background (S-191): OpenStreetMap vector tiles for AP and TG served by THIS site (server/basemap.ts) and drawn in the
 * browser by protomaps-leaflet. Nothing is requested from any other host. If the file is not installed on the server, or anything fails, the
 * map simply stays plain boundary shapes. The library is loaded on demand, so pages without a map do not carry it.
 */
export const BASEMAP_PATH = "/basemap/ap-tg.pmtiles";
export const BASEMAP_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

let available: Promise<boolean> | null = null;
/** True when the server has the tile file. Asked once per page load. */
export const basemapAvailable = (): Promise<boolean> => (available ??= fetch(BASEMAP_PATH, { method: "HEAD" }).then((r) => r.ok).catch(() => false));
/** Tests only. */
export const resetBasemapProbe = (): void => { available = null; };

/** Layers whose lines would draw country or state borders are dropped: the boundary shapes of this app are the only borders shown. */
const DROP_PAINT = new Set(["boundaries"]);
/** Of all label layers only place names (cities, towns) are kept. */
const KEEP_LABELS = new Set(["places"]);

export async function addBasemap(map: L.Map, dark: boolean, lang: "en" | "te"): Promise<L.Layer | null> {
  try {
    if (!(await basemapAvailable())) return null;
    const pl = await import("protomaps-leaflet");
    const layer = pl.leafletLayer({
      url: new URL(BASEMAP_PATH, window.location.href).href,
      flavor: dark ? "dark" : "grayscale",
      lang,
      attribution: BASEMAP_ATTRIBUTION,
      maxDataZoom: 10,
      maxZoom: 12,
    });
    layer.paintRules = layer.paintRules.filter((r) => !DROP_PAINT.has(r.dataLayer));
    layer.labelRules = layer.labelRules.filter((r) => KEEP_LABELS.has(r.dataLayer));
    layer.addTo(map);
    (layer as unknown as L.GridLayer).bringToBack();
    return layer as unknown as L.Layer;
  } catch {
    return null;
  }
}
