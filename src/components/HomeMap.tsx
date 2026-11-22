import { useCallback, useMemo } from "react";
import { api } from "../api/client";
import { fetchGeo, type GeoFeature } from "../api/geo";
import { useApi } from "../api/useApi";
import { StateCode } from "../lib/states";
import { defaultYear } from "../state/StateContext";
import { useT } from "../i18n";
import { setTilesConsent, useTilesConsent } from "../lib/consent";
import GeoMap from "./maps/GeoMap";
import { NO_DATA, districtTally, leader, partyInfo } from "./maps/mapModel";

type Theme = "beige" | "dark" | "dark-beige" | "earth-yellow";

/** Home map: real district outlines (dissolved from constituencies) coloured by the party leading in most seats. Click opens the full map. */
export default function HomeMap({ theme, state }: { theme: Theme; state: StateCode }) {
  const { t } = useT();
  const consent = useTilesConsent(); // S-129: no third-party tile request without an explicit grant
  const dark = theme === "dark" || theme === "dark-beige";
  const year = defaultYear(state, "assembly");
  const dist = useApi(() => fetchGeo(state, "district"), [state]);
  const ac = useApi(() => fetchGeo(state, "ac"), [state]);
  const seats = useApi(() => api.seats(state, year, "assembly"), [state, year]);

  const colors = useMemo(() => {
    const m = new Map<string, { color: string; text: string }>();
    if (!ac.data || !seats.data) return m;
    const tally = districtTally(ac.data.features, new Map(seats.data.seats.map((s) => [s.acNo, s])));
    for (const [lgd, v] of tally) {
      const l = leader(v.tally);
      m.set(lgd, l && l !== "tied" ? { color: partyInfo(l.party).color, text: `${l.party} ${l.seats}/${v.seats}` } : { color: NO_DATA, text: t("map.tied") });
    }
    return m;
  }, [ac.data, seats.data, t]);

  const collection = useMemo(() => dist.data ?? { type: "FeatureCollection" as const, features: [] as GeoFeature[] }, [dist.data]);
  const names = useMemo(() => new Map(collection.features.map((f) => [String(f.properties.districtLgd), String(f.properties.district)])), [collection]);
  const keyOf = useCallback((f: GeoFeature) => String(f.properties.districtLgd), []);
  const colorOf = useCallback((k: string) => colors.get(k)?.color ?? NO_DATA, [colors]);
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const tooltipOf = useCallback((k: string) => `<strong>${esc(names.get(k) ?? k)}</strong><br/>${esc(colors.get(k)?.text ?? t("map.noData"))}`, [names, colors, t]);
  const open = (k?: string) => {
    window.location.hash = `#/map/${state}${k ? `/district/${encodeURIComponent(k)}` : ""}`;
    window.dispatchEvent(new CustomEvent("pp-nav", { detail: "map" }));
  };

  return (
    <div className="h-full min-h-[320px] flex flex-col border border-black/20">
      <GeoMap
        testId="home-map" label={t("home.mapAlt")} dark={dark} tiles={consent === "granted"} className="flex-1 min-h-[280px]"
        collection={collection} keyOf={keyOf} colorOf={colorOf} tooltipOf={tooltipOf} onSelect={open}
      />
      <p className="text-[10px] font-sans p-2 bg-[#FAF8F5] text-[#121212]">
        {dist.error ? t("map.unavailable") : t("home.mapNote")}{" "}
        <button type="button" data-testid="home-map-open" onClick={() => open()} className="underline font-bold cursor-pointer">{t("map.openFull")}</button>
      </p>
      {consent !== "granted" && (
        <p data-testid="map-tiles-off" className="text-[10px] font-sans px-2 pb-2 bg-[#FAF8F5] text-[#121212]">
          {t("map.tilesOff")} <button type="button" onClick={() => setTilesConsent("granted")} className="underline font-bold cursor-pointer">{t("map.enable")}</button>
        </p>
      )}
    </div>
  );
}
