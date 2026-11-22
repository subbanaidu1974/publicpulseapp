import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { createApiRouter, loadDatasets } from "../../server/api";

/** S-119: the process-lifetime forecast cache must refresh when data/generated/elections.json changes. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-cache-"));
const file = path.join(dir, "data", "generated", "elections.json");
const row = (year: number, acNo: number, party: string, votes: number) => ({ state: "AP", type: "assembly", year, acNo, acName: `S${acNo}`, candidate: `${party}${acNo}${year}`, party, votes, provenance: "test" });
const rowsFor = (flip: boolean) => {
  const out: unknown[] = [];
  for (const y of [2014, 2019]) for (let ac = 1; ac <= 40; ac++) {
    const win = (ac % 2 === 0) !== (flip && y === 2019);
    out.push(row(y, ac, win ? "TDP" : "YSRCP", 60000), row(y, ac, win ? "YSRCP" : "TDP", 40000));
  }
  return out;
};
const write = (flip: boolean, mtime: number) => {
  fs.writeFileSync(file, JSON.stringify({ provenance: "test", generatedAt: "t", rows: rowsFor(flip) }));
  fs.utimesSync(file, mtime, mtime);
};
let server: Server; let base: string; let prev: string | undefined;
beforeAll(async () => {
  prev = process.env.ELECTION_WINDOW_FAIL_OPEN_FORECAST; process.env.ELECTION_WINDOW_FAIL_OPEN_FORECAST = "1";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  write(false, 1_700_000_000);
  const app = express();
  app.use("/api/v1", createApiRouter(loadDatasets(dir), { baseDir: dir }));
  server = await new Promise<Server>((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>((res) => {
  if (prev === undefined) delete process.env.ELECTION_WINDOW_FAIL_OPEN_FORECAST; else process.env.ELECTION_WINDOW_FAIL_OPEN_FORECAST = prev;
  server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); res(); });
}));

describe("forecast cache invalidation", () => {
  it("@E2E-134 same file serves the cached forecast; a changed elections file recomputes and changes the snapshot", async () => {
    const a = await (await fetch(`${base}/elections/AP/forecast`)).json() as any;
    const a2 = await (await fetch(`${base}/elections/AP/forecast`)).json() as any;
    expect(a.dataSnapshot.signature).toBe(a2.dataSnapshot.signature);
    expect(a.dataSnapshot.checksum).toMatch(/^[0-9a-f]{16}$/);
    write(true, 1_800_000_000);
    const b = await (await fetch(`${base}/elections/AP/forecast`)).json() as any;
    expect(b.dataSnapshot.signature).not.toBe(a.dataSnapshot.signature);
    expect(b.dataSnapshot.checksum).not.toBe(a.dataSnapshot.checksum);
    expect(JSON.stringify(b.seats)).not.toBe(JSON.stringify(a.seats));
  });
});
