/**
 * Writes the publishable static tree (multi-origin ready) and a signed manifest.
 *   tsx scripts/countday-publish.ts --out <dir> [--src data/generated/countday]
 * Then upload <dir> UNCHANGED to every origin (CDN bucket, second cloud, university mirror). Numbered snapshots are immutable (cache one year);
 * latest.json, index.json and ac/*.json should get a short TTL (5 s). review/ is never copied. Verify any mirror with scripts/countday-verify.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { canonical, sha256Hex } from "../pipeline/countday/canonical";
import { signerFromKeys } from "../server/countday/signer";
import { countDir } from "../server/countday/router";

const arg = (n: string, d?: string) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; };
const src = arg("src") ?? countDir(), out = arg("out");
if (!out) { console.error("usage: countday-publish --out <dir> [--src <dir>]"); process.exit(1); }
const files: { path: string; sha256: string; bytes: number }[] = [];
const walk = (rel: string) => {
  for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name === "review") continue; walk(r); }
    else if (/\.json$/.test(e.name) && e.name !== "manifest.json") {
      const buf = fs.readFileSync(path.join(src, r));
      fs.mkdirSync(path.dirname(path.join(out, r)), { recursive: true }); fs.writeFileSync(path.join(out, r), buf);
      files.push({ path: r, sha256: sha256Hex(buf), bytes: buf.length });
    }
  }
};
walk("");
files.sort((a, b) => a.path.localeCompare(b.path));
const signer = signerFromKeys();
const body = { schema: 1, kind: "countday-manifest", generatedAt: new Date().toISOString(), files };
const sha = sha256Hex(canonical(body));
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ body, sha256: sha, signature: { alg: "ed25519", keyId: signer.keyId, value: signer.sign(Buffer.from(sha, "utf8")) } }, null, 2));
console.log(`published ${files.length} files to ${path.resolve(out)} (manifest signed by ${signer.keyId})`);
