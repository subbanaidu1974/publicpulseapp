import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createApiRouter, loadDatasets } from "./server/api";
import { createCivicRouter } from "./server/civic";
import { basemapRouter } from "./server/basemap";
import { buildApiApp } from "./server/security";
import { installConsole, log, obsRouter, requestContext } from "./server/obs";
import { migrationStatus, pingStores } from "./server/civic/core";
import { demoProvenance } from "./server/civic/guards";
import { jobsStatus } from "./server/civic/jobs";

dotenv.config();
installConsole(); // structured, redacted JSON logs for every console.* call (S-67)

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;
  // SERVE_BUILT=1 serves dist/ without Vite even when NODE_ENV is not "production" (smoke-testing the built bundle, see e2e/ops.spec.ts).
  const dev = process.env.NODE_ENV !== "production" && process.env.SERVE_BUILT !== "1";

  // Civic router is mounted before any global body parser inside buildApiApp (S-57).
  const api = buildApiApp({
    dev,
    apiRouter: createApiRouter(loadDatasets()),
    civicRouter: createCivicRouter(),
  });

  // Outer app: request ids + access log + metrics for everything, and /healthz /readyz /metrics (S-67).
  const app = express();
  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  app.use(requestContext());
  app.use(obsRouter({
    dbPing: () => { pingStores(); },
    migrations: migrationStatus,
    jobs: jobsStatus,
    demoProvenance,
  }));
  app.use(basemapRouter()); // S-191: self-hosted OpenStreetMap map background (404 when the file is not installed); before the API edge limiter, a map makes many small range requests
  app.use(api);

  // Vite Server Middleware Routing
  if (dev) {
    log.info("[Dev Server] Mounting Vite development middleware layers...");
    const { createServer: createViteServer } = await import("vite"); // dev only: vite is not needed (or installed) in production images
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    // /lite is its own page (S-75): never the SPA shell.
    app.get(["/lite", "/lite/"], async (req, res, next) => {
      try {
        const raw = await (await import("fs")).promises.readFile(path.join(process.cwd(), "lite.html"), "utf8");
        res.status(200).type("html").send(await vite.transformIndexHtml(req.originalUrl, raw));
      } catch (e) { next(e); }
    });
    app.use(vite.middlewares);
  } else {
    log.info("[Prod Server] Serving production static asset bundles...");
    const distPath = path.join(process.cwd(), "dist");
    app.get(["/lite", "/lite/"], (_req, res) => { res.setHeader("Cache-Control", "no-cache"); res.sendFile(path.join(distPath, "lite.html")); });
    // hashed build assets never change: cache them hard; everything else revalidates
    app.use("/assets", express.static(path.join(distPath, "assets"), { immutable: true, maxAge: "1y" }));
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    log.info(`Server fully operational on http://localhost:${PORT}`, { port: PORT, mode: dev ? "dev" : "production-bundle" });
  });
}

startServer().catch((error) => {
  log.error("Critical server bootstrap error", { error });
  process.exit(1);
});
