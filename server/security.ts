import express from "express";
import type { Express, NextFunction, Request, RequestHandler, Response, Router } from "express";
import { log } from "./obs";
import crypto from "crypto";
import zlib from "zlib";

/* ---------------- security headers (S-54) ---------------- */

export function buildCsp(dev: boolean): string {
  const d: Record<string, string[]> = {
    "default-src": ["'self'"],
    // Dev only: vite injects an inline react-refresh preamble and uses eval-free HMR over ws.
    "script-src": dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    // React inline style attributes and Leaflet positioning need inline styles.
    "style-src": ["'self'", "'unsafe-inline'"],
    "font-src": ["'self'", "data:"],
    "img-src": ["'self'", "data:", "blob:", "https://server.arcgisonline.com"],
    "media-src": ["'self'", "blob:"],
    "connect-src": dev ? ["'self'", "ws:", "wss:"] : ["'self'"],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(d).map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

export function securityHeaders(opts: { dev: boolean; hsts?: boolean }): RequestHandler {
  const csp = buildCsp(opts.dev);
  return (req, res, next) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    // Geolocation is deliberately not requested by this app.
    res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()");
    res.removeHeader("X-Powered-By");
    const behindHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
    if (opts.hsts !== false && behindHttps) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}

/* ---------------- CORS: same-origin default, env allowlist ---------------- */

export function corsPolicy(allowlist: string[]): RequestHandler {
  const allowed = new Set(allowlist.map(s => s.trim()).filter(Boolean));
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
      res.setHeader("Access-Control-Max-Age", "600");
      if (req.method === "OPTIONS") return void res.status(204).end();
    } else if (req.method === "OPTIONS" && typeof origin === "string") {
      return void res.status(403).end();
    }
    next();
  };
}

/* ---------------- compression (gzip, no extra dependency) ---------------- */

export function compression(minBytes = 1024): RequestHandler {
  return (req, res, next) => {
    const accept = String(req.headers["accept-encoding"] || "");
    if (!/\bgzip\b/.test(accept) || req.method === "HEAD") return next();
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    let gz: zlib.Gzip | null = null;
    let decided = false;
    const decide = (chunk?: unknown) => {
      decided = true;
      const type = String(res.getHeader("Content-Type") || "");
      const compressible = /json|text|javascript|xml|svg/.test(type);
      const len = Number(res.getHeader("Content-Length") || (Buffer.isBuffer(chunk) || typeof chunk === "string" ? Buffer.byteLength(chunk as string) : 0));
      if (!compressible || res.getHeader("Content-Encoding") || res.statusCode === 204 || res.statusCode === 304 || (len && len < minBytes)) return;
      gz = zlib.createGzip();
      res.setHeader("Content-Encoding", "gzip");
      res.removeHeader("Content-Length");
      res.vary("Accept-Encoding");
      gz.on("data", (c: Buffer) => origWrite(c));
      gz.on("end", () => origEnd());
    };
    // Static-file servers (sirv/send) set status and headers in one writeHead() call before any write: move those headers onto the
    // response first so the decision can see them and so setting Content-Encoding afterwards does not hit "headers already sent".
    const origWriteHead = res.writeHead.bind(res) as (...a: unknown[]) => typeof res;
    res.writeHead = ((status: number, a?: unknown, b?: unknown) => {
      const hdrs = (typeof a === "object" && a !== null ? a : b) as Record<string, string | number | string[]> | unknown[] | undefined;
      if (!decided && hdrs && !Array.isArray(hdrs)) {
        for (const [k, v] of Object.entries(hdrs)) if (v !== undefined) res.setHeader(k, v as string);
        res.statusCode = status;
        decide();
        return origWriteHead(status);
      }
      return origWriteHead(status, a, b);
    }) as typeof res.writeHead;
    res.write = ((chunk: unknown, ...args: unknown[]) => {
      if (!decided) decide(chunk);
      return gz ? gz.write(chunk as Buffer) : (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
    }) as typeof res.write;
    res.end = ((chunk?: unknown, ...args: unknown[]) => {
      if (!decided) decide(chunk);
      if (gz) { if (chunk) gz.write(chunk as Buffer); gz.end(); return res; }
      return (origEnd as (...a: unknown[]) => Response)(chunk, ...args);
    }) as typeof res.end;
    next();
  };
}

/* ---------------- public API rate limiter: in-memory token bucket per IP ---------------- */

export interface RateLimitOptions {
  burst: number;
  perSecond: number;
  /** request paths (relative to the mount) that bypass the limiter */
  skip?: (req: Request) => boolean;
  now?: () => number;
}

export function rateLimiter(opts: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const now = opts.now ?? Date.now;
  let lastSweep = now();
  return (req, res, next) => {
    if (opts.skip?.(req)) return next();
    const t = now();
    if (t - lastSweep > 60_000) {
      lastSweep = t;
      for (const [k, b] of buckets) if (t - b.at > 120_000) buckets.delete(k);
    }
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const b = buckets.get(key) ?? { tokens: opts.burst, at: t };
    b.tokens = Math.min(opts.burst, b.tokens + ((t - b.at) / 1000) * opts.perSecond);
    b.at = t;
    if (b.tokens < 1) {
      buckets.set(key, b);
      const wait = Math.max(1, Math.ceil((1 - b.tokens) / opts.perSecond));
      res.setHeader("Retry-After", String(wait));
      return void res.status(429).json({ error: "rate_limited", retryAfterSeconds: wait });
    }
    b.tokens -= 1;
    buckets.set(key, b);
    next();
  };
}

/* ---------------- Cache-Control + ETag for read-only GETs ---------------- */

export function readCache(maxAgeSeconds = 60): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET") return next();
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode === 200) {
        if (!res.getHeader("Cache-Control")) res.setHeader("Cache-Control", `public, max-age=${maxAgeSeconds}`);
        if (res.getHeader("Cache-Control") !== "no-store") {
          const etag = `"${crypto.createHash("sha1").update(JSON.stringify(body)).digest("base64url")}"`;
          res.setHeader("ETag", etag);
          if (req.headers["if-none-match"] === etag) return res.status(304).end();
        }
      }
      return json(body);
    }) as typeof res.json;
    next();
  };
}

