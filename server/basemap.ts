/**
 * Self-hosted map background (S-191). Serves ONE fixed file, the Protomaps/OpenStreetMap vector tile archive for Andhra Pradesh and Telangana
 * (PMTiles), from this server, so no third-party map provider is ever contacted. The file is large and re-fetchable, so it is not in git:
 * see docs/BASEMAP.md. Without the file the route answers 404 and the maps draw plain boundary shapes (the app never depends on it).
 * Express's sendFile handles HTTP Range requests, which is how a PMTiles reader fetches only the tiles it needs.
 */
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";

export const BASEMAP_NAME = "ap-tg.pmtiles";
export const basemapFile = (): string => path.resolve(process.env.BASEMAP_FILE || path.join(process.cwd(), "data", "basemap", BASEMAP_NAME));

export function basemapRouter(): Router {
  const r = Router();
  // Only this exact name is served: there is no path parameter, so nothing outside the one file can be reached.
  r.get(`/basemap/${BASEMAP_NAME}`, (req, res) => {
    const file = basemapFile();
    if (!fs.existsSync(file)) { res.status(404).json({ error: "basemap_not_installed" }); return; }
    res.set({ "Cache-Control": "public, max-age=86400", "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" });
    res.sendFile(file, { acceptRanges: true, cacheControl: false, headers: {} }, (err) => { if (err && !res.headersSent) res.status(500).json({ error: "basemap_read_failed" }); });
  });
  return r;
}
