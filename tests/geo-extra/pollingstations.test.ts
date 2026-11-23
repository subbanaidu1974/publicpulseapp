import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGeoApiRouter } from "../../server/geo-api";
import { LegalGuardError, parseStationCsv, toReference, validateStation, validateStations, voterLevelKeys } from "../../pipeline/geo/pollingstations";
import { importPollingStations } from "../../scripts/import-pollingstations";

const good = { stationNo: "12A", name: "Mandal Parishad Primary School", acNo: 5, partNo: 12, location: "Main road, near bus stand", lat: 16.5, lon: 80.6, source: "test list", asOf: "2026-01-01" };
const CSV = [
  "station_no,name,ac_no,part_no,location,lat,lon",
  "1,ZP High School,5,1,Gandhi road near temple,16.51,80.61",
  "2,Community Hall,5,2,Opposite RTC depot,,",
  "1,Govt Junior College,6,1,College road,,",
].join("\n");

describe("@E2E-106 polling-station schema and legal guard", () => {
  it("accepts a reference record", () => { expect(validateStation(good)).toEqual([]); });

  it("rejects a roll-like record with voter-level fields", () => {
    const roll = { ...good, electorName: "A Person", epic: "ABC1234567", relativeName: "B Person", age: 41, gender: "F", houseNo: "4-5-6" };
    const errs = validateStation(roll);
    expect(errs.join(" ")).toMatch(/voter-level field/);
    expect(voterLevelKeys(roll).sort()).toEqual(["age", "electorName", "epic", "gender", "houseNo", "relativeName"].sort());
    for (const k of ["epic", "voterId", "fatherName", "husbandName", "dob", "mobile", "address", "aadhaar", "photo", "sex"]) expect(validateStation({ ...good, [k]: "x" }).join(), k).toMatch(/voter-level/);
  });

  it("rejects an EPIC, phone or Aadhaar value hidden in an allowed field", () => {
    expect(validateStation({ ...good, name: "School ABC1234567" }).join()).toMatch(/EPIC/);
    expect(validateStation({ ...good, location: "Contact 9876543210" }).join()).toMatch(/phone/);
    expect(validateStation({ ...good, location: "1234 5678 9012" }).join()).toMatch(/Aadhaar/);
  });

  it("rejects unknown fields, bad numbers, half a coordinate and over-long location text", () => {
    expect(validateStation({ ...good, extra: 1 }).join()).toMatch(/unknown field/);
    expect(validateStation({ ...good, stationNo: "abc" }).length).toBeGreaterThan(0);
    expect(validateStation({ ...good, acNo: 0 }).length).toBeGreaterThan(0);
    expect(validateStation({ ...good, lon: null }).join()).toMatch(/both/);
    expect(validateStation({ ...good, lat: 1, lon: 2 }).join()).toMatch(/inside India/);
    expect(validateStation({ ...good, location: "x".repeat(201) }).length).toBeGreaterThan(0);
    expect(validateStation({ ...good, asOf: "01/01/2026" }).length).toBeGreaterThan(0);
  });

  it("flags duplicate stations inside one AC", () => {
    expect(validateStations([toReference(good), toReference(good)])[0]).toMatch(/duplicate/);
  });

  it("projects to reference fields only", () => {
    expect(Object.keys(toReference({ ...good, epic: "ABC1234567" } as never)).sort()).toEqual(["acNo", "asOf", "lat", "location", "lon", "name", "partNo", "source", "stationNo"]);
  });
});

