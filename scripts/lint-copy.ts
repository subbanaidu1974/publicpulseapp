/**
 * Banned-wording copy lint (S-128, DESIGN_2028 B1).
 * Pulse / opinion-survey surfaces must not say vote, ballot or result(s).
 * Election-results surfaces are legitimate and allow-listed below.
 * Escape hatch: `// copy-lint-allow: <reason>` on the same or the previous line.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_FILES = ["ElectionsPage", "TrendCharts", "ForecastPanel", "ConstituencySearch", "DataStatusPanel", "pages", "peopleText", "analyticsText"];
export const ALLOWED_KEY_PREFIXES = ["elections.", "el.", "tr.", "prov.", "fc.", "res.", "share.",
  // election-results descriptions, each reviewed (S-128 tail). Survey copy is not on this list.
  "home.lead", "home.cardElections", "an.lead", "footer.about", "c.intro",
  // constituency profile and map pages show election data (S-100 profiles, S-96 maps)
  "prof.", "map.source",
  // people pages (parties, members, contestants) show election data and published results (S-104..S-114)
  "ppl."];
/** Directories where "results"/"votes" are JSON field names or election-data plumbing, not user-facing copy. */
export const ALLOWED_DIRS = ["src/api/", "src/lib/"];

const BANNED_EN = /\b(vot(?:e|es|ed|ing|er|ers)|ballots?|results?)\b/i;
const BANNED_TE = /(వోటు|ఓటు|ఓటర్|వోటర్|బ్యాలెట్|ఫలితం|ఫలితాలు)/;

export interface Hit { file: string; line: number; word: string; text: string }

/** Extract user-visible-ish text from a source line: string literals and JSX text nodes. */
function fragments(line: string): string[] {
  const out: string[] = [];
  const lit = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = lit.exec(line))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  const jsx = />([^<>{}]+)</g;
  while ((m = jsx.exec(line))) out.push(m[1]);
  return out;
}

export function scanText(file: string, text: string): Hit[] {
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  if (ALLOWED_FILES.includes(base)) return [];
  const norm = file.replace(/\\/g, "/");
  if (ALLOWED_DIRS.some((d) => norm.includes("/" + d) || norm.startsWith(d))) return [];
  const hits: Hit[] = [];
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  lines.forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      if (line.includes("*/")) { inBlock = false; line = line.slice(line.indexOf("*/") + 2); } else return;
    }
    if (/^\s*import\b/.test(line)) return;
    if (/copy-lint-allow:/.test(line) || (i > 0 && /copy-lint-allow:/.test(lines[i - 1]))) return;
    const bs = line.indexOf("/*");
    if (bs >= 0 && !line.includes("*/", bs)) { inBlock = true; line = line.slice(0, bs); }
    line = line.replace(/\/\*.*?\*\//g, "");
    if (/^\s*(\/\/|\*)/.test(line)) return;
    const keyed = /^\s*["']([a-z0-9_.-]+)["']\s*:/i.exec(line);
    if (keyed && ALLOWED_KEY_PREFIXES.some((p) => keyed[1].startsWith(p))) return;
    line = line.replace(/data-testid=(?:"[^"]*"|{[^}]*})/g, ""); // test ids are not copy
    const frags = fragments(line);
    const skip = keyed ? 1 : 0; // the i18n key itself is not copy
    for (const f of frags.slice(skip)) {
      const m = BANNED_EN.exec(f) || BANNED_TE.exec(f);
      if (m) { hits.push({ file, line: i + 1, word: m[0], text: raw.trim().slice(0, 140) }); break; }
    }
  });
  return hits;
}

export function scanDir(root: string): Hit[] {
  const hits: Hit[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "data" && e.name !== "node_modules") walk(p);
      } else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.(test|spec|d)\.ts/.test(e.name)) {
        hits.push(...scanText(p, fs.readFileSync(p, "utf8")));
      }
    }
  };
  walk(root);
  return hits;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hits = scanDir(path.resolve(process.argv[2] || "src"));
  for (const h of hits) console.log(`${path.relative(process.cwd(), h.file)}:${h.line}  [${h.word}]  ${h.text}`);
  console.log(`\ncopy-lint: ${hits.length} banned-wording hit(s)`);
  process.exit(hits.length ? 1 : 0);
}
