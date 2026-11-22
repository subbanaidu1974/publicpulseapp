import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { createApiRouter, loadDatasets } from "../../server/api";
import type { Datasets } from "../../server/api";
import type { CandidateResult } from "../../src/lib/elections";
import type { CensusDistrict } from "../../pipeline/census";
import type { ElectionType, StateCode } from "../../src/lib/states";

/** Build a small synthetic election: each seat = [winnerParty, winnerVotes, runnerUpParty, runnerUpVotes]. */
function election(state: StateCode, year: number, type: ElectionType, seats: [string, number, string, number][]): CandidateResult[] {
  return seats.flatMap(([wp, wv, rp, rv], i) => {
    const base = { state, year, type, acNo: i + 1, acName: `AC-${i + 1}`, validVotes: wv + rv, provenance: "demo" as const };
    return [
      { ...base, candidate: `${wp} cand ${i + 1}`, party: wp, votes: wv, position: 1 },
      { ...base, candidate: `${rp} cand ${i + 1}`, party: rp, votes: rv, position: 2 },
    ];
  });
}

const census = (state: StateCode, district: string, population: number): CensusDistrict => ({
  state, district, censusYear: 2011, population, literate: population * 0.7, scPop: population * 0.15, stPop: population * 0.05,
  males: population / 2, females: population / 2, literacyPct: 70, scPct: 15, stPct: 5, sexRatio: 1000, source: "demo",
});

const elections: CandidateResult[] = [
  // AP 2019: YSRCP 3, TDP 1 ; AP 2024: TDP 2, JSP 1, YSRCP 1  (4 seats)
  ...election("AP", 2019, "assembly", [["YSRCP", 600, "TDP", 400], ["YSRCP", 550, "TDP", 450], ["YSRCP", 700, "TDP", 300], ["TDP", 520, "YSRCP", 480]]),
  ...election("AP", 2024, "assembly", [["TDP", 600, "YSRCP", 400], ["JSP", 510, "YSRCP", 490], ["TDP", 700, "YSRCP", 300], ["YSRCP", 530, "TDP", 470]]),
  // TG 2023: INC 3, BRS 1, BJP 1 (5 seats); one is a 1% marginal, one 0.5%
  ...election("TG", 2023, "assembly", [["INC", 5050, "BRS", 4950], ["INC", 6000, "BRS", 4000], ["INC", 7000, "BJP", 3000], ["BRS", 5025, "INC", 4975], ["BJP", 6500, "INC", 3500]]),
];

const data: Datasets = {
  elections,
  census: [census("TG", "Hyderabad", 4000000), census("TG", "Warangal", 3000000), census("AP", "Guntur", 5000000)],
  demo: true,
  status: [
    { name: "elections", rows: elections.length, provenance: "demo", generatedAt: null },
    { name: "census", rows: 3, provenance: "demo", generatedAt: null },
  ],
};

let server: Server;
let base: string;

async function get(p: string) {
  const res = await fetch(base + p);
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: res.status, body, text, type: res.headers.get("content-type") ?? "" };
}

function start(d: Datasets) {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createApiRouter(d));
  return new Promise<Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
}

