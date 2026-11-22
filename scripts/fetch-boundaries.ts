import { resolve } from "node:path";
import { GENERATED, writeJson } from "../pipeline/io";
import { validateGeoJson } from "../pipeline/quality";

// DataMeet Maps repo (assembly constituencies, per state).
const BASE = "https://raw.githubusercontent.com/datameet/maps/master/Assembly-Constituencies";
const TARGETS: Record<string, string> = {
  AP: process.env.BOUNDARIES_AP_URL || `${BASE}/Andhra_Pradesh.geojson`,
  TG: process.env.BOUNDARIES_TG_URL || `${BASE}/Telangana.geojson`,
};

async function main() {
  let failures = 0;
  for (const [code, url] of Object.entries(TARGETS)) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geo = await res.json();
      const errs = validateGeoJson(geo, code);
      if (errs.length) throw new Error(errs.join("; "));
      writeJson(resolve(GENERATED, `boundaries-${code.toLowerCase()}.geojson`), geo);
      console.log(`[fetch-boundaries] ${code}: ${geo.features.length} features`);
    } catch (e) {
      failures++;
      console.warn(`[fetch-boundaries] WARNING: ${code} boundaries unavailable (${(e as Error).message}); map will use table fallback`);
    }
  }
  if (failures) console.warn(`[fetch-boundaries] ${failures} state(s) skipped; continuing (exit 0)`);
}

main().catch(e => { console.warn("[fetch-boundaries] WARNING:", (e as Error).message); });
