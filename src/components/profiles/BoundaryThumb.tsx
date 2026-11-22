import { useEffect, useState } from "react";
import { profiles } from "../../api/profiles";
import type { StateCode } from "../../lib/states";
import { useT } from "../../i18n";

type Ring = number[][];
const files = new Map<string, Promise<any>>();
const load = (state: StateCode, kind: "ac" | "pc") => {
  const k = `${state}-${kind}`;
  let p = files.get(k);
  if (!p) { p = profiles.boundary(state, kind); files.set(k, p); p.catch(() => files.delete(k)); }
  return p;
};

/** Equirectangular projection (longitude scaled by cos of the mid latitude) into a w x h box, as one SVG path. No tiles, no network beyond the geojson. */
export function polygonPath(geometry: { type: string; coordinates: any } | null | undefined, w = 200, h = 200, pad = 6): string | null {
  if (!geometry) return null;
  const polys: Ring[][] = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  const pts = polys.flatMap(p => p.flatMap(r => r));
  if (!pts.length) return null;
  const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons), minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = (maxLon - minLon) * k || 1e-6, spanY = maxLat - minLat || 1e-6;
  const s = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const ox = (w - spanX * s) / 2, oy = (h - spanY * s) / 2;
  const f = (p: number[]) => `${(ox + (p[0] - minLon) * k * s).toFixed(1)} ${(oy + (maxLat - p[1]) * s).toFixed(1)}`;
  return polys.map(poly => poly.map(r => "M" + r.map(f).join("L") + "Z").join("")).join("");
}

export default function BoundaryThumb({ state, acNo, label }: { state: StateCode; acNo: number; label: string }) {
  const { t } = useT();
  const [d, setD] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setD(undefined);
    load(state, "ac").then(g => {
      const f = (g?.features ?? []).find((x: any) => x.properties?.acNo === acNo);
      if (alive) setD(polygonPath(f?.geometry));
    }, () => { if (alive) setD(null); });
    return () => { alive = false; };
  }, [state, acNo]);
  if (d === undefined) return <div className="w-40 h-40 border border-black/10 bg-black/5" aria-hidden="true" />;
  if (d === null) return <p data-testid="boundary-missing" className="text-[11px] text-slate-600 w-40">{t("prof.noBoundary")}</p>;
  return (
    <figure data-testid="boundary-thumb" className="w-40 shrink-0">
      <svg viewBox="0 0 200 200" role="img" aria-label={label} className="w-40 h-40 border border-black/20 bg-white">
        <path d={d} fill="#d9c9a8" stroke="#121212" strokeWidth="1.2" fillRule="evenodd" strokeLinejoin="round" />
      </svg>
      <figcaption className="text-[9px] text-slate-600 mt-1">{t("prof.boundaryNote")}</figcaption>
    </figure>
  );
}
