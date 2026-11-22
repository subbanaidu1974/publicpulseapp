import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

describe("UT-docker Dockerfile and compose basics (Docker itself is not required)", () => {
  const df = read("Dockerfile");
  const lines = df.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));

  it("@E2E-84 is multi-stage, on a node image that satisfies package.json engines", () => {
    const froms = lines.filter((l) => /^FROM\s/i.test(l));
    expect(froms.length).toBeGreaterThanOrEqual(3);
    const min = /(\d+)\.(\d+)/.exec(JSON.parse(read("package.json")).engines.node)!;
    for (const f of froms) {
      const major = Number(/node:(\d+)/.exec(f)?.[1]);
      expect(major, f).toBeGreaterThanOrEqual(Number(min[1]));
      expect(f).toMatch(/slim/);
    }
    expect(df).toMatch(/npm ci --omit=dev/);
    expect(df).toMatch(/npm run build/);
  });

  it("@E2E-84 runs as a non-root user, exposes a healthcheck on /healthz and starts the built server", () => {
    const user = lines.filter((l) => /^USER\s/i.test(l)).pop() ?? "";
    expect(user).toMatch(/USER\s+(node|\d+)/i);
    expect(user).not.toMatch(/root|\b0\b/);
    expect(df).toMatch(/HEALTHCHECK[\s\S]*\/healthz/);
    expect(lines.some((l) => /^CMD\s.*dist\/server\.cjs/.test(l))).toBe(true);
    expect(df).toMatch(/NODE_ENV=production/);
  });

  it("@E2E-84 keeps all state (DB, media, anchors, backups) under one declared volume", () => {
    expect(df).toMatch(/VOLUME\s+\["\/var\/lib\/pulse"\]/);
    for (const v of ["CIVIC_DB", "CIVIC_MEDIA_DIR", "CIVIC_AUDIT_ANCHOR_FILE", "CIVIC_BACKUP_DIR"]) expect(df).toMatch(new RegExp(`${v}=/var/lib/pulse/`));
  });

  it("@E2E-84 .dockerignore keeps secrets and local state out of the image; compose wires env file, volume, healthcheck", () => {
    const di = read(".dockerignore");
    for (const p of [".env", "node_modules", "data/civic*.db", "data/civic-media", ".git"]) expect(di).toContain(p);
    const dc = read("docker-compose.yml");
    expect(dc).toMatch(/env_file:/);
    expect(dc).toMatch(/pulse-data:\/var\/lib\/pulse/);
    expect(dc).toMatch(/healthz/);
    expect(dc).toMatch(/NODE_ENV: production/);
    expect(dc).toMatch(/TRUST_PROXY/);
  });

  it("@E2E-84 the documented deployment guide exists and names the production guards and TRUST_PROXY", () => {
    const d = read("docs/DEPLOYMENT.md");
    for (const w of ["TRUST_PROXY", "CIVIC_BACKUP_KEY", "assertProductionSafe", "India", "TLS", "/readyz"]) expect(d, w).toContain(w);
  });
});
