/**
 * Pure matching / licence rules for winner photos (S-110). No network here so it is unit-testable.
 * Rule: a Wikidata person is attached to a seat ONLY when (a) the P39 statement's P768 electoral district names that
 * seat AND (b) the person's name matches the TCPD candidate name. Never guess; unmatched winners get an initials avatar.
 */

const strip = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** "Giddalur Assembly constituency" / "Araku Lok Sabha constituency" -> "giddalur" / "araku". */
export function seatKey(label: string): string {
  return strip(label)
    .replace(/\b(assembly|lok sabha|legislative|constituency|\(sc\)|\(st\)|sc|st)\b/g, " ")
    .replace(/[^a-z]/g, "");
}

/** Name tokens of >= 3 letters (initials like "N." / "K." are ignored: they differ between sources). */
export function nameTokens(name: string): string[] {
  return strip(name).replace(/[^a-z\s]/g, " ").split(/\s+/).filter(t => t.length >= 3);
}

/** True when the shorter token set is wholly contained in the other, with >= 2 shared tokens or 1 when a name has only one long token. */
export function namesMatch(a: string, b: string): boolean {
  const ta = new Set(nameTokens(a)), tb = new Set(nameTokens(b));
  if (!ta.size || !tb.size) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let shared = 0;
  for (const t of small) if (big.has(t)) shared++;
  return shared === small.size && (shared >= 2 || small.size === 1 && big.size <= 2);
}

export interface LicenceVerdict { ok: boolean; code: string | null; reason?: string }

/** Accept only CC0 / public domain / CC BY / CC BY-SA (any version). Reject NC, ND, GFDL-only, fair use, unknown. */
export function classifyLicence(shortName: string | undefined | null): LicenceVerdict {
  const s = (shortName ?? "").trim();
  if (!s) return { ok: false, code: null, reason: "no licence recorded" };
  const l = s.toLowerCase();
  if (/\b(nc|nd)\b|non-?commercial|no-?derivs|fair use|copyrighted|all rights reserved/.test(l)) return { ok: false, code: s, reason: "restricted licence" };
  if (/^cc0\b|^cc-?zero|public domain|^pd\b|^pd-/.test(l)) return { ok: true, code: /^cc0/.test(l) ? "CC0" : "PD" };
  const m = /^cc[ -]by(-sa)?\b/.exec(l);
  if (m) return { ok: true, code: m[1] ? "CC BY-SA" : "CC BY" };
  return { ok: false, code: s, reason: "licence not in the accepted list" };
}

/** Plain text from the Commons Artist HTML field. */
export function plainText(html: string | undefined | null): string {
  return (html ?? "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
