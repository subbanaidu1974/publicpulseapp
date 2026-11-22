/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { Compass } from "lucide-react";
import { District } from "../types";
import { DISTRICTS } from "../data/staticData";

interface HomeMapProps {
  theme: "beige" | "dark" | "dark-beige" | "earth-yellow";
  onSelectDistrict?: (districtId: string) => void;
}

// Map district IDs to real approximate geographic coordinates
const GEODISTRICTS: Record<string, { lat: number; lng: number }> = {
  "AP-01": { lat: 18.3160, lng: 83.8967 }, // Srikakulam
  "AP-02": { lat: 18.7887, lng: 83.4332 }, // Parvathipuram Manyam
  "AP-03": { lat: 18.1162, lng: 83.3986 }, // Vizianagaram
  "AP-04": { lat: 17.6868, lng: 83.2185 }, // Visakhapatnam
  "AP-05": { lat: 17.6895, lng: 83.0020 }, // Anakapalli
  "AP-06": { lat: 17.9892, lng: 81.9421 }, // Alluri Sitharama Raju
  "AP-07": { lat: 16.9891, lng: 82.2475 }, // Kakinada
  "AP-08": { lat: 17.0005, lng: 81.7745 }, // East Godavari
  "AP-09": { lat: 16.5937, lng: 82.0116 }, // Dr. B.R. Ambedkar Konaseema
  "AP-10": { lat: 16.7118, lng: 81.1024 }, // Eluru
  "AP-11": { lat: 16.5449, lng: 81.5212 }, // West Godavari
  "AP-12": { lat: 16.5062, lng: 80.6480 }, // NTR (Vijayawada)
  "AP-13": { lat: 16.1685, lng: 81.1317 }, // Krishna
  "AP-14": { lat: 16.3067, lng: 80.4365 }, // Guntur
  "AP-15": { lat: 16.2713, lng: 79.9172 }, // Palnadu
  "AP-16": { lat: 15.9048, lng: 80.4682 }, // Bapatla
  "AP-17": { lat: 15.5057, lng: 79.9133 }, // Prakasam
  "AP-18": { lat: 14.4426, lng: 79.9865 }, // SPSR Nellore
  "AP-19": { lat: 15.8281, lng: 78.0373 }, // Kurnool
  "AP-20": { lat: 15.4808, lng: 78.4871 }, // Nandyal
  "AP-21": { lat: 14.6819, lng: 77.6006 }, // Ananthapuramu
  "AP-22": { lat: 14.1622, lng: 77.8105 }, // Sri Sathya Sai
  "AP-23": { lat: 14.4716, lng: 78.8252 }, // YSR Kadapa
  "AP-24": { lat: 13.9749, lng: 78.9818 }, // Annamayya
  "AP-25": { lat: 13.2172, lng: 79.1003 }, // Chittoor
  "AP-26": { lat: 13.6288, lng: 79.4192 }, // Tirupati
};