/* ---------------- app assembly ---------------- */

export interface BuildOptions {
  dev: boolean;
  apiRouter: Router;
  civicRouter?: Router;
  env?: NodeJS.ProcessEnv;
  rateLimit?: { burst: number; perSecond: number };
}

/**
 * Everything except the vite / static layer. Order matters (S-57): the civic router is mounted BEFORE any
 * global body parser so its own per-router limits decide; the small global parser only covers what follows.
 */
export function buildApiApp(opts: BuildOptions): Express {
  const env = opts.env ?? process.env;
  const app = express();
  app.disable("x-powered-by");
  const tp = env.TRUST_PROXY;
  if (tp) app.set("trust proxy", /^\d+$/.test(tp) ? Number(tp) : tp === "true" ? true : tp);

  app.use(securityHeaders({ dev: opts.dev }));
  app.use(corsPolicy((env.CORS_ORIGINS || "").split(",")));
  app.use(compression());

  const limiter = rateLimiter({
    burst: opts.rateLimit?.burst ?? (Number(env.RATE_LIMIT_BURST) || 120),
    perSecond: opts.rateLimit?.perSecond ?? (Number(env.RATE_LIMIT_PER_SEC) || 20),
    skip: req => req.path === "/health",
  });
  app.use("/api/v1", limiter);

  // 1. civic first: owns its parsers and limits
  if (opts.civicRouter) app.use("/api/v1/civic", opts.civicRouter);
  // 2. small global parser for everything else
  app.use(express.json({ limit: "16kb" }));
  // 3. read-only public API with cache headers
  app.use("/api/v1", readCache(60), opts.apiRouter);

  // Removed endpoints answer with a plain 404 (S-51, S-52)
  app.all(["/api/admin", "/api/admin/*", "/api/send-otp"], (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Red-team finding (internal self-assessment): a malformed or oversized body made the body parser fall through to express' default
  // error page, which prints the stack trace and absolute file paths outside production. Answer with JSON and no internals instead.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { status?: number; statusCode?: number; type?: string };
    const status = Number.isInteger(e?.status ?? e?.statusCode) && (e.status ?? e.statusCode)! >= 400 && (e.status ?? e.statusCode)! < 600 ? (e.status ?? e.statusCode)! : 500;
    const code = status === 413 ? "payload_too_large" : e?.type === "entity.parse.failed" ? "bad_json" : status < 500 ? "bad_request" : "internal_error";
    if (status >= 500) log.error("unhandled api error", { message: err instanceof Error ? err.message : "unknown" });
    res.status(status).json({ error: code });
  });
  return app;
}

