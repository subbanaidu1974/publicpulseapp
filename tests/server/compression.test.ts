import { describe, it, expect } from "vitest";
import express from "express";
import { gunzipSync } from "node:zlib";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { compression } from "../../server/security";

const BIG = "console.log('x');\n".repeat(400);

async function get(app: express.Express, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const srv = app.listen(0);
  try {
    const port = (srv.address() as AddressInfo).port;
    return await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path, headers: { "accept-encoding": "gzip" } }, (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }));
      }).on("error", reject);
    });
  } finally { srv.close(); }
}

describe("UT-compression", () => {
  it("@E2E-69 gzips a response whose headers are set in one writeHead() call (static file servers), without dropping the connection", async () => {
    const app = express();
    app.use(compression());
    app.get("/sw.js", (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/javascript", "Content-Length": Buffer.byteLength(BIG) });
      res.end(BIG);
    });
    const r = await get(app, "/sw.js");
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(r.headers["content-length"]).toBeUndefined();
    expect(gunzipSync(r.body).toString()).toBe(BIG);
  });

  it("@E2E-69 gzips streamed writes and leaves small or non-text bodies alone", async () => {
    const app = express();
    app.use(compression());
    app.get("/big.json", (_req, res) => { res.type("json").send(JSON.stringify({ a: BIG })); });
    app.get("/small.js", (_req, res) => { res.writeHead(200, { "Content-Type": "text/javascript", "Content-Length": 5 }); res.end("hello"); });
    app.get("/img.png", (_req, res) => { res.writeHead(200, { "Content-Type": "image/png" }); res.end(Buffer.alloc(5000)); });
    const big = await get(app, "/big.json");
    expect(big.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(big.body).toString()).a).toBe(BIG);
    const small = await get(app, "/small.js");
    expect(small.headers["content-encoding"]).toBeUndefined();
    expect(small.body.toString()).toBe("hello");
    const img = await get(app, "/img.png");
    expect(img.headers["content-encoding"]).toBeUndefined();
    expect(img.body.length).toBe(5000);
  });
});
