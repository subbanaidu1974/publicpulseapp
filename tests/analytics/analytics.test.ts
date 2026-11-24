import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApiRouter } from "../../server/api";
import type { Datasets } from "../../server/api";
import { validatePartySwitches } from "../../server/analytics-api";
import type { PartySwitchRecord } from "../../server/analytics-api";
import { loadManifestIndex } from "../../server/manifest";
import type { CandidateResult } from "../../src/lib/elections";
import { candidateTrails, incumbencySummary, partyShareCompare } from "../../src/lib/comparison";
import { seatTurnouts, turnoutReport, totalsOf } from "../../src/lib/turnout";
import { splitUndivided, nameKey } from "../../pipeline/history/prebifurcation";
import { resolveSeat, seatIndexFrom } from "../../pipeline/history/byelections";

const ROOT = resolve(__dirname, "../..");
const rows = (JSON.parse(readFileSync(resolve(ROOT, "data/generated/elections.json"), "utf8")) as { results: CandidateResult[] }).results;
const hist = (JSON.parse(readFileSync(resolve(ROOT, "data/generated/history/prebifurcation.json"), "utf8")) as { results: CandidateResult[] }).results;
const byel = JSON.parse(readFileSync(resolve(ROOT, "data/reference/history/byelections.json"), "utf8")) as { records: Record<string, any>[] };
const switches = JSON.parse(readFileSync(resolve(ROOT, "data/reference/history/party-switches.json"), "utf8")) as { records: PartySwitchRecord[] };
const all = [...rows, ...hist];

describe("turnout, NOTA and sex summaries (S-120)", () => {
  it("turnout is valid votes / electors and matches the source figure wherever the source carries it", () => {
    let checked = 0;
    for (const r of all) {
      if (r.turnoutPct === undefined || !r.electors || r.position !== 1) continue;
      expect(Math.abs((r.validVotes / r.electors) * 100 - r.turnoutPct)).toBeLessThan(0.06);
      checked++;
    }
    expect(checked).toBeGreaterThan(500);
  });
  it("AP 2024: 175 seats, NOTA present, gender turnout reported as not available", () => {
    const rep = turnoutReport(rows.filter(r => r.state === "AP" && r.year === 2024 && r.type === "assembly"), "AP", 2024, "assembly");
    expect(rep.seats).toHaveLength(175);
    expect(rep.notaAvailable).toBe(true);
    expect(rep.statewide.notaSharePct).toBeGreaterThan(0);
    expect(rep.statewide.turnoutPct).toBeGreaterThan(60);
    expect(rep.genderTurnout.available).toBe(false);
    expect(rep.sex.available).toBe(true);
    expect(rep.sex.womenSharePct).toBeGreaterThan(0);
    expect(JSON.stringify(rep)).not.toMatch(/womenTurnout|femaleTurnout/);
  });
  it("2009 has no NOTA figure rather than a zero", () => {
    const seats = seatTurnouts(hist.filter(r => r.state === "TG" && r.year === 2009 && r.type === "assembly"));
    expect(seats).toHaveLength(119);
    expect(seats.every(s => s.notaVotes === null && s.notaSharePct === null)).toBe(true);
    expect(totalsOf(seats).notaSharePct).toBeNull();
  });
});

describe("pre-bifurcation mapping (S-116)", () => {
  it("splits undivided numbering by the 2008 delimitation order", () => {
    expect(splitUndivided("assembly", 119)).toEqual({ state: "TG", acNo: 119 });
    expect(splitUndivided("assembly", 120)).toEqual({ state: "AP", acNo: 1 });
    expect(splitUndivided("assembly", 294)).toEqual({ state: "AP", acNo: 175 });
    expect(splitUndivided("ls", 17)).toEqual({ state: "TG", acNo: 17 });
    expect(splitUndivided("ls", 18)).toEqual({ state: "AP", acNo: 1 });
    expect(splitUndivided("ls", 43)).toBeNull();
  });
  it("passes the seat-count gate and every row is tagged", () => {
    const n = (s: string, y: number, t: string) => new Set(hist.filter(r => r.state === s && r.year === y && r.type === t).map(r => r.acNo)).size;
    expect([n("TG", 2009, "assembly"), n("AP", 2009, "assembly"), n("TG", 2009, "ls"), n("AP", 2009, "ls"), n("TG", 2014, "ls"), n("AP", 2014, "ls")]).toEqual([119, 175, 17, 25, 17, 25]);
    expect(hist.every(r => r.comparability === "pre-bifurcation" && r.undividedNo)).toBe(true);
    expect(hist.some(r => r.year === 2014 && r.type === "assembly")).toBe(false);
  });
  it("numbering is confirmed by names: >= 98% of seats share a name prefix with the post-2014 seat of the same number", () => {
    const nk = (s: string) => nameKey(s);
    const ref = new Map<string, Set<string>>();
    for (const r of rows) (ref.get(`${r.state}|${r.type}|${r.acNo}`) ?? ref.set(`${r.state}|${r.type}|${r.acNo}`, new Set()).get(`${r.state}|${r.type}|${r.acNo}`)!).add(nk(r.acName));
    const seen = new Set<string>(); let ok = 0, tot = 0;
    for (const r of hist) { const k = `${r.state}|${r.type}|${r.year}|${r.acNo}`; if (seen.has(k)) continue; seen.add(k); tot++; if (ref.get(`${r.state}|${r.type}|${r.acNo}`)?.has(nk(r.acName))) ok++; }
    expect(ok / tot).toBeGreaterThanOrEqual(0.98);
  });
  it("matches known 2009 outcomes (INC 156 seats across the two successor states) and never carries TCPD's party-switch column", () => {
    const winners = hist.filter(r => r.year === 2009 && r.type === "assembly" && r.position === 1);
    expect(winners.filter(r => r.party === "INC")).toHaveLength(156);
    expect(winners.filter(r => r.party === "TDP")).toHaveLength(92);
    expect(hist.some(r => "tcpdTurncoat" in r)).toBe(false);
  });
  it("is not mixed into the main election dataset (golden numbers are unaffected)", () => {
    expect(rows.some(r => r.comparability)).toBe(false);
  });
});

