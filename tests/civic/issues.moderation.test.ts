import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { getDb, migrate, resetDbForTests } from "../../server/civic/core";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { assessText, resetLexiconCache, toWords } from "../../server/civic/issues/moderation";
import { appeal, clock, grantRole, moderate, reportIssue } from "../../server/civic/issues/service";

const held = (t: string) => assessText(t).verdict === "hold";
const reasons = (t: string) => assessText(t).reasons;

describe("moderation: normalisation (S-27)", () => {
  it("folds spacing, leetspeak, homoglyphs, zero-width characters and transliteration variants", () => {
    expect(toWords("b r i b e").map((w) => w.low)).toEqual(["bribe"]);
    expect(toWords("m.r.o").map((w) => w.low)).toEqual(["mro"]);
    expect(toWords("br1b3 c0rrupt").map((w) => w.low)).toEqual(["bribe", "corrupt"]);
    expect(toWords("brіbe")[0].low).toBe("bribe"); // Cyrillic i
    expect(toWords("ల​ంచం")[0].low).toBe("లంచం");
    expect(toWords("laancham")[0].sk).toBe(toWords("lancham")[0].sk);
    expect(toWords("౯౮౪౮")[0].low).toBe("9848");
  });
});

describe("moderation: ordinary reports pass", () => {
  it.each([
    "No drinking water supply",
    "Tap water stopped near the temple",
    "Canal overflow flooding fields",
    "Street light not working near Ambedkar Colony",
    "Broken pipe on Main Road near Government School",
    "Stray dogs are a menace near the bus stand",
    "Illegal sand mining is damaging the road",
    "Water Supply Problem In Our Street Since Monday",
    "I called the panchayat office ten times and nobody answered",
    "మా వీధిలో తాగునీరు రావడం లేదు",
    "రోడ్డు మీద పెద్ద గుంత ఉంది",
  ])("ok: %s", (t) => { expect(assessText(t)).toMatchObject({ verdict: "ok", reasons: [] }); });
});

describe("moderation: named individuals, accusations, targeting are held", () => {
  it("English titles and names", () => {
    expect(reasons("Mr Ramesh the MRO took a bribe for my pension")).toEqual(expect.arrayContaining(["honorific_name", "accusation_with_person"]));
    expect(reasons("Dr. Lakshmi never comes to the health centre")).toContain("honorific_name");
    expect(reasons("The Sarpanch Venkat is absent")).toContain("role_named");
    expect(reasons("Ramesh garu did not repair the road")).toContain("person_suffix");
    expect(reasons("A man named Suresh dumps waste here")).toContain("introduces_name");
    expect(reasons("Venkata Subbarao is dumping waste near the canal")).toContain("possible_full_name");
    expect(held("The engineer asked for a bribe")).toBe(true); // accusation alone is ambiguous: hold
  });

  it("Telugu", () => {
    expect(held("శ్రీ రాజు గారు రోడ్డు పని చేయలేదు")).toBe(true);
    expect(held("రమేష్ గారు డబ్బులు అడిగారు")).toBe(true);
    expect(held("అధికారి లంచం అడిగాడు")).toBe(true);
    expect(held("కులం పేరుతో అవమానించారు")).toBe(true);
  });

  it("evasion: spacing, leetspeak, transliteration, homoglyphs, zero-width, mixed script", () => {
    expect(held("the officer took a b r i b e")).toBe(true);
    expect(held("the officer took a b.r.i.b.e")).toBe(true);
    expect(held("he took a br1b3 from us")).toBe(true);
    expect(held("c0rrupt official")).toBe(true);
    expect(held("he asked for l@ncham")).toBe(true);
    expect(held("lanchaam adigaru")).toBe(true);
    expect(held("lancham teesukunnaru")).toBe(true);
    expect(held("the m.r.o. Ramesh did nothing")).toBe(true); // spaced title still binds to the name
    expect(held("they took a bri be")).toBe(true); // split inside the word
    expect(held("he took a brіbe")).toBe(true);
    expect(held("ల​ంచం అడిగారు")).toBe(true);
    expect(held("ల ం చ ం అడిగారు")).toBe(true);
    expect(held("because of their c a s t e")).toBe(true);
    expect(held("b r i b e")).toBe(true);
  });

  it("personal identifiers, abuse and unreadable text", () => {
    expect(reasons("Call 98480 12345 for details")).toContain("personal_identifier");
    expect(reasons("contact me at someone@example.com")).toContain("personal_identifier");
    expect(reasons("సంప్రదించండి ౯౮౪౮౦౧౨౩౪౫")).toContain("personal_identifier");
    expect(reasons("this idiot did nothing")).toContain("abusive_language");
    expect(reasons("!!!!!!!!!!!!!!!!")).toContain("unsupported_or_obfuscated_text");
    expect(reasons("पानी की समस्या है यहाँ बहुत")).toContain("unsupported_script");
  });

  it("fails closed when the lexicon cannot be loaded", () => {
    resetLexiconCache();
    const spy = vi.spyOn(process, "cwd").mockReturnValue(os.tmpdir());
    try {
      expect(assessText("No drinking water supply")).toMatchObject({ verdict: "hold", reasons: ["lexicon_unavailable"] });
    } finally { spy.mockRestore(); resetLexiconCache(); }
  });
});

describe("moderation through the service: hold, appeal, release, takedown", () => {
  beforeEach(() => {
    resetDbForTests(); migrate(); loadDemoGeo();
    clock.now = () => new Date("2026-03-01T10:00:00Z");
    grantRole("mod-1", "moderator", null, null, "Moderator");
  });
  afterEach(() => { clock.now = () => new Date(); });

  const rep = (text: string) => reportIssue("rep", { category: "water", village_lgd: "DEMO-V-KLR", description_en: text });

  it("holds an evasive report, records rule ids (not text), supports appeal then release", () => {
    const r = rep("the m.r.o took a b-r-i-b-e") as any;
    expect(r.held).toBe(true);
    const row = getDb().prepare("SELECT moderation, moderation_reason FROM issue WHERE id=?").get(r.id) as any;
    expect(row.moderation).toBe("held");
    expect(row.moderation_reason).toContain("accusation");
    expect(row.moderation_reason).not.toMatch(/bribe/i);
    expect(appeal(r.id, "rep", "I describe the failure").status).toBe("pending");
    expect(moderate(r.id, "mod-1", "release").decision).toBe("release");
    expect((getDb().prepare("SELECT moderation FROM issue WHERE id=?").get(r.id) as any).moderation).toBe("ok");
  });

  it("takedown still works on a held report; a place name does not trigger the name heuristic", () => {
    const r = rep("Ramesh garu is rude") as any;
    expect(r.held).toBe(true);
    moderate(r.id, "mod-1", "takedown");
    expect((getDb().prepare("SELECT moderation FROM issue WHERE id=?").get(r.id) as any).moderation).toBe("taken_down");
    const ok = rep("Pipe burst at Bhimavaram Palem Gandhi Nagar junction") as any;
    expect(ok.held).toBe(false);
  });
});
