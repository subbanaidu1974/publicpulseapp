import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CandidateResult } from "../src/lib/elections";
import type { ElectionType } from "../src/lib/states";
import { normalizeCensus } from "./census";
import { normalizeTcpd, sortResults } from "./normalize";
import type { CensusSnapshot, ElectionSnapshot } from "./quality";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const GENERATED = process.env.PIPELINE_OUT_DIR ? resolve(process.env.PIPELINE_OUT_DIR) : resolve(ROOT, "data/generated");
export const FIXTURES = resolve(ROOT, "pipeline/fixtures");

/** Deterministic JSON write (2-space, trailing newline); only touches the file when content changes. */
export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(data, null, 2) + "\n";
  if (existsSync(path) && readFileSync(path, "utf8") === text) return;
  writeFileSync(path, text);
}

export function buildElectionSnapshot(
  csv: string, type: ElectionType, provenance: "TCPD" | "demo", source: string,
): ElectionSnapshot {
  const results: CandidateResult[] = sortResults(normalizeTcpd(csv, type, provenance));
  return { schema: 1, provenance, source, results };
}

export function buildCensusSnapshot(csv: string, provenance: "data.gov.in" | "demo", source: string): CensusSnapshot {
  return { schema: 1, provenance, source, districts: normalizeCensus(csv, source) };
}
