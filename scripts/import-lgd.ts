/**
 * Import LGD (Local Government Directory) units into the civic geography tables.
 * Default: the real AP/TG hierarchy built by scripts/fetch-lgd.ts (data/generated/geo). Never falls back to demo data.
 * Usage: npx tsx scripts/import-lgd.ts [--file path.json] [--url https://...] [--demo]
 *   --file/--url  a GeoDataset JSON (same shape as data/civic/demo-geo.json)
 *   --demo        explicitly load the DEMO fixture (dev only; never implied)
 * Codes are namespaced per level (S-, D-, M-, V-, AC-); see server/civic/geo/real.ts. Re-running is idempotent.
 */
import fs from "node:fs";
import path from "node:path";
import { migrate } from "../server/civic/core";
import { buildRealGeoDataset, hasRealGeo } from "../server/civic/geo/real";
import { importGeo, loadDemoGeo, type GeoDataset } from "../server/civic/geo/service";

async function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  migrate();
  if (args.includes("--demo")) { loadDemoGeo(); console.log("Loaded DEMO fixture (not real LGD data)."); return; }
  let data: GeoDataset | undefined;
  const file = get("--file"), url = get("--url");
  if (file) data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  else if (url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`LGD download failed: HTTP ${res.status}`);
    data = (await res.json()) as GeoDataset;
  } else {
    if (!hasRealGeo()) throw new Error("No LGD data under data/generated/geo. Run `npx tsx scripts/fetch-lgd.ts` first (or pass --file/--url, or --demo for the fixture).");
    const built = buildRealGeoDataset();
    data = built.data;
    console.log(`Real LGD snapshot as of ${built.asOf}.`);
  }
  const n = importGeo(data);
  console.log(`Imported ${n.units} units, ${n.hamlets} hamlets, ${n.links} village-constituency links.`);
}
main().catch(e => { console.error((e as Error).message); process.exitCode = 1; });
