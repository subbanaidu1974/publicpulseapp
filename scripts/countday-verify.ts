/**
 * Verify a count-day mirror: signatures, hash chain, per-seat files, optional manifest. No private key needed.
 *   tsx scripts/countday-verify.ts <dir|https://mirror/base> [more mirrors...] [--state AP,TG] [--pin cd-xxxx,...]
 * Several mirrors are also compared for rollback (a lower head) and forks (same seq, different hash). Exit 1 on any problem.
 */
import { compareMirrors, dirReader, httpReader, verifyState } from "../pipeline/countday/verify";
import { canonical, sha256Hex, verifyEd25519 } from "../pipeline/countday/canonical";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
const mirrors = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!mirrors.length) { console.error("usage: countday-verify <dir|url> [...] [--state AP,TG] [--pin keyId,...]"); process.exit(1); }
const states = (opt("state") ?? "AP,TG").split(","), pinned = opt("pin")?.split(",");
let bad = false;
const heads: { mirror: string; head: { seq: number; sha256: string } | null }[] = [];
for (const m of mirrors) {
  const r = /^https?:\/\//.test(m) ? httpReader(m) : dirReader(m);
  for (const st of states) {
    if (!(await r.read(`${st}/index.json`))) { console.log(`${m} ${st}: no data (skipped)`); continue; }
    const v = await verifyState(r, st, { pinnedKeyIds: pinned });
    console.log(`${m} ${st}: ${v.ok ? "OK" : "FAIL"} head=${v.head?.seq ?? "-"} snapshots=${v.snapshots} ac=${v.acFiles}`);
    v.problems.forEach((p) => console.log("  - " + p));
    if (!v.ok) bad = true;
    if (st === states[0]) heads.push({ mirror: m, head: v.head });
  }
  const mt = await r.read("manifest.json");
  if (mt) {
    const mf = JSON.parse(mt), keys = JSON.parse((await r.read("keys.json")) ?? "{}").keys ?? [];
    const x = keys.find((k: { keyId: string }) => k.keyId === mf.signature?.keyId)?.x;
    const okSig = sha256Hex(canonical(mf.body)) === mf.sha256 && !!x && verifyEd25519(x, Buffer.from(mf.sha256, "utf8"), mf.signature.value);
    let files = 0;
    for (const f of mf.body.files) { const t = await r.read(f.path); if (t === null || sha256Hex(Buffer.from(t, "utf8")) !== f.sha256) { console.log(`  - manifest: ${f.path} missing or altered`); bad = true; } else files++; }
    console.log(`${m} manifest: ${okSig ? "signature OK" : "SIGNATURE BAD"}, ${files}/${mf.body.files.length} files match`);
    if (!okSig) bad = true;
  }
}
if (heads.length > 1) for (const p of compareMirrors(heads)) { console.log("MIRROR: " + p); bad = true; }
process.exit(bad ? 1 : 0);