beforeAll(async () => {
  server = await start(data);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>(resolve => { server.close(() => resolve()); }));

describe("@E2E-01 GET /states", () => {
  it("returns AP and TG with configured seat counts", async () => {
    const { status, body } = await get("/states");
    expect(status).toBe(200);
    expect(body.demo).toBe(true);
    const byCode = Object.fromEntries(body.states.map((s: any) => [s.code, s]));
    expect(byCode.AP.assemblySeats).toBe(175);
    expect(byCode.AP.lsSeats).toBe(25);
    expect(byCode.TG.assemblySeats).toBe(119);
    expect(byCode.TG.lsSeats).toBe(17);
    expect(byCode.AP.elections).toContainEqual({ year: 2024, type: "assembly" });
  });

  it("serves /health and /data-status", async () => {
    expect((await get("/health")).body).toEqual({ ok: true, demo: true });
    const ds = await get("/data-status");
    expect(ds.status).toBe(200);
    expect(ds.body.datasets.map((d: any) => d.name)).toEqual(["elections", "census"]);
    expect(ds.body.datasets[0]).toHaveProperty("provenance");
    expect(ds.body.datasets[0]).toHaveProperty("generatedAt");
  });
});

describe("@E2E-02 GET /elections", () => {
  it("returns seat winners and the largest party for TG 2023", async () => {
    const { status, body } = await get("/elections?state=TG&year=2023&type=assembly");
    expect(status).toBe(200);
    expect(body.demo).toBe(true);
    expect(body.count).toBe(5);
    expect(body.seats).toHaveLength(5);
    expect(body.seats[0]).toMatchObject({ acNo: 1, winnerParty: "INC" });
    const largest = Object.entries(body.tally as Record<string, number>).sort((a, b) => b[1] - a[1])[0][0];
    expect(largest).toBe("INC");
    expect(body.tally.INC).toBe(3);
  });

  it("defaults type to assembly and year to latest; accepts lowercase state", async () => {
    const { status, body } = await get("/elections?state=ap");
    expect(status).toBe(200);
    expect(body.year).toBe(2024);
    expect(body.type).toBe("assembly");
  });
});

describe("@E2E-03 GET /elections/:state/summary", () => {
  it("tally sums to the seats and alliance aggregation is present for AP 2024", async () => {
    const { status, body } = await get("/elections/AP/summary?year=2024&type=assembly");
    expect(status).toBe(200);
    const sum = Object.values(body.tally as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(sum).toBe(body.totalSeats);
    expect(body.totalSeats).toBe(4);
    // NDA = TDP(2) + JSP(1)
    expect(body.alliances.tally["NDA (TDP+JSP+BJP)"]).toBe(3);
    expect(body.alliances.tally.YSRCP).toBe(1);
    expect(Object.values(body.voteShare as Record<string, number>).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1);
    expect(Object.values(body.marginBuckets as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("alliances is null where none are defined", async () => {
    const { body } = await get("/elections/TG/summary?year=2023");
    expect(body.alliances).toBeNull();
  });
});

describe("@E2E-04 GET /elections/:state/swing", () => {
  it("returns per-party swing summing to ~0", async () => {
    const { status, body } = await get("/elections/AP/swing?from=2019&to=2024");
    expect(status).toBe(200);
    expect(body.unit).toBe("percentage points");
    const total = Object.values(body.swing as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(Math.abs(total)).toBeLessThan(0.05);
    expect(body.swing.JSP).toBeGreaterThan(0);
    expect(body.swing.TDP).toBeGreaterThan(0);
    expect(body.swing.YSRCP).toBeLessThan(0);
  });
});

describe("@E2E-05 GET /elections/:state/marginal", () => {
  it("returns only seats under the threshold, narrowest first", async () => {
    const { status, body } = await get("/elections/TG/marginal?threshold=2&year=2023");
    expect(status).toBe(200);
    expect(body.thresholdPct).toBe(2);
    expect(body.seats.map((s: any) => s.acNo)).toEqual([4, 1]);
    for (const s of body.seats) expect(s.marginPct).toBeLessThan(2);
    expect(body.count).toBe(2);
  });

  it("threshold 0 yields no seats", async () => {
    expect((await get("/elections/TG/marginal?threshold=0")).body.count).toBe(0);
  });
});

describe("@E2E-06 GET /census/:state/districts", () => {
  it("returns census-tagged district rows with population, literacy and SC/ST %", async () => {
    const { status, body } = await get("/census/TG/districts");
    expect(status).toBe(200);
    expect(body.censusYear).toBe(2011);
    expect(body.count).toBe(2);
    for (const d of body.districts) {
      expect(d.state).toBe("TG");
      expect(d.censusYear).toBe(2011);
      expect(d).toHaveProperty("population");
      expect(d).toHaveProperty("literacyPct");
      expect(d).toHaveProperty("scPct");
      expect(d).toHaveProperty("stPct");
    }
  });
});

describe("@E2E-07 validation and error contract", () => {
  const cases: [string, string, number][] = [
    ["unknown state in path", "/elections/XX/summary", 404],
    ["unknown state in query", "/elections?state=XX&year=2023", 404],
    ["unknown state census", "/census/XX/districts", 404],
    ["missing state", "/elections?year=2023", 400],
    ["non-numeric year", "/elections?state=TG&year=abcd", 400],
    ["injection-like year", "/elections?state=TG&year=2023'%20OR%201=1", 400],
    ["year out of range", "/elections?state=TG&year=1800", 400],
    ["invalid type", "/elections?state=TG&year=2023&type=senate", 400],
    ["year with no data", "/elections?state=TG&year=2010", 404],
    ["missing swing params", "/elections/AP/swing?from=2019", 400],
    ["equal swing years", "/elections/AP/swing?from=2019&to=2019", 400],
    ["swing year without data", "/elections/AP/swing?from=2019&to=2031", 404],
    ["negative threshold", "/elections/TG/marginal?threshold=-1", 400],
    ["non-numeric threshold", "/elections/TG/marginal?threshold=abc", 400],
    ["threshold too large", "/elections/TG/marginal?threshold=101", 400],
    ["unknown route", "/nope", 404],
  ];

  for (const [name, p, expected] of cases) {
    it(`${name} -> ${expected} JSON error without stack`, async () => {
      const r = await get(p);
      expect(r.status).toBe(expected);
      expect(r.type).toContain("application/json");
      expect(Object.keys(r.body)).toEqual(["error"]);
      expect(typeof r.body.error).toBe("string");
      expect(r.text).not.toMatch(/\bat .*\(|node_modules|\.ts:\d+|Error:/);
    });
  }

  it("unexpected errors return a generic 500 JSON with no internals", async () => {
    const broken = { ...data, elections: null as unknown as CandidateResult[] };
    const s = await start(broken);
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/v1/elections?state=TG&year=2023`;
      const res = await fetch(url);
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: "Internal server error" });
      expect(text).not.toMatch(/null|\.ts|node_modules/);
    } finally {
      await new Promise<void>(r => s.close(() => r()));
    }
  });
});

describe("@E2E-01 loadDatasets demo fallback", () => {
  it("falls back to demo fixtures when no generated data exists", () => {
    const ds = loadDatasets("C:/__no_such_dir__");
    expect(ds.demo).toBe(true);
    expect(ds.elections).toEqual([]);
    expect(ds.status.map(s => s.name)).toEqual(["elections", "census"]);
  });

  it("loads the repo demo fixtures and flags demo", () => {
    const ds = loadDatasets();
    if (ds.status.every(s => s.provenance !== "demo")) return; // real generated data present
    expect(ds.demo).toBe(true);
    expect(ds.elections.length).toBeGreaterThan(0);
    expect(ds.elections.every(r => r.state === "AP" || r.state === "TG")).toBe(true);
    expect(ds.census.length).toBeGreaterThan(0);
  });
});
