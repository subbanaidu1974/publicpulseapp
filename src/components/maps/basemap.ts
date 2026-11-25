import L from "leaflet";
import { fetchPlaces, fetchVillageLabels, type PlaceName, type VillageLabel } from "../../api/geo";
import { MAX_VILLAGE_LABELS, minPopulationAt, VILLAGE_ZOOM } from "./placeZoom";

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
    // The tiles have no Telugu names, so in Telugu their (Latin) labels are dropped and addTeluguPlaces draws the names instead.
    layer.labelRules = lang === "te" ? [] : layer.labelRules.filter((r) => KEEP_LABELS.has(r.dataLayer));
    layer.clearLayout(); // the label engine is built from the rules at construction, so rebuild it with the reduced set
    layer.addTo(map);
    (layer as unknown as L.GridLayer).bringToBack();
    return layer as unknown as L.Layer;
  } catch {
    return null;
  }
}

/**
 * Telugu place names, drawn as plain text labels over the background from our own lists served by this site: towns (S-192, Wikidata CC0)
 * and, when zoomed in, villages (S-193, LGD names). Towns are placed first and a label that would overlap one already placed is skipped.
 * Returns null when no list can be loaded (the map then simply has no names).
 */
/** Rough bounding box of each state, to know which village file the current view needs. */
const STATE_BOX = { AP: L.latLngBounds([12.6, 76.7], [19.95, 84.8]), TG: L.latLngBounds([15.8, 77.2], [19.95, 81.4]) } as const;

export async function addTeluguPlaces(map: L.Map): Promise<L.Layer | null> {
  try {
    const states = ["AP", "TG"] as const;
    const towns = (await Promise.all(states.map((s) => fetchPlaces(s)))).flat() as PlaceName[];
    if (!towns.length) return null;
    // villages are loaded only when the map is first zoomed in far enough; a failure there never removes the town names
    const loaded = new Map<string, VillageLabel[]>(), loading = new Set<string>();
    const group = L.layerGroup();
    const put = (text: string, lat: number, lng: number, cls: string) =>
      L.marker([lat, lng], { interactive: false, keyboard: false, icon: L.divIcon({ className: cls, html: "", iconSize: [0, 0] }) })
        .addTo(group).getElement()?.replaceChildren(Object.assign(document.createElement("span"), { textContent: text }));
    const draw = () => {
      group.clearLayers();
      const zoom = map.getZoom(), box = map.getBounds().pad(0.05), min = minPopulationAt(zoom);
      const taken = new Set<string>(); // coarse pixel grid: one label per cell, so names never pile up
      const free = (lat: number, lng: number, wide: number): boolean => {
        const p = map.latLngToContainerPoint([lat, lng]), cx = Math.floor(p.x / (wide + 12)), cy = Math.floor(p.y / 16);
        const k = `${cx}:${cy}`; if (taken.has(k)) return false;
        taken.add(k); return true;
      };
      for (const p of towns) {
        if (p.population < min || !box.contains([p.lat, p.lon]) || !free(p.lat, p.lon, 70)) continue;
        put(p.te, p.lat, p.lon, "pp-place-label");
      }
      if (zoom >= VILLAGE_ZOOM) {
        // each state's village file (up to ~1 MB) is fetched only once the view overlaps that state, and only once
        for (const st of states) {
          if (loaded.has(st) || loading.has(st) || !box.intersects(STATE_BOX[st])) continue;
          loading.add(st);
          void fetchVillageLabels(st).then((v) => { loaded.set(st, v); draw(); }).catch(() => { loaded.set(st, []); });
        }
        let n = 0;
        for (const st of states) {
          for (const v of loaded.get(st) ?? []) {
            if (n >= MAX_VILLAGE_LABELS) break;
            if (!box.contains([v.lat, v.lon]) || !free(v.lat, v.lon, 80)) continue;
            put(v.te, v.lat, v.lon, "pp-place-label pp-village-label"); n++;
          }
        }
      }
    };
    group.on("add", () => { draw(); map.on("zoomend moveend", draw); });
    group.on("remove", () => { map.off("zoomend moveend", draw); });
    group.addTo(map);
    return group;
  } catch {
    return null;
  }
}
