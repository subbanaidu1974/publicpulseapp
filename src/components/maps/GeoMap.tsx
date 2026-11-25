import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css"; // bundled from node_modules (self-hosted, no CDN)
import type { GeoCollection, GeoFeature } from "../../api/geo";
import { useT } from "../../i18n";
import { addBasemap, addTeluguPlaces } from "./basemap";
import { NO_DATA } from "./mapModel";

export interface GeoMapProps {
  collection: GeoCollection;
  /** stable identity of a feature (also used for selection and table highlight) */
  keyOf: (f: GeoFeature) => string;
  colorOf: (key: string) => string;
  tooltipOf: (key: string) => string;
  selectedKey?: string | null;
  activeKey?: string | null;
  onSelect?: (key: string) => void;
  dark: boolean;
  label: string;
  describedBy?: string;
  testId?: string;
  className?: string;
}

export default function GeoMap(p: GeoMapProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.GeoJSON | null>(null);
  const bg = useRef<L.Layer | null>(null);
  const [hasBg, setHasBg] = useState(false);
  const { lang } = useT();
  const layers = useRef(new Map<string, L.Path>());
  const cb = useRef(p);
  cb.current = p;
  const fitted = useRef<GeoCollection | null>(null);

  // create the map once
  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { attributionControl: true, scrollWheelZoom: false, zoomSnap: 0.25, preferCanvas: false });
    m.attributionControl.setPrefix(false);
    m.setView([16.5, 79.5], 6); // placeholder view until polygons arrive
    map.current = m;
    return () => { m.remove(); map.current = null; layer.current = null; };
  }, []);

  // self-hosted OpenStreetMap background when the server has it (S-191); plain shapes otherwise
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    let live = true;
    bg.current?.remove(); bg.current = null; setHasBg(false);
    let names: L.Layer | null = null;
    void addBasemap(m, p.dark, lang === "te" ? "te" : "en").then(async (l) => {
      if (!l) return;
      if (!live || map.current !== m) { l.remove(); return; }
      bg.current = l; setHasBg(true);
      if (lang === "te") { // the tiles carry no Telugu names: town names come from our own Wikidata list (S-192)
        names = await addTeluguPlaces(m);
        if (!live) names?.remove();
      }
    });
    return () => { live = false; bg.current?.remove(); bg.current = null; names?.remove(); };
  }, [p.dark, lang]);

  // (re)build polygons when the collection changes
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    layer.current?.remove();
    layers.current.clear();
    const g = L.geoJSON(p.collection as any, {
      style: (f) => baseStyle(cb.current, cb.current.keyOf(f as GeoFeature), !!bg.current),
      onEachFeature: (f, l) => {
        const key = cb.current.keyOf(f as GeoFeature);
        layers.current.set(key, l as L.Path);
        l.bindTooltip(() => cb.current.tooltipOf(key), { sticky: true, direction: "top", className: "pp-map-tip" });
        l.on("click", () => cb.current.onSelect?.(key));
      },
    }).addTo(m);
    layer.current = g;
    if (fitted.current !== p.collection) {
      fitted.current = p.collection;
      const b = g.getBounds();
      if (b.isValid()) m.fitBounds(b, { padding: [8, 8], animate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.collection]);

  // recolour / reselect without rebuilding
  useEffect(() => {
    for (const [key, l] of layers.current) l.setStyle(baseStyle(p, key, hasBg));
    const sel = p.selectedKey ? layers.current.get(p.selectedKey) : undefined;
    sel?.bringToFront();
  }, [p.colorOf, p.selectedKey, p.activeKey, p.dark, p.collection, hasBg]);

  // table hover/focus -> open the same tooltip on the map
  useEffect(() => {
    layers.current.forEach((l) => l.closeTooltip());
    if (p.activeKey) layers.current.get(p.activeKey)?.openTooltip();
  }, [p.activeKey]);

  return (
    <div
      ref={el}
      data-testid={p.testId ?? "geo-map"}
      role="group"
      aria-label={p.label}
      aria-describedby={p.describedBy}
      className={p.className ?? "h-[360px] sm:h-[460px] w-full"}
      style={{ background: p.dark ? "#1b1a17" : "#efece3" }}
    />
  );
}

function baseStyle(p: GeoMapProps, key: string, background: boolean): L.PathOptions {
  const selected = p.selectedKey === key;
  const active = p.activeKey === key;
  const edge = p.dark ? "#EADCC6" : "#121212";
  return {
    fillColor: p.colorOf(key) || NO_DATA,
    fillOpacity: background ? 0.72 : 0.9, // a little see-through over the background map
    color: selected ? edge : p.dark ? "#3a372f" : "#6b665a",
    weight: selected ? 3 : active ? 2.5 : 0.8,
    opacity: 1,
  };
}
