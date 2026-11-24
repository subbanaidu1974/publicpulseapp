import { useMemo } from "react";
import { profiles } from "../../api/profiles";
import type { VillagePolygons } from "../../api/profiles";
import { useApi } from "../../api/useApi";
import type { StateCode } from "../../lib/states";
import { useT } from "../../i18n";
import { Loading } from "../ui";
import { Section } from "./common";

type Ring = number[][];
const polysOf = (g: { type: string; coordinates: any }): Ring[][] => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);

/**
 * Village boundaries (S-90) for a mandal, or one village highlighted inside its mandal. Offline SVG, no tiles.
 * Source: SHRUG polygons (CC BY-NC-SA 4.0, Census 2011 based, non-commercial use). The attribution line is part of this
 * component, so it is visible wherever the boundaries are drawn. Villages without a polygon fall back to the existing
 * approximate point, and with neither nothing is drawn for them.
 */
export default function VillageBoundaries({ state, mandal, villageCode }: { state: StateCode; mandal: string; villageCode?: string }) {
  const { t, lang } = useT();
  const polys = useApi<VillagePolygons>(() => profiles.villagePolygons(state, mandal), [state, mandal]);
  const pts = useApi<{ items: { code: string; lon: number; lat: number }[] }>(() => profiles.villagePoints(state, mandal).catch(() => ({ items: [] })), [state, mandal]);

  const model = useMemo(() => {
    if (!polys.data) return null;
    const W = 320, H = 240, pad = 8;
    const feats = polys.data.features.map(f => ({ code: String(f.properties.code), name: lang === "te" ? f.properties.nameTe ?? f.properties.nameEn : f.properties.nameEn, polys: polysOf(f.geometry) }));
    const own = new Set(feats.map(f => f.code));
    const points = (pts.data?.items ?? []).filter(p => !own.has(String(p.code)));
    const focus = villageCode ? feats.find(f => f.code === villageCode) : undefined;
    const focusPoint = villageCode && !focus ? points.find(p => String(p.code) === villageCode) : undefined;
    // frame: whole mandal at mandal level; the neighbourhood of the village at village level
    const all: number[][] = feats.flatMap(f => f.polys.flatMap(p => p[0] ?? []));
    for (const p of points) all.push([p.lon, p.lat]);
    if (!all.length) return { empty: true as const };
    const lons = all.map(p => p[0]), lats = all.map(p => p[1]);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons), minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const spanX = (maxLon - minLon) * k || 1e-6, spanY = maxLat - minLat || 1e-6;
    const s = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    const ox = (W - spanX * s) / 2, oy = (H - spanY * s) / 2;
    const xy = (lon: number, lat: number) => [ox + (lon - minLon) * k * s, oy + (maxLat - lat) * s] as const;
    const d = (ps: Ring[][]) => ps.map(poly => poly.map(r => "M" + r.map(c => xy(c[0], c[1]).map(v => v.toFixed(1)).join(" ")).join("L") + "Z").join("")).join("");
    return {
      empty: false as const, W, H,
      shapes: feats.map(f => ({ code: f.code, name: f.name ?? f.code, d: d(f.polys), focus: f.code === villageCode })),
      dots: points.map(p => ({ code: String(p.code), xy: xy(p.lon, p.lat), focus: String(p.code) === villageCode })),
      focusPoint: !!focusPoint, hasFocus: !!focus, drawn: feats.length,
    };
  }, [polys.data, pts.data, villageCode, lang]);

  const attribution = t("prof.villageBoundsAttr");
  const inScope = polys.data?.villagesInScope ?? 0;

  return (
    <Section title={t("prof.villageBounds")} testId="village-boundaries">
      {polys.loading ? <Loading /> : !model || model.empty ? (
        <p data-testid="village-boundaries-none" className="text-xs font-sans">{t("prof.villageBoundsNone")}</p>
      ) : (
        <figure className="space-y-1">
          <svg viewBox={`0 0 ${model.W} ${model.H}`} role="img" aria-label={t("prof.villageBounds")} data-testid="village-boundaries-svg" data-polygons={model.drawn} className="w-full max-w-md h-auto border border-black/20 bg-white">
            {model.shapes.map(s => (
              <path key={s.code} d={s.d} data-village={s.code} data-focus={s.focus ? "true" : undefined} fill={s.focus ? "#c9a24a" : "#e6dcc3"} stroke="#121212" strokeWidth={s.focus ? 1.6 : 0.4} fillRule="evenodd" strokeLinejoin="round"><title>{s.name}</title></path>
            ))}
            {model.dots.map(p => <circle key={p.code} cx={p.xy[0]} cy={p.xy[1]} r={p.focus ? 4 : 1.6} fill={p.focus ? "#c9a24a" : "#6b665a"} stroke="#121212" strokeWidth={p.focus ? 1 : 0}><title>{p.code}</title></circle>)}
          </svg>
          <figcaption className="text-[10px] text-slate-600 space-y-0.5">
            {villageCode && !model.hasFocus && <p data-testid="village-boundaries-fallback">{model.focusPoint ? t("prof.villageBoundsPoint") : t("prof.villageBoundsNone")}</p>}
            {!villageCode && <p data-testid="village-boundaries-count">{t("prof.villageBoundsCount").replace("{n}", String(model.drawn)).replace("{m}", String(inScope))}</p>}
            <p>{t("prof.villageBoundsNote")}</p>
            <p data-testid="village-boundaries-attribution">{attribution}</p>
          </figcaption>
        </figure>
      )}
    </Section>
  );
}
