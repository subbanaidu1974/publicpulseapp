import registry from "../../data/reference/parties.json";

/** Commons-hosted media with the verified licence; `use` says whether it may be shown decoratively or only to identify the party. */
export interface PartyMedia {
  commonsFile: string;
  licence: string;
  author: string;
  use: "decorative" | "identification-only";
  attributionRequired?: boolean;
  restrictions?: string;
  verified: string;
  note?: string;
}

export interface Party {
  code: string;
  aliases: string[];
  name: { en: string; te: string | null };
  color: string;
  foundedYear: number | null;
  website: string | null;
  wikidata: string | null;
  history: { year: number; event: string; verified: boolean }[];
  flag: PartyMedia | null;
  symbol: PartyMedia | null;
}

export const OTHERS_CODE = "OTH";
export const registryAsOf: string = registry.asOf;

export const PARTIES: Record<string, Party> = Object.fromEntries((registry.parties as unknown as Party[]).map(p => [p.code, p]));

export const OTHERS: Party = {
  code: OTHERS_CODE, aliases: [], name: registry.othersBucket.name, color: registry.othersBucket.color,
  foundedYear: null, website: null, wikidata: null, history: [], flag: null, symbol: null,
};

const norm = (s: string) => s.trim().toUpperCase().replace(/[\s._-]/g, "");
const BY_ALIAS = new Map<string, string>();
for (const p of Object.values(PARTIES)) {
  BY_ALIAS.set(norm(p.code), p.code);
  for (const a of p.aliases) BY_ALIAS.set(norm(a), p.code);
}

/** Registry code for any raw party string or alias; null when the party is not in the registry (-> Others bucket). */
export function registryCode(raw: string): string | null {
  const n = norm(raw ?? "");
  return n ? BY_ALIAS.get(n) ?? null : null;
}

/** Registry entry for a party code/alias, or the Others bucket. Minor parties keep their own code upstream. */
export function resolveParty(raw: string): Party {
  const code = registryCode(raw);
  return code ? PARTIES[code] : OTHERS;
}

/** Accessible, hand-curated colour (>= 3:1 on white). Unknown parties get the Others colour. */
export function partyColor(raw: string): string {
  return resolveParty(raw).color;
}

export function partyName(raw: string, lang: "en" | "te" = "en"): string {
  const p = resolveParty(raw);
  if (p === OTHERS) return raw;
  return (lang === "te" ? p.name.te : null) ?? p.name.en;
}

/** WCAG relative-luminance contrast ratio of a #rrggbb colour against white. */
export function contrastOnWhite(hex: string): number {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (L + 0.05);
}