describe("by-elections (S-115)", () => {
  it("every record has a unique id, a seat that exists, at least one source and an honest verified flag", () => {
    const ids = new Set<string>();
    for (const r of byel.records) {
      expect(ids.has(r.id)).toBe(false); ids.add(r.id);
      expect(r.sources.length).toBeGreaterThan(0);
      expect(["by-election", "re-poll"]).toContain(r.kind);
      if (r.verified) expect(r.crossCheck).toBeTruthy();
    }
    expect(byel.records.length).toBeGreaterThanOrEqual(15);
  });
  it("Jubilee Hills 2025 is INC, Naveen Yadav, margin 24,729, verified", () => {
    const r = byel.records.find(x => x.id === "TG-assembly-61-2025-11")!;
    expect(r).toMatchObject({ state: "TG", party: "INC", margin: 24729, verified: true });
    expect(r.winner).toMatch(/NAVEEN YADAV/i);
  });
  it("seat resolution prefers exact names and refuses ambiguity", () => {
    const idx = seatIndexFrom(rows);
    expect(resolveSeat(idx, "assembly", "NARAYANKHED")).toMatchObject({ state: "TG", acNo: 35 });
    expect(resolveSeat(idx, "assembly", "NO SUCH SEAT")).toBeNull();
  });
});

describe("party switches (S-112)", () => {
  it("shipped records pass the citation policy", () => {
    expect(validatePartySwitches(switches.records)).toEqual([]);
  });
  it("rejects a single-source or judgemental entry", () => {
    const base = switches.records[0];
    expect(validatePartySwitches([{ ...base, sources: [base.sources[0]] }])).toEqual(expect.arrayContaining([expect.stringMatching(/two different sites/)]));
    expect(validatePartySwitches([{ ...base, sources: [base.sources[0], { publisher: "x", url: "https://www." + new URL(base.sources[0].url).hostname.replace(/^www\./, "") + "/b" }] }]).length).toBeGreaterThan(0);
    expect(validatePartySwitches([{ ...base, note: "a turncoat" }]).join()).toMatch(/judgemental/);
  });
});

describe("comparison and incumbency (S-117)", () => {
  it("incumbency is withheld where the source has no flag and says why", () => {
    const s = incumbencySummary(all, "AP", 2024, "assembly")!;
    expect(s.available).toBe(false);
    expect(s.winRatePct).toBeNull();
    expect(s.reason).toMatch(/incumbent flag/);
    expect(s.seatRetention?.previousYear).toBe(2019);
  });
  it("incumbency with flag: AP 2019 re-contest win rate is computed from the flagged rows", () => {
    const s = incumbencySummary(all, "AP", 2019, "assembly")!;
    expect(s.available).toBe(true);
    expect(s.incumbentsContesting).toBe(130);
    expect(s.incumbentsWon).toBe(52);
    expect(s.winRatePct).toBeCloseTo(40, 0);
    expect(s.swingVsIncumbent?.matched).toBeGreaterThan(0);
  });
  it("party shares compare assembly with Lok Sabha of the same year, including the split 2014 poll", () => {
    const a = all.filter(r => r.state === "TG" && r.year === 2014 && r.type === "assembly"), l = all.filter(r => r.state === "TG" && r.year === 2014 && r.type === "ls");
    const rowsC = partyShareCompare(a, l);
    expect(rowsC.length).toBeGreaterThan(3);
    for (const r of rowsC) expect(r.diffPp).toBeCloseTo(r.lsShare - r.assemblyShare, 1);
  });
  it("candidate trails carry a match confidence and no judgemental label", () => {
    const t = candidateTrails(all, "AP", "assembly", "NARA");
    expect(t.length).toBeGreaterThan(0);
    for (const x of t) { expect(["high", "medium"]).toContain(x.match.confidence); expect(x.appearances.length).toBeGreaterThanOrEqual(2); }
    expect(JSON.stringify(t)).not.toMatch(/turncoat|defect/i);
    expect(t.map(x => x.name)).toEqual([...t.map(x => x.name)].sort((a, b) => a.localeCompare(b)));
  });
});

