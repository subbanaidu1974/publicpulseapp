import { writeManifest } from "../pipeline/manifest";
import { GENERATED } from "../pipeline/io";

const m = writeManifest();
console.log(`[manifest] ${m.datasets.length} datasets written to ${GENERATED}/manifest.json`);
for (const d of m.datasets) if (d.id.startsWith("unclassified-")) console.warn(`[manifest] WARNING: ${d.path} is unclassified (add a rule in pipeline/manifest.ts)`);
