import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED, ROOT } from "./io";
import { MANIFEST_NAME, type Manifest } from "./manifest";

export const isCommercial = (env: Record<string, string | undefined> = process.env) => /^(1|true|yes)$/i.test((env.COMMERCIAL_USE ?? "").trim());

interface Lic { constraints?: string[]; nonCommercial?: boolean; shareAlike?: boolean }
const restricts = (l: Lic) => !!l.nonCommercial || !!l.shareAlike || (l.constraints ?? []).some(c => /non-?commercial|share-?alike/i.test(c));

/** Licence keys that carry a non-commercial or share-alike term, restricted to those a shipped dataset (manifest entry) uses. */
export function ncSaInUse(root: string = ROOT, genDir: string = GENERATED): { key: string; datasets: string[] }[] {
  const reg = JSON.parse(readFileSync(resolve(root, "data/reference/licences.json"), "utf8")).licences as Record<string, Lic>;
  const mp = resolve(genDir, MANIFEST_NAME);
  const datasets = existsSync(mp) ? (JSON.parse(readFileSync(mp, "utf8")) as Manifest).datasets : [];
  return Object.entries(reg).filter(([, l]) => restricts(l))
    .map(([key]) => ({ key, datasets: datasets.filter(d => d.licences.includes(key)).map(d => d.id) }))
    .filter(x => x.datasets.length > 0);
}

/** Violations when COMMERCIAL_USE is on and any shipped dataset relies on a non-commercial or share-alike licence. */
export function commercialViolations(env: Record<string, string | undefined> = process.env, root: string = ROOT, genDir: string = GENERATED): string[] {
  if (!isCommercial(env)) return [];
  return ncSaInUse(root, genDir).map(x => `COMMERCIAL_USE is set but licence '${x.key}' (non-commercial / share-alike) is used by: ${x.datasets.join(", ")}`);
}
