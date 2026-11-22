/**
 * Import LGD (Local Government Directory) units into the civic geography tables.
 * Usage: npx tsx scripts/import-lgd.ts [--file path.json] [--url https://...]
 * Expected JSON shape = data/civic/demo-geo.json. Network failure is tolerated: falls back to the
 * DEMO fixture and says so. The real LGD export format must be mapped to that shape [VERIFY].
 */
import fs from "node:fs";
import path from "node:path";
import { migrate } from "../server/civic/core";
import { importGeo, loadDemoGeo, type GeoDataset } from "../server/civic/geo/service";

async function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  migrate();
  let data: GeoDataset | undefined;
  const file = get("--file"), url = get("--url");
  if (file) data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  else if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = (await res.json()) as GeoDataset;
    } catch (e) {
      console.warn(`LGD download failed (${(e as Error).message}); falling back to DEMO fixture.`);
    }
  }
  if (!data) { loadDemoGeo(); console.log("Loaded DEMO fixture (not real LGD data)."); return; }
  const n = importGeo(data);
  console.log(`Imported ${n.units} units, ${n.hamlets} hamlets, ${n.links} village-constituency links.`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
