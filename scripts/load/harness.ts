/**
 * Shared helpers for the load scripts (S-75): start the production bundle on a free local port with a throwaway database,
 * drive it with autocannon, and compute exact percentiles. Localhost only: this refuses to run against anything else.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import autocannon from "autocannon";

export const ROOT = process.cwd();

export interface Started { base: string; port: number; stop: () => Promise<void>; mode: "built" | "dev"; log: () => string }

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

/** Refuse to flood anything that is not this machine. */
export function assertLocal(url: string): void {
  const h = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(h)) throw new Error(`load scripts only run against localhost, not ${h}`);
}

/**
 * Start `node dist/server.cjs` (the production bundle, SERVE_BUILT=1) on a free port with CIVIC_DB in a temp dir.
 * Falls back to `tsx server.ts` when dist/ has not been built. `env` overrides win (RATE_LIMIT_*, CIVIC_SMS_HOURLY_BUDGET, TRUST_PROXY ...).
 */
export async function startServer(env: Record<string, string> = {}): Promise<Started> {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-load-"));
  const built = fs.existsSync(path.join(ROOT, "dist", "server.cjs"));
  const args = built ? ["dist/server.cjs"] : ["--import", "tsx", "server.ts"];
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, SERVE_BUILT: "1", PORT: String(port), CIVIC_DB: path.join(dir, "civic.db"), CIVIC_EXPOSE_DEV_OTP: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const keep = (b: Buffer) => { out = (out + b.toString()).slice(-20_000); };
  child.stdout!.on("data", keep); child.stderr!.on("data", keep);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("server exited early:\n" + out);
    try { if ((await fetch(base + "/healthz")).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error("server did not start:\n" + out); }
    await new Promise((r) => setTimeout(r, 200));
  }
  const stop = async () => {
    if (child.exitCode === null) { child.kill(); await new Promise((r) => { child.once("exit", r); setTimeout(r, 3000); }); }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
  };
  return { base, port, stop, mode: built ? "built" : "dev", log: () => out };
}

export interface Stats {
  requests: number; rps: number; p50: number; p95: number; p99: number; max: number;
  status: Record<string, number>; errorKinds: Record<string, number>; errors: number; timeouts: number; non2xx: number; fiveXX: number; seconds: number;
}

const pct = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : 0);

export type Req = { method?: string; path?: string; headers?: Record<string, string>; body?: string; setupRequest?: (r: any, ctx: any) => any };

export function runLoad(o: { url: string; connections: number; duration: number; requests?: Req[]; headers?: Record<string, string>; method?: string; body?: string; timeout?: number }): Promise<Stats> {
  assertLocal(o.url);
  const lat: number[] = [];
  const status: Record<string, number> = {};
  const errorKinds: Record<string, number> = {};
  return new Promise((resolve, reject) => {
    const inst = autocannon({
      url: o.url, connections: o.connections, duration: o.duration, timeout: o.timeout ?? 20,
      method: (o.method ?? "GET") as "GET", body: o.body, headers: o.headers, requests: o.requests as any,
    }, (err, res) => {
      if (err) return reject(err);
      const sorted = lat.sort((a, b) => a - b);
      const non2xx = Object.entries(status).filter(([k]) => !k.startsWith("2")).reduce((n, [, v]) => n + v, 0);
      const fiveXX = Object.entries(status).filter(([k]) => k.startsWith("5")).reduce((n, [, v]) => n + v, 0);
      resolve({
        requests: sorted.length, rps: Math.round(sorted.length / Math.max(1, res.duration)), p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), p99: pct(sorted, 0.99), max: sorted[sorted.length - 1] ?? 0,
        status, errorKinds, errors: res.errors, timeouts: res.timeouts, non2xx, fiveXX, seconds: res.duration,
      });
    });
    inst.on("reqError", (e: Error) => { const k = (e as NodeJS.ErrnoException).code ?? e.message; errorKinds[k] = (errorKinds[k] ?? 0) + 1; });
    inst.on("response", (_c: unknown, code: number, _bytes: number, ms: number) => { lat.push(ms); status[code] = (status[code] ?? 0) + 1; });
  });
}

export const fmt = (s: Stats) =>
  `${s.requests} req in ${s.seconds}s (${s.rps}/s)  p50 ${s.p50} ms  p95 ${s.p95} ms  p99 ${s.p99} ms  max ${s.max} ms  status ${JSON.stringify(s.status)}  errors ${s.errors}${s.errors ? " " + JSON.stringify(s.errorKinds) : ""}  timeouts ${s.timeouts}`;

/** True when the module is the entry script (tsx scripts/load/x.ts), false when imported by a test. */
export const isMain = (metaUrl: string) => !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(metaUrl));

export const randPhone = () => "+91" + (6 + Math.floor(Math.random() * 4)) + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
export const randIp = () => `${1 + Math.floor(Math.random() * 223)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
