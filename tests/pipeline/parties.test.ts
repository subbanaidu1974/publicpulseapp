import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CandidateResult } from "../../src/lib/elections";
import { OTHERS, PARTIES, contrastOnWhite, partyColor, partyName, registryCode, resolveParty } from "../../src/lib/parties";
import { canonicalParty } from "../../pipeline/normalize";

const rows = (JSON.parse(readFileSync(resolve(__dirname, "../../data/generated/elections.json"), "utf8")).results) as CandidateResult[];
const reg = JSON.parse(readFileSync(resolve(__dirname, "../../data/reference/parties.json"), "utf8"));

describe("@E2E-118 party registry", () => {
  it("every party code in elections.json resolves to a registry entry or the Others bucket", () => {
    const codes = [...new Set(rows.map(r => r.party))];
    expect(codes.length).toBeGreaterThan(100);
    for (const c of codes) {
      const p = resolveParty(c);
      expect(p === OTHERS || PARTIES[p.code] === p).toBe(true);
    }
    // The parties that win seats in AP/TG are all curated entries, never the Others bucket.
    for (const c of ["TDP", "YSRCP", "JSP", "BRS", "INC", "BJP", "AIMIM", "CPI", "CPM", "BSP", "IND"]) expect(resolveParty(c)).not.toBe(OTHERS);
  });

  it("maps aliases: TRS -> BRS, AAAP -> AAP, long-form names, CPI(M) -> CPM", () => {
    expect(registryCode("TRS")).toBe("BRS");
    expect(registryCode("Telangana Rashtra Samithi")).toBe("BRS");
    expect(registryCode("AAAP")).toBe("AAP");
    expect(registryCode("CPI(M)")).toBe("CPM");
    expect(registryCode("JnP")).toBe("JSP");
    expect(registryCode("YSR Congress Party")).toBe("YSRCP");
    expect(registryCode("NOT-A-PARTY")).toBeNull();
    expect(partyColor("NOT-A-PARTY")).toBe(reg.othersBucket.color);
  });

  it("alias strings are unique across parties", () => {
    const seen = new Map<string, string>();
    for (const p of reg.parties) for (const a of [p.code, ...p.aliases]) {
      const k = a.toUpperCase().replace(/[\s._-]/g, "");
      expect(seen.get(k) ?? p.code, `alias ${a}`).toBe(p.code);
      seen.set(k, p.code);
    }
  });

  it("canonicalParty stays backward compatible and now also uses the registry", () => {
    expect(canonicalParty("TRS")).toBe("BRS");
    expect(canonicalParty("JnP")).toBe("JSP");
    expect(canonicalParty(" ysrcp ")).toBe("YSRCP");
    expect(canonicalParty("")).toBe("IND");
    expect(canonicalParty("XYZ")).toBe("XYZ");
    expect(canonicalParty("Telugu Desam Party")).toBe("TDP");
    expect(canonicalParty("MTRSP")).toBe("MTRSP");
  });

  it("curated colours meet the 3:1 non-text contrast minimum against white", () => {
    for (const p of reg.parties) expect(contrastOnWhite(p.color), `${p.code} ${p.color}`).toBeGreaterThanOrEqual(3);
    expect(contrastOnWhite(reg.othersBucket.color)).toBeGreaterThanOrEqual(3);
  });

  it("Telugu names exist only where verified; unverified ones are null", () => {
    expect(partyName("TDP", "te")).toBe("తెలుగుదేశం పార్టీ");
    expect(partyName("BRS", "te")).toBe("భారత రాష్ట్ర సమితి");
    expect(PARTIES.AIMIM.name.te).toBeNull();
    expect(partyName("AIMIM", "te")).toBe(PARTIES.AIMIM.name.en);
  });

  it("Wikidata QIDs are the verified ones and every entry has a unique code", () => {
    const q = Object.fromEntries(reg.parties.map((p: { code: string; wikidata: string | null }) => [p.code, p.wikidata]));
    expect(q).toMatchObject({ TDP: "Q2279320", BRS: "Q3518390", YSRCP: "Q8046035", JSP: "Q15940677", INC: "Q10225", BJP: "Q10230", CPM: "Q234277", CPI: "Q837159", BSP: "Q803681" });
    expect(new Set(reg.parties.map((p: { code: string }) => p.code)).size).toBe(reg.parties.length);
  });

  it("media entries carry file, licence, author, verification date; non-free or unverified media is absent", () => {
    const free = /^(CC0|Public domain|CC BY-SA \d\.\d)$/;
    for (const p of reg.parties) for (const m of [p.flag, p.symbol]) {
      if (!m) continue;
      expect(m.commonsFile).toBeTruthy();
      expect(m.licence).toMatch(free);
      expect(m.author).toBeTruthy();
      expect(m.verified).toMatch(/^2026-11-(22|25)$/); // 22 Nov: first set; 25 Nov: YSRCP logo, AAP and TJS flags
      expect(["decorative", "identification-only"]).toContain(m.use);
      if (/BY-SA/.test(m.licence)) expect(m.attributionRequired).toBe(true);
    }
    expect(reg.parties.find((p: { code: string }) => p.code === "YSRCP").flag).toBeNull();
    // Insignia-tagged files (INC, CPI) and communist symbols must be identification-only.
    expect(reg.parties.find((p: { code: string }) => p.code === "INC").flag.use).toBe("identification-only");
    expect(reg.parties.find((p: { code: string }) => p.code === "CPI").flag.use).toBe("identification-only");
    expect(reg.parties.find((p: { code: string }) => p.code === "CPM").symbol.use).toBe("identification-only");
  });
});
