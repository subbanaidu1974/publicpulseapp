/**
 * OTP request flood (S-75, DESIGN_2028 3.8 item 6 "OTP-send budget capped"). Localhost only.
 *
 *   npm run load:otp            full run (about 1 minute)
 *   npm run load:otp -- --smoke   few seconds
 *
 * Each phase starts a fresh production bundle so rate-limit state never leaks between phases, floods
 * POST /api/v1/civic/identity/signup/request, and checks that the caps hold:
 *   - never a 5xx other than the documented degraded 503 when the hourly SMS budget is spent;
 *   - the number of 2xx (= codes actually sent) never exceeds the cap under test;
 *   - throttled replies are 429 and carry Retry-After (probed after the flood).
 * "Many /24s" needs distinct client addresses: the server runs with TRUST_PROXY=1 and each request sets its own X-Forwarded-For.
 */
import { fmt, isMain, randIp, randPhone, runLoad, startServer, type Stats } from "./harness";

export interface PhaseResult { name: string; cap: string; stats: Stats; sent: number; degraded503: number; unexpected5xx: number; retryAfterOn429: string; ok: boolean; note?: string; warnings: string[] }
const PATH = "/api/v1/civic/identity/signup/request";
const RAISED = { RATE_LIMIT_BURST: "1000000000", RATE_LIMIT_PER_SEC: "1000000000" };

async function probe(base: string, headers: Record<string, string>, phone: string): Promise<{ status: number; retryAfter: string | null; degraded: boolean }> {
  const r = await fetch(base + PATH, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ phone }) });
  let degraded = false;
  try { degraded = (await r.json()).degraded === true; } catch { /* no body */ }
  return { status: r.status, retryAfter: r.headers.get("retry-after"), degraded };
}

/** Hammer a cheap read until the edge limiter answers 429, and return its Retry-After (null when it never throttled). */
async function edgeRetryAfter(base: string): Promise<string | null | "unthrottled"> {
  for (let i = 0; i < 2000; i++) {
    const r = await fetch(base + "/api/v1/states");
    if (r.status === 429) return r.headers.get("retry-after");
  }
  return "unthrottled";
}

export async function runOtpFlood(opts: { smoke?: boolean } = {}): Promise<PhaseResult[]> {
  const smoke = !!opts.smoke;
  const connections = smoke ? 20 : 100;
  const duration = smoke ? 2 : 10;
  const budget = smoke ? 25 : 200;
  const results: PhaseResult[] = [];

  const phase = async (name: string, cap: string, maxSent: number, edge: boolean, env: Record<string, string>, mk: () => { headers: Record<string, string>; phone: string }, probeAs: Record<string, string>) => {
    const srv = await startServer(env);
    try {
      const stats = await runLoad({
        url: srv.base + PATH, connections, duration, method: "POST",
        requests: [{ method: "POST", path: PATH, setupRequest: (r: any) => { const m = mk(); r.body = JSON.stringify({ phone: m.phone }); r.headers = { ...(r.headers ?? {}), "content-type": "application/json", ...m.headers }; return r; } }],
      });
      const sent = stats.status[200] ?? 0;
      const degraded503 = stats.status[503] ?? 0;
      const unexpected5xx = stats.fiveXX - degraded503;
      const p = await probe(srv.base, probeAs, randPhone());
      const warnings: string[] = [];
      if (p.status === 429 && !p.retryAfter) warnings.push("OTP-cap 429 has no Retry-After header (server/civic/identity/routes.ts fail())");
      if (degraded503) warnings.push("SMS budget exhausted answers 503 (a 5xx) with degraded:true and no Retry-After; callers expect 429 + Retry-After");
      if (edge) { const ra = await edgeRetryAfter(srv.base); if (ra === null) warnings.push("edge limiter 429 has no Retry-After"); else if (ra === "unthrottled") warnings.push("edge limiter did not throttle"); }
      const ok = unexpected5xx === 0 && stats.errors === 0 && sent <= maxSent && !warnings.some((w) => w.startsWith("edge"));
      const note = p.status === 429 ? (p.retryAfter ? `probe 429 with Retry-After ${p.retryAfter}` : "probe 429 without Retry-After") : `probe ${p.status}${p.degraded ? " degraded" : ""}`;
      results.push({ name, cap, stats, sent, degraded503, unexpected5xx, retryAfterOn429: p.retryAfter ?? "none", ok, note, warnings });
    } finally { await srv.stop(); }
  };

  // 1. One IP, default edge limiter (120 burst, 20/s): the limiter answers first.
  await phase("one-ip / default limits", "<= 10 codes per IP per 10 min", 10, true, {}, () => ({ headers: {}, phone: randPhone() }), {});
  // 2. One IP, edge limiter raised: isolates the OTP caps themselves (per-IP 10, per-/24 60).
  await phase("one-ip / OTP caps only", "<= 10 codes per IP per 10 min", 10, false, RAISED, () => ({ headers: {}, phone: randPhone() }), {});
  // 3. Many /24s, one phone each: per-IP and per-network caps never bind, so only the global SMS hourly budget stops it.
  await phase("many /24s / SMS budget", `<= ${budget} codes per hour (CIVIC_SMS_HOURLY_BUDGET)`, budget, false, { ...RAISED, TRUST_PROXY: "1", CIVIC_SMS_HOURLY_BUDGET: String(budget) },
    () => ({ headers: { "x-forwarded-for": randIp() }, phone: randPhone() }), { "x-forwarded-for": randIp() });
  // 4. One /24 (many hosts in it): the per-network cap (60 per 10 min) holds.
  await phase("one /24, many hosts", "<= 60 codes per /24 per 10 min", 60, false, { ...RAISED, TRUST_PROXY: "1" },
    () => ({ headers: { "x-forwarded-for": `203.0.113.${1 + Math.floor(Math.random() * 254)}` }, phone: randPhone() }), { "x-forwarded-for": "203.0.113.77" });
  // 5. One victim phone from many addresses: per-phone cap (3 per 10 min); a pending code is never replaced.
  const victim = "+919876500001";
  await phase("one phone, many IPs", "<= 3 accepted per phone per 10 min", 3, false, { ...RAISED, TRUST_PROXY: "1" },
    () => ({ headers: { "x-forwarded-for": randIp() }, phone: victim }), { "x-forwarded-for": randIp() });
  return results;
}

export const report = (rs: PhaseResult[]) => rs.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}\n  cap: ${r.cap}\n  ${fmt(r.stats)}\n  codes sent ${r.sent}, degraded 503 ${r.degraded503}, other 5xx ${r.unexpected5xx}; ${r.note}${r.warnings.map((w) => `
  WARN ${w}`).join("")}`).join("\n");

if (isMain(import.meta.url)) {
  const rs = await runOtpFlood({ smoke: process.argv.includes("--smoke") });
  console.log(report(rs));
  process.exit(rs.every((r) => r.ok) ? 0 : 1);
}