describe("@E2E-106 CSV importer", () => {
  it("parses an operator CSV with header aliases and per-file provenance", () => {
    const r = parseStationCsv(CSV, { source: "CEO list", asOf: "2026-02-01" });
    expect(r.rejected).toEqual([]);
    expect(r.records).toHaveLength(3);
    expect(r.records[0]).toMatchObject({ stationNo: "1", acNo: 5, partNo: 1, lat: 16.51, source: "CEO list", asOf: "2026-02-01" });
    expect(r.records[1].lat).toBeNull();
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects the whole file when it has voter-level columns (an electoral-roll extract)", () => {
    const roll = "serial_no,elector_name,relative_name,epic_no,age,gender,house_no,station_no,name,ac_no,location\n1,A,B,ABC1234567,30,M,1-1,1,School,5,Road";
    expect(() => parseStationCsv(roll, { source: "x", asOf: "2026-01-01" })).toThrow(LegalGuardError);
    expect(() => parseStationCsv("station_no,name,ac_no,location,address\n1,S,5,Road,4-5 Some street", { source: "x", asOf: "2026-01-01" })).toThrow(/voter-level/);
    expect(() => parseStationCsv("station_no,name,ac_no,location,notes\n1,S,5,Road,hi", { source: "x", asOf: "2026-01-01" })).toThrow(/unknown CSV column/);
  });

  it("reports invalid rows with their line numbers", () => {
    const r = parseStationCsv("station_no,name,ac_no,location\n1,School,5,Road\nxx,School,5,Road\n", { source: "s", asOf: "2026-01-01" });
    expect(r.records).toHaveLength(1);
    expect(r.rejected[0].row).toBe(3);
  });

  it("imports a drop-in directory to a generated file, and refuses a roll CSV without writing anything", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ps-"));
    const raw = path.join(tmp, "raw"), out = path.join(tmp, "out");
    fs.mkdirSync(raw); fs.mkdirSync(out);
    expect(importPollingStations(raw, out, { source: "s", asOf: "2026-01-01" })).toEqual([]);
    fs.writeFileSync(path.join(raw, "AP-list.csv"), CSV);
    const res = importPollingStations(raw, out, { source: "CEO AP", asOf: "2026-02-01" });
    expect(res).toEqual([{ state: "AP", stations: 3, files: 1 }]);
    const j = JSON.parse(fs.readFileSync(path.join(out, "polling-stations-AP.json"), "utf8"));
    expect(j.provenance).toBe("operator-supplied");
    expect(j.files[0].name).toBe("AP-list.csv");
    expect(j.records).toHaveLength(3);
    fs.rmSync(raw, { recursive: true });
    fs.mkdirSync(raw);
    fs.writeFileSync(path.join(raw, "TG-roll.csv"), "elector_name,epic_no,station_no,name,ac_no,location\nA,ABC1234567,1,S,5,R");
    expect(() => importPollingStations(raw, out, { source: "s", asOf: "2026-01-01" })).toThrow(LegalGuardError);
    expect(fs.existsSync(path.join(out, "polling-stations-TG.json"))).toBe(false);
    fs.writeFileSync(path.join(raw, "TG-roll.csv"), "station_no,name,ac_no,location\n1,S,200,R");
    expect(() => importPollingStations(raw, out, { source: "s", asOf: "2026-01-01" })).toThrow(/above 119/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("@E2E-106 GET /geo/:state/polling-stations", () => {
  let server: Server, base: string, tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ps-api-"));
    const geo = path.join(tmp, "data", "generated", "geo");
    fs.mkdirSync(geo, { recursive: true });
    const recs = parseStationCsv(CSV, { source: "CEO list", asOf: "2026-02-01" }).records;
    // a hostile file that carries extra voter-level members must not leak through the route
    fs.writeFileSync(path.join(geo, "polling-stations-AP.json"), JSON.stringify({ schema: 1, state: "AP", asOf: "2026-02-01", provenance: "operator-supplied", records: recs.map(r => ({ ...r, epic: "ABC1234567", electorName: "Leak" })) }));
    const app = express();
    app.use("/api/v1", createGeoApiRouter({ elections: [], census: [], demo: false, status: [] } as never, { baseDir: tmp }));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it("filters by ac and returns only reference fields", async () => {
    const r = await fetch(`${base}/geo/AP/polling-stations?ac=5`);
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(b.available).toBe(true);
    expect(b.total).toBe(2);
    expect(b.items.map((s: { stationNo: string }) => s.stationNo)).toEqual(["1", "2"]);
    const text = JSON.stringify(b);
    expect(text).not.toMatch(/ABC1234567|Leak|epic|electorName/);
    for (const s of b.items) expect(Object.keys(s).sort()).toEqual(["acNo", "asOf", "lat", "location", "lon", "name", "partNo", "source", "stationNo"]);
  });
  it("answers an unimported state with available:false and no fabricated data", async () => {
    const b = await (await fetch(`${base}/geo/TG/polling-stations?ac=5`)).json();
    expect(b).toMatchObject({ available: false, total: 0, items: [] });
  });
  it("validates inputs", async () => {
    expect((await fetch(`${base}/geo/AP/polling-stations?ac=abc`)).status).toBe(400);
    expect((await fetch(`${base}/geo/ZZ/polling-stations`)).status).toBe(404);
  });
  it("ships no polling-station data in the repository", () => {
    for (const st of ["AP", "TG"]) expect(fs.existsSync(path.join(process.cwd(), "data", "generated", "geo", `polling-stations-${st}.json`))).toBe(false);
  });
});
