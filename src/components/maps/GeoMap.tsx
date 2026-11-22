import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css"; // bundled from node_modules (self-hosted, no CDN)
import type { GeoCollection, GeoFeature } from "../../api/geo";
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
  /** Esri tiles are loaded only when true (explicit consent); polygons always draw on a plain background. */
  tiles: boolean;
  dark: boolean;
  label: string;
  describedBy?: string;
  testId?: string;
  className?: string;
}

const ESRI = (dark: boolean) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${dark ? "World_Dark_Gray_Base" : "World_Light_Gray_Base"}/MapServer/tile/{z}/{y}/{x}`;

export default function GeoMap(p: GeoMapProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.GeoJSON | null>(null);
  const tile = useRef<L.TileLayer | null>(null);
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
    return () => { m.remove(); map.current = null; layer.current = null; tile.current = null; };
  }, []);

  // background tiles: only on explicit consent
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    tile.current?.remove();
    tile.current = null;
    if (p.tiles) {
      tile.current = L.tileLayer(ESRI(p.dark), { attribution: "Tiles © Esri", maxZoom: 12 }).addTo(m);
      tile.current.bringToBack();
    }
  }, [p.tiles, p.dark]);

  // (re)build polygons when the collection changes
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    layer.current?.remove();
    layers.current.clear();
    const g = L.geoJSON(p.collection as any, {
      style: (f) => baseStyle(cb.current, cb.current.keyOf(f as GeoFeature)),
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
    for (const [key, l] of layers.current) l.setStyle(baseStyle(p, key));
    const sel = p.selectedKey ? layers.current.get(p.selectedKey) : undefined;
    sel?.bringToFront();
  }, [p.colorOf, p.selectedKey, p.activeKey, p.dark, p.collection]);

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

function baseStyle(p: GeoMapProps, key: string): L.PathOptions {
  const selected = p.selectedKey === key;
  const active = p.activeKey === key;
  const edge = p.dark ? "#EADCC6" : "#121212";
  return {
    fillColor: p.colorOf(key) || NO_DATA,
    fillOpacity: p.tiles ? 0.72 : 0.9,
    color: selected ? edge : p.dark ? "#3a372f" : "#6b665a",
    weight: selected ? 3 : active ? 2.5 : 0.8,
    opacity: 1,
  };
}
