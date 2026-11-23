import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createSession, getDb, getStore, grantRole, migrate, resetDbForTests, verifyAuditChain } from "../../../server/civic/core";
import type { RoleName } from "../../../server/civic/core";
import { loadDemoGeo } from "../../../server/civic/geo/service";
import { adminRouter } from "../../../server/civic/admin/routes";
import { issuesRouter } from "../../../server/civic/issues/routes";
import { clock, reportIssue } from "../../../server/civic/issues/service";
import { resetExportRate } from "../../../server/civic/issues/public";
import { scopeCovers, scopeRouter, validateGrantJurisdiction, validateGrantUnit } from "../../../server/civic/scope";

let server: Server, base = "";
beforeAll(async () => {
  const app = express();
  app.use("/scope", scopeRouter);
  app.use("/admin", adminRouter);
  app.use("/issues", issuesRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { resetDbForTests(); migrate(); loadDemoGeo(); resetExportRate(); clock.now = () => new Date(); });

function person(role?: RoleName, jurisdiction?: string, department?: string) {
  const id = randomUUID(), now = new Date().toISOString();
  getDb().prepare("INSERT INTO persons (id, created_at, eligible_from) VALUES (?,?,?)").run(id, now, now);
  if (role) grantRole("system", id, role, jurisdiction ?? null, department ?? null);
  return { id, token: createSession(id) };
}
async function call(token: string | null, p: string, method = "GET", body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, json, headers: r.headers };
}
const auditRows = (action: string) => getStore("audit").prepare("SELECT actor, action, object, meta FROM audit_log WHERE action = ?").all(action) as { actor: string; action: string; object: string; meta: string }[];

describe("scope model (S-40)", () => {
  it("@E2E-49 a constituency covers its villages and mandals, a district covers its units, boundary versions apply", () => {
    expect(scopeCovers({ role: "politician", jurisdiction: "DEMO-C-TNL" }, "DEMO-V-KLR")).toBe(true);
    expect(scopeCovers({ role: "politician", jurisdiction: "DEMO-C-TNL" }, "DEMO-M-KLP")).toBe(true); // mandal holds a village of the AC
    expect(scopeCovers({ role: "politician", jurisdiction: "DEMO-C-PTR" }, "DEMO-M-KLP")).toBe(true); // overlap: Bhimavaram Palem is in both
    expect(scopeCovers({ role: "politician", jurisdiction: "DEMO-C-WGE" }, "DEMO-V-KLR")).toBe(false);
    expect(scopeCovers({ role: "officer", jurisdiction: "DEMO-D-GNT" }, "DEMO-C-TNL")).toBe(true);
    expect(scopeCovers({ role: "officer", jurisdiction: "DEMO-D-GNT" }, "DEMO-V-HNK")).toBe(false);
    expect(scopeCovers({ role: "journalist", jurisdiction: null }, "DEMO-V-HNK")).toBe(true);
    expect(scopeCovers({ role: "journalist", jurisdiction: null }, "NO-SUCH-UNIT")).toBe(false);
    expect(scopeCovers({ role: "politician", jurisdiction: null }, "DEMO-V-KLR")).toBe(false); // fails closed
    // Angalakuduru moved from Tenali to Ponnur on 2026-01-01 (end exclusive)
    expect(scopeCovers({ role: "politician", jurisdiction: "DEMO-C-TNL" }, "DEMO-V-ANM", "2025-06-01")).toBe(true);
    expect(scopeCovers({ role: "politician", jurisdiction: "DEMO-C-TNL" }, "DEMO-V-ANM", "2026-06-01")).toBe(false);
    expect(scopeCovers({ role: "politician", jurisdiction: "DEMO-C-PTR" }, "DEMO-V-ANM", "2026-01-01")).toBe(true);
  });

  it("@E2E-49 grant validation: politician needs a constituency, journalist and ECI liaison only state-level", () => {
    expect(validateGrantJurisdiction("politician", "")).toBe("politician_needs_constituency");
    expect(validateGrantJurisdiction("politician", "bad code!")).toBe("jurisdiction_format");
    expect(validateGrantJurisdiction("journalist", "")).toBeNull();
    expect(validateGrantJurisdiction("officer", "village:1")).toBeNull(); // other roles keep their free-form scope
    expect(validateGrantUnit("politician", "DEMO-C-TNL")).toBeNull();
    expect(validateGrantUnit("politician", "DEMO-D-GNT")).toBe("politician_needs_constituency");
    expect(validateGrantUnit("politician", "DEMO-C-NOPE")).toBe("unknown_jurisdiction");
    expect(validateGrantUnit("journalist", "DEMO-C-TNL")).toBe("state_level_only");
    expect(validateGrantUnit("journalist", "DEMO-S-AP")).toBeNull();
  });
});

describe("scoped routes (S-40)", () => {
  it("@E2E-49 politician A reads own constituency; constituency B is 403 outside_scope and audited", async () => {
    const a = person("politician", "DEMO-C-TNL");
    const ok = await call(a.token, "/scope/issues/summary");
    expect(ok.status).toBe(200);
    expect(ok.json.unit.lgd).toBe("DEMO-C-TNL");
    const own = await call(a.token, "/scope/issues/summary?unit=DEMO-V-KLR");
    expect(own.status).toBe(200);
    const b = await call(a.token, "/scope/issues/summary?unit=DEMO-C-WGE");
    expect(b.status).toBe(403);
    expect(b.json.error).toBe("outside_scope");
    const state = await call(a.token, "/scope/issues/summary?unit=DEMO-S-AP"); // wider than the grant
    expect(state.status).toBe(403);
    const denials = auditRows("scope.denied").filter((r) => r.actor === a.id);
    expect(denials.length).toBe(2);
    expect(denials[0].object).toBe("unit:DEMO-C-WGE");
    expect(JSON.parse(denials[0].meta).reason).toBe("outside_scope");
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("@E2E-49 a politician with no constituency, and a citizen with no role, get 403 role or scope errors", async () => {
    const bad = person("politician");
    const r = await call(bad.token, "/scope/issues/summary");
    expect(r.status).toBe(403);
    const citizen = person();
    const c = await call(citizen.token, "/scope/issues/summary");
    expect(c.status).toBe(403);
    expect(c.json.code).toBe("role_required");
    expect((await call(null, "/scope/me")).status).toBe(401);
    expect(auditRows("scope.denied").length).toBe(2);
  });

  it("@E2E-49 officer outside the department or jurisdiction is 403; own department works", async () => {
    const o = person("officer", "DEMO-D-GNT", "Rural Water Supply");
    expect((await call(o.token, "/scope/issues/summary")).status).toBe(200);
    expect((await call(o.token, "/scope/issues/summary?department=Roads%20and%20Buildings")).json.error).toBe("department_mismatch");
    expect((await call(o.token, "/scope/issues/summary?unit=DEMO-D-WGL")).json.error).toBe("outside_scope");
    expect(auditRows("scope.denied").length).toBe(2);
  });

  it("@E2E-49 small cells are withheld: named, never counted; a cell of 30 or more is shown", async () => {
    const o = person("officer", "DEMO-D-GNT");
    reportIssue("reporter-0", { category: "water", village_lgd: "DEMO-V-KLR", description_en: "Water supply failed for a week", lat: 16.2, lon: 80.1 } as never);
    const d = getStore("issues"); // clone the row to reach the cell size without fighting the duplicate merger
    const cols = (d.prepare("PRAGMA table_info(issue)").all() as { name: string }[]).map((c) => c.name).filter((c) => c !== "id");
    const base = d.prepare("SELECT id FROM issue WHERE category='water'").get() as { id: string };
    for (let i = 0; i < 30; i++) d.prepare(`INSERT INTO issue (id, ${cols.join(",")}) SELECT ?, ${cols.join(",")} FROM issue WHERE id = ?`).run("clone-" + i, base.id);
    reportIssue("reporter-x", { category: "roads", village_lgd: "DEMO-V-KLR", description_en: "A single pothole", lat: 16.9, lon: 80.9 } as never);
    const r = await call(o.token, "/scope/issues/summary");
    expect(r.status).toBe(200);
    const water = r.json.cells.find((c: any) => c.department.toLowerCase().includes("water"));
    expect(water?.total).toBeGreaterThanOrEqual(30);
    expect(r.json.masked.length).toBe(1);
    expect(JSON.stringify(r.json.masked)).not.toMatch(/"total"|"count"/);
    expect(r.json.total_shown).toBe(water.total);
  });

  it("@E2E-49 journalist gets exactly the public export bytes, and no early or individual data", async () => {
    reportIssue("rp1", { category: "water", village_lgd: "DEMO-V-KLR", description_en: "Handpump broken near school", lat: 16.2, lon: 80.1 } as never);
    reportIssue("rp2", { category: "roads", village_lgd: "DEMO-V-HNK", description_en: "Road washed away by rain", lat: 17.9, lon: 79.5 } as never);
    const j = person("journalist");
    for (const fmt of ["ndjson", "csv"]) {
      const pubRes = await fetch(`${base}/issues/export?format=${fmt}`);
      const pubBytes = Buffer.from(await pubRes.arrayBuffer());
      const sc = await fetch(`${base}/scope/export?format=${fmt}`, { headers: { authorization: "Bearer " + j.token } });
      expect(sc.status).toBe(200);
      const scBytes = Buffer.from(await sc.arrayBuffer());
      expect(scBytes.equals(pubBytes), fmt).toBe(true);
      expect(scBytes.length).toBeGreaterThan(20);
      expect(sc.headers.get("content-type")).toBe(pubRes.headers.get("content-type"));
      expect(scBytes.toString()).not.toMatch(/reporter|person|phone/i);
    }
    expect((await call(person("politician", "DEMO-C-TNL").token, "/scope/export")).status).toBe(403);
    const surveys = await call(j.token, "/scope/surveys/summary");
    expect(surveys.json).toMatchObject({ early_access: false, published: [] });
  });

  it("@E2E-49 eci_liaison reads the audit summary (no actor ids) and cannot call any mutating admin or scope route", async () => {
    const e = person("eci_liaison");
    const s = await call(e.token, "/scope/audit/summary");
    expect(s.status).toBe(200);
    expect(s.json).toHaveProperty("head");
    expect(s.json.anchors).toHaveProperty("chain_ok");
    expect(s.json.block_log).toHaveProperty("total");
    expect(s.text).not.toContain(e.id);
    expect(s.text).not.toMatch(/actor/i);
    const target = person();
    const attempts: [string, string, unknown?][] = [
      ["POST", "/admin/roles/requests", { action: "grant", person_id: target.id, role: "admin", reason: "try it" }],
      ["POST", "/admin/mfa/enrol"], ["GET", "/admin/roles"], ["POST", "/admin/roles/requests/x/approve", {}], ["POST", "/scope/audit/summary", {}], ["DELETE", "/scope/me"],
    ];
    for (const [m, p, b] of attempts) {
      const r = await call(e.token, p, m, b);
      expect([403, 405], `${m} ${p}`).toContain(r.status);
    }
    expect((await call(e.token, "/scope/issues/summary")).status).toBe(403);
  });

  it("@E2E-49 every aggregate read by a role is a logged privileged read, and the chain still verifies", async () => {
    const p = person("politician", "DEMO-C-TNL"), e = person("eci_liaison");
    await call(p.token, "/scope/issues/summary");
    await call(e.token, "/scope/audit/summary");
    const reads = auditRows("read.sensitive");
    expect(reads.some((r) => r.actor === p.id && r.object.startsWith("scope:issues_summary"))).toBe(true);
    expect(reads.some((r) => r.actor === e.id && r.object === "scope:audit_summary")).toBe(true);
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("@E2E-49 /scope/me describes the caller's scope and dashboards", async () => {
    const p = person("politician", "DEMO-C-TNL");
    const me = await call(p.token, "/scope/me");
    expect(me.json.roles[0]).toMatchObject({ role: "politician", jurisdiction: "DEMO-C-TNL", scope: "unit", unit: { name_en: "Tenali" } });
    expect(me.json).toMatchObject({ read_only: true, early_access: false, individual_data: false, can: { issues_summary: true, audit_summary: false, export: false } });
  });
});

describe("who-sees-what matrix (docs/ROLES.md)", () => {
  it("@E2E-49 every cell of the documented matrix matches the routes", async () => {
    const md = fs.readFileSync(path.resolve(process.cwd(), "docs/ROLES.md"), "utf8");
    const block = /<!-- matrix:start -->([\s\S]*?)<!-- matrix:end -->/.exec(md)?.[1] ?? "";
    const lines = block.trim().split("\n").map((l) => l.split("|").slice(1, -1).map((c) => c.trim())).filter((r) => r.length > 1 && !/^-+$/.test(r[0]));
    const [head, ...rows] = lines;
    expect(head.slice(1)).toEqual(["me", "issues_summary", "surveys_summary", "audit_summary", "export"]);
    expect(rows.map((r) => r[0])).toEqual(["citizen", "politician", "officer", "journalist", "eci_liaison", "admin"]);
    const PATHS: Record<string, string> = { me: "/scope/me", issues_summary: "/scope/issues/summary", surveys_summary: "/scope/surveys/summary", audit_summary: "/scope/audit/summary", export: "/scope/export" };
    for (const row of rows) {
      const role = row[0];
      const who = role === "citizen" ? person() : role === "politician" ? person("politician", "DEMO-C-TNL") : role === "officer" ? person("officer", "DEMO-D-GNT", "Rural Water Supply") : person(role as RoleName);
      for (let i = 1; i < head.length; i++) {
        resetExportRate();
        const want = row[i];
        expect(["yes", "scoped", "no"]).toContain(want);
        const r = await call(who.token, PATHS[head[i]]);
        expect(r.status === 200, `${role} ${head[i]} -> ${r.status}`).toBe(want !== "no");
        if (want === "scoped") expect((await call(who.token, PATHS[head[i]] + "?unit=DEMO-C-WGE")).status, `${role} ${head[i]} outside`).toBe(403);
      }
    }
  });
});