// High-fidelity polygon outline coordinates covering the border of Andhra Pradesh, India
const ANDHRA_BORDER_COORDS: [number, number][] = [
  [19.10, 84.70], // Ichchapuram (Northern Srikakulam tip)
  [18.65, 84.40],
  [18.30, 84.10], // Kalingapatnam
  [17.90, 83.50],
  [17.70, 83.30], // Visakhapatnam
  [17.50, 82.90],
  [16.90, 82.30], // Kakinada
  [16.70, 82.20], // Yanam
  [16.30, 81.70], // Narsapur
  [16.10, 81.15], // Machilipatnam
  [15.90, 80.60], // Nizampatnam
  [15.55, 80.12], // Ongole
  [14.90, 80.02], // Kavali
  [14.40, 80.15], // Nellore
  [13.70, 80.08], // Pulicat Lake
  [13.60, 80.20], // Southern tip coast
  [13.50, 80.05], // Sri City border
  [13.60, 79.40], // near Tirupati
  [13.20, 79.10], // near Chittoor
  [12.80, 78.35], // Kuppam (Southern tip)
  [13.55, 78.50], // Madanapalle
  [14.10, 78.10], // Kadiri
  [13.80, 77.50], // Hindupur border
  [14.10, 77.60], // Penukonda
  [14.65, 77.60], // Anantapuramu
  [14.70, 76.85], // Rayadurgam
  [15.15, 76.90], // Alur/Bellary border
  [15.60, 77.20], // Adoni
  [15.95, 77.40], // Mantralayam
  [15.82, 78.05], // Kurnool
  [16.10, 78.85], // Srisailam
  [16.50, 79.30], // Nagarjuna Sagar
  [16.48, 79.40], // Macherla
  [16.65, 80.10], // Palnadu
  [16.90, 80.10], // Jaggaiahpeta
  [17.10, 80.60], // Tiruvuru
  [17.25, 81.10], // Aswaraopeta
  [17.30, 81.60], // Polavaram
  [17.75, 81.40], // Chintoor / Bhadrachalam border
  [18.30, 81.80], // Alluri Sitharama Raju forest range
  [18.40, 82.80], // Araku Valley
  [18.85, 83.45], // Parvathipuram
  [18.60, 83.75], // Palakonda
  [18.90, 84.50], // Sompeta
  [19.10, 84.70]  // Loop back
];

