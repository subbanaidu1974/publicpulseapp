import path from "node:path";
import { GENERATED, writeJson } from "../io";
import { buildSegmentsFromDisk } from "./segments";

const out = buildSegmentsFromDisk(path.resolve(GENERATED, "..", ".."));
writeJson(path.resolve(GENERATED, "lsmap", "segments.json"), out);
const n = (s: "AP" | "TG") => `${s}: ${Object.keys(out.segments[s]).length} ACs in ${Object.keys(out.pcs[s]).length} PCs`;
console.log(`[lsmap] ${n("AP")}; ${n("TG")}; ${out.issues.length} issue(s)`);
for (const i of out.issues) console.warn(`[lsmap] ${i}`);