describe("analytics API", () => {
  let server: Server, base = "";
  const data: Datasets = { elections: rows, census: [], demo: false, status: [], manifest: loadManifestIndex(ROOT) };
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: (await r.json()) as any }; };
  beforeAll(async () => {
    process.env.PEOPLE_BLACKOUT = "0";
    const app = express();
    app.use("/api/v1", createApiRouter(data));
    server = app.listen(0, "127.0.0.1");
    await new Promise(r => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(() => { server.close(); delete process.env.PEOPLE_BLACKOUT; });

  it("GET /elections/:state/turnout defaults to the latest year and carries a source", async () => {
    const { status, body } = await get("/elections/AP/turnout");
    expect(status).toBe(200);
    expect(body.year).toBe(2024);
    expect(body.seats).toHaveLength(175);
    expect(body.genderTurnout.available).toBe(false);
    expect(body.source.dataset).toBe("elections");
    expect(body.years).toContain(2009);
  });
  it("serves pre-bifurcation years with their own source and the comparability flag", async () => {
    const { status, body } = await get("/elections/TG/turnout?year=2009&type=assembly");
    expect(status).toBe(200);
    expect(body.comparability).toBe("pre-bifurcation");
    expect(body.source.dataset).toBe("history-prebifurcation");
    const el = await get("/elections?state=AP&year=2009&type=assembly");
    expect(el.body.count).toBe(175);
    expect(el.body.comparability).toBe("pre-bifurcation");
    const sum = await get("/elections/TG/summary?year=2014&type=ls");
    expect(sum.body.totalSeats).toBe(17);
  });
  it("existing years still reach the main handlers", async () => {
    const { body } = await get("/elections?state=AP&year=2024&type=assembly");
    expect(body.tally.TDP).toBe(135);
    expect(body.comparability).toBeUndefined();
  });
  it("validates input", async () => {
    expect((await get("/elections/XX/turnout")).status).toBe(404);
    expect((await get("/elections/AP/turnout?year=19")).status).toBe(400);
    expect((await get("/elections/AP/turnout?year=1999")).status).toBe(404);
    expect((await get("/elections/AP/turnout?type=zzz")).status).toBe(400);
    expect((await get("/analytics/candidates/AP?q=a")).status).toBe(400);
    expect((await get("/byelections?acNo=abc")).status).toBe(400);
  });
  it("compare returns party shares, per-PC rows, incumbency and caveats", async () => {
    const { status, body } = await get("/analytics/compare/AP?year=2019");
    expect(status).toBe(200);
    expect(body.constituencies).toHaveLength(25);
    expect(body.notes.join(" ")).toMatch(/per parliamentary constituency/);
    expect(body.incumbency.assembly.available).toBe(true);
    const d = await get("/analytics/compare/TG?year=2014");
    expect(d.status).toBe(200);
  });
  it("history lists the split elections with notes", async () => {
    const { body } = await get("/history/AP");
    expect(body.elections.find((e: any) => e.year === 2009 && e.type === "assembly")).toMatchObject({ seats: 175, comparability: "pre-bifurcation" });
    expect(body.elections.find((e: any) => e.year === 2014 && e.type === "ls")).toMatchObject({ seats: 25 });
  });
  it("by-elections filter by seat", async () => {
    const { body } = await get("/byelections?state=TG&type=assembly&acNo=61");
    expect(body.count).toBe(1);
    expect(body.records[0].party).toBe("INC");
  });
  it("party switches use one fixed shape and are hidden during blackout", async () => {
    const { body } = await get("/party-switches?name=Danam%20Nagender");
    expect(body.count).toBe(1);
    expect(body.records[0].sources.length).toBeGreaterThanOrEqual(2);
    const none = await get("/party-switches?name=Nobody%20Here");
    expect(none.body).toMatchObject({ count: 0, blackout: false });
    process.env.PEOPLE_BLACKOUT = "1";
    const b = await get("/party-switches?name=Danam%20Nagender");
    expect(b.body.count).toBe(0);
    expect(b.body.blackout).toBe(true);
    expect(b.body.notice.en).toBeTruthy();
    process.env.PEOPLE_BLACKOUT = "0";
  });
});