export default function HomeMap({ theme, onSelectDistrict }: HomeMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const [mapView, setMapView] = useState<"editorial" | "satellite" | "globe">("editorial");

  // Determine dynamic CSS class filter key to perfectly match contrast
  const getFilterClass = () => {
    if (mapView !== "editorial") return ""; // Show raw earth and topographical colors without sepia overlays
    switch (theme) {
      case "dark":
        return ""; // Standard high-contrast dark
      case "dark-beige":
        return "sepia-[0.35] brightness-[0.8] contrast-[1.1] saturate-[1.1]";
      case "earth-yellow":
        return "sepia-[0.4] saturate-[1.2] brightness-[0.9] contrast-[1.05]";
      case "beige":
      default:
        return "sepia-[0.1] brightness-[0.98]";
    }
  };

  useEffect(() => {
    // Inject Leaflet CSS if it is not already loaded
    if (!document.getElementById("leaflet-stylesheet-link")) {
      const link = document.createElement("link");
      link.id = "leaflet-stylesheet-link";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    // Inject custom tooltip overrides for Leaflet map to preserve retro-Swiss editorial layout
    if (!document.getElementById("leaflet-custom-styles-and-tips")) {
      const style = document.createElement("style");
      style.id = "leaflet-custom-styles-and-tips";
      style.innerHTML = `
        /* Custom styled Leaflet Tooltip */
        .leaflet-tooltip-pane .custom-map-tooltip {
          background-color: #121212 !important;
          border: 1px solid rgba(255, 255, 255, 0.15) !important;
          color: #f9f7f2 !important;
          border-radius: 0px !important;
          box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.3) !important;
          padding: 10px 14px !important;
          font-family: inherit !important;
          pointer-events: none !important;
        }
        .leaflet-tooltip-pane .custom-map-tooltip.light-tooltip {
          background-color: #fcf9ee !important;
          border: 1px solid rgba(18, 18, 18, 0.25) !important;
          color: #121212 !important;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1) !important;
        }
        .leaflet-tooltip-pane .custom-map-tooltip::before {
          border-top-color: #121212 !important;
        }
        .leaflet-tooltip-pane .custom-map-tooltip.light-tooltip::before {
          border-top-color: #fcf9ee !important;
        }
      `;
      document.head.appendChild(style);
    }
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    // Destroy existing map if it already initialized
    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    // Centered around Andhra Pradesh centroid
    const map = L.map(mapContainerRef.current, {
      center: [15.9129, 79.7400],
      zoom: 6.5,
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: false,
    });

    mapInstanceRef.current = map;

    // Define Tile Layer based on the selected mode
    let tileUrl = "";
    let attribution = "";

    if (mapView === "satellite") {
      tileUrl = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
      attribution = "Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community";
    } else if (mapView === "globe") {
      tileUrl = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}";
      attribution = "Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China, GIS User Community";
    } else {
      // Editorial (dynamic matching theme context)
      const isDarkTheme = theme === "dark" || theme === "dark-beige";
      tileUrl = isDarkTheme
        ? "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
        : "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";
      // CARTO basemaps now require an API key; Esri's gray canvas tiles work without one.
      attribution = "Tiles © Esri — Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS user community";
    }

    L.tileLayer(tileUrl, {
      maxZoom: 18,
      attribution: attribution
    }).addTo(map);



    // Plot all 26 districts of Andhra Pradesh
    DISTRICTS.forEach((district) => {
      const geo = GEODISTRICTS[district.id];
      if (!geo) return;

      // Color representation based on average approval rating (green to red)
      let color = "#3F5B73"; // default slate blue
      if (district.avgApprovalRating >= 62) {
        color = "#2E4A3F"; // solid dark green
      } else if (district.avgApprovalRating >= 55) {
        color = "#3F5B73"; // neutral grayish blue
      } else if (district.avgApprovalRating >= 50) {
        color = "#9E6F40"; // ochre earth
      } else {
        color = "#8C3E3E"; // organic red
      }

      const isThemeDark = theme === "dark" || theme === "dark-beige" || mapView === "satellite";
      const strokeColor = mapView === "satellite" ? "#FFFFFF" : (isThemeDark ? "#EADCC6" : "#121212");

      const circle = L.circleMarker([geo.lat, geo.lng], {
        radius: 7 + Math.sqrt(district.population / 250000), 
        fillColor: color,
        color: strokeColor,
        weight: 1.5,
        opacity: 0.9,
        fillOpacity: mapView === "satellite" ? 0.75 : 0.65,
      }).addTo(map);

      // Create a styled tool-tip popup
      const isDarkPopup = isThemeDark;
      const popupText = isDarkPopup ? "#EADCC6" : "#121212";

      const tooltipContent = `
        <div style="font-family: 'Inter', sans-serif; font-size: 11px; padding: 2px;">
          <div style="font-weight: 800; text-transform: uppercase; margin-bottom: 4px; font-size: 11px; border-bottom: 1px solid ${isDarkPopup ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'}; padding-bottom: 2px; color: ${popupText};">
            ${district.name} (${district.region})
          </div>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="color: #888888; padding-right: 12px; font-size: 10px;">Approval rating:</td>
              <td style="font-weight: bold; text-align: right; color: ${color}; font-size: 11px;">${district.avgApprovalRating}%</td>
            </tr>
            <tr>
              <td style="color: #888888; padding-right: 12px; font-size: 10px;">Sample Responses:</td>
              <td style="font-weight: bold; text-align: right; font-size: 11px; color: ${popupText};">${district.totalResponses.toLocaleString()}</td>
            </tr>
            <tr>
              <td style="color: #888888; padding-right: 12px; font-size: 10px;">Projected Winner:</td>
              <td style="font-weight: bold; text-align: right; text-transform: uppercase; font-size: 11px; color: ${color};">${district.partyLeading}</td>
            </tr>
            <tr>
              <td style="color: #888888; padding-right: 12px; vertical-align: top; font-size: 10px;">Pre-eminent Demand:</td>
              <td style="font-weight: normal; font-size: 10px; font-style: italic; text-align: right; color: ${popupText};">${district.topIssueSelected}</td>
            </tr>
          </table>
          <div style="margin-top: 6px; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: bold; text-align: center; color: ${color}; opacity: 0.9;">
            Click to Lock Selection
          </div>
        </div>
      `;

      circle.bindTooltip(tooltipContent, {
        sticky: true,
        direction: "top",
        opacity: 0.98,
        className: isThemeDark ? "custom-map-tooltip" : "custom-map-tooltip light-tooltip"
      });

      // Handle click events to link with core state
      circle.on("click", () => {
        if (onSelectDistrict) {
          onSelectDistrict(district.id);
        }
      });

      // Simple mouse-over styling triggers
      circle.on("mouseover", function() {
        this.setStyle({
          fillOpacity: 0.95,
          weight: 2.2,
        });
      });

      circle.on("mouseout", function() {
        this.setStyle({
          fillOpacity: mapView === "satellite" ? 0.75 : 0.65,
          weight: 1.5,
        });
      });
    });

  }, [theme, mapView, onSelectDistrict]);

  return (
    <div className="relative w-full h-[360px] md:h-full min-h-[380px] bg-black/5 dark:bg-white/[0.02] border border-black/15 flex flex-col justify-between overflow-hidden">
      {/* Dynamic top bar coordinates & map selector action deck */}
      <div className="z-10 bg-black/5 dark:bg-white/[0.05] border-b border-black/10 px-4 py-2 flex flex-wrap items-center justify-between text-[8px] font-mono select-none gap-2">
        <div className="flex items-center space-x-2">
          <span className="tracking-widest text-slate-500 uppercase">TELEMETRY DECK</span>
          <span className="text-black/30 dark:text-white/20">|</span>
          <span className="text-black dark:text-[#EADCC6]">15.9129° N, 79.7400° E</span>
        </div>
        
        {/* Swappable map tile controllers */}
        <div className="flex items-center space-x-1.5">
          <button
            type="button"
            onClick={() => setMapView("editorial")}
            className={`px-2 py-0.5 border text-[7px] tracking-widest font-black transition-all uppercase rounded-none cursor-pointer ${
              mapView === "editorial"
                ? "bg-black text-white dark:bg-[#EADCC6] dark:text-neutral-900 border-black dark:border-[#EADCC6]"
                : "border-black/15 bg-transparent text-slate-600 hover:text-black hover:border-black dark:text-slate-400 dark:hover:text-[#EADCC6] dark:hover:border-[#EADCC6]/30"
            }`}
          >
            Editorial
          </button>
          <button
            type="button"
            onClick={() => setMapView("satellite")}
            className={`px-2 py-0.5 border text-[7px] tracking-widest font-black transition-all uppercase rounded-none cursor-pointer ${
              mapView === "satellite"
                ? "bg-black text-white dark:bg-[#EADCC6] dark:text-neutral-900 border-black dark:border-[#EADCC6]"
                : "border-black/15 bg-transparent text-slate-600 hover:text-black hover:border-black dark:text-slate-400 dark:hover:text-[#EADCC6] dark:hover:border-[#EADCC6]/30"
            }`}
          >
            Satellite
          </button>
          <button
            type="button"
            onClick={() => setMapView("globe")}
            className={`px-2 py-0.5 border text-[7px] tracking-widest font-black transition-all uppercase rounded-none cursor-pointer ${
              mapView === "globe"
                ? "bg-black text-white dark:bg-[#EADCC6] dark:text-neutral-900 border-black dark:border-[#EADCC6]"
                : "border-black/15 bg-transparent text-slate-600 hover:text-black hover:border-black dark:text-slate-400 dark:hover:text-[#EADCC6] dark:hover:border-[#EADCC6]/30"
            }`}
          >
            Globe / Topo
          </button>
        </div>
      </div>

      {/* Leaflet container */}
      <div 
        ref={mapContainerRef} 
        className={`flex-grow w-full z-0 transition-all duration-300 ${getFilterClass()}`}
        style={{ height: "calc(100% - 30px)" }}
      />

      {/* Floating Re-center Compass Button */}
      <button
        type="button"
        title="Recenter state overview to Andhra Pradesh"
        onClick={() => {
          if (mapInstanceRef.current) {
            mapInstanceRef.current.setView([15.9129, 79.7400], 6.5);
          }
        }}
        className="absolute bottom-4 right-4 z-[400] bg-[#121212] dark:bg-[#FAF8F5] text-[#FAF8F5] dark:text-[#121212] hover:bg-neutral-800 dark:hover:bg-white border border-white/10 dark:border-black/10 px-3 py-1.5 text-[8.5px] font-sans font-bold tracking-widest uppercase flex items-center space-x-1.5 shadow-lg active:scale-95 transition-all duration-150 cursor-pointer"
      >
        <Compass className="w-3.5 h-3.5" />
        <span>Center Perspective</span>
      </button>
    </div>
  );
}
