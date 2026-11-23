/** Mirror-independent verification of a count-day static tree (directory or HTTP base). No server code, no key access: public keys only. */
import fs from "node:fs";
import path from "node:path";
import { canonical, sha256Hex, verifyEd25519 } from "./canonical";
import type { AcBody, Envelope, IndexFile, KeysFile, SnapshotBody } from "./types";

export interface Reader { name: string; read(rel: string): Promise<string | null> }
export const dirReader = (root: string): Reader => ({ name: root, read: async (rel) => { try { return fs.readFileSync(path.join(root, rel), "utf8"); } catch { return null; } } });
export const httpReader = (base: string, fetchImpl: typeof fetch = fetch): Reader => ({
  name: base,
  read: async (rel) => { try { const r = await fetchImpl(base.replace(/\/$/, "") + "/" + rel); return r.ok ? await r.text() : null; } catch { return null; } },
});

export interface VerifyResult { ok: boolean; state: string; head: { seq: number; sha256: string } | null; snapshots: number; acFiles: number; problems: string[] }

function envOk(env: Envelope<unknown> | null, keys: Map<string, string>, pinned: string[] | null, what: string, problems: string[]): boolean {
  if (!env || typeof env !== "object" || !env.signature) { problems.push(`${what}: missing or malformed`); return false; }
  const sha = sha256Hex(canonical(env.body));
  if (sha !== env.sha256) { problems.push(`${what}: sha256 does not match the body`); return false; }
  if (pinned && !pinned.includes(env.signature.keyId)) { problems.push(`${what}: signed by unpinned key ${env.signature.keyId}`); return false; }
  const x = keys.get(env.signature.keyId);
  if (!x) { problems.push(`${what}: unknown key ${env.signature.keyId}`); return false; }
  if (!verifyEd25519(x, Buffer.from(sha, "utf8"), env.signature.value)) { problems.push(`${what}: bad signature`); return false; }
  return true;
}

/** `pinnedKeyIds`: key ids the verifier trusts out of band. When given, keys.json from the mirror is only used to look up the public half of a pinned id. */
export async function verifyState(r: Reader, state: string, o: { pinnedKeyIds?: string[]; minSeq?: number } = {}): Promise<VerifyResult> {
  const st = state.toUpperCase(), problems: string[] = [];
  const res = (head: VerifyResult["head"], snapshots = 0, acFiles = 0): VerifyResult => ({ ok: problems.length === 0, state: st, head, snapshots, acFiles, problems });
  const keysText = await r.read("keys.json");
  const keysFile = keysText ? (JSON.parse(keysText) as KeysFile) : null;
  const keys = new Map((keysFile?.keys ?? []).map((k) => [k.keyId, k.x]));
  if (!keys.size) { problems.push("keys.json missing or empty"); return res(null); }
  const idxText = await r.read(`${st}/index.json`);
  if (!idxText) { problems.push("index.json missing"); return res(null); }
  const index = JSON.parse(idxText) as IndexFile;
  if (!envOk(index, keys, o.pinnedKeyIds ?? null, "index", problems)) return res(null);
  const entries = index.body.entries;
  let prev: string | null = null, n = 0, acFiles = 0;
  let lastSnap: Envelope<SnapshotBody> | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i + 1) problems.push(`index: seq ${e.seq} at position ${i + 1} (gap or reorder)`);
    if (e.prevHash !== prev) problems.push(`index: entry ${e.seq} prevHash does not match the previous entry`);
    const text = await r.read(`${st}/snapshots/${e.seq}.json`);
    if (!text) { problems.push(`snapshot ${e.seq}: missing`); prev = e.sha256; continue; }
    const env = JSON.parse(text) as Envelope<SnapshotBody>;
    if (envOk(env, keys, o.pinnedKeyIds ?? null, `snapshot ${e.seq}`, problems)) {
      n++;
      if (env.sha256 !== e.sha256) problems.push(`snapshot ${e.seq}: differs from the index entry`);
      if (env.body.prevHash !== prev) problems.push(`snapshot ${e.seq}: prevHash does not chain to snapshot ${e.seq - 1}`);
      if (env.body.seq !== e.seq || env.body.state !== st) problems.push(`snapshot ${e.seq}: seq/state mismatch`);
      for (const a of env.body.acs) if (sha256Hex(canonical(a)) !== env.body.acHashes[String(a.acNo)]) problems.push(`snapshot ${e.seq}: acHashes mismatch for AC ${a.acNo}`);
      lastSnap = env;
    }
    prev = e.sha256;
  }
  const head = index.body.head;
  if (entries.length && (!head || head.seq !== entries[entries.length - 1].seq || head.sha256 !== entries[entries.length - 1].sha256)) problems.push("index: head does not match the last entry");
  if (head && o.minSeq !== undefined && head.seq < o.minSeq) problems.push(`rollback: head seq ${head.seq} is below the minimum ${o.minSeq} seen elsewhere`);
  const latestText = await r.read(`${st}/latest.json`);
  if (head) {
    const latest = latestText ? (JSON.parse(latestText) as Envelope<SnapshotBody>) : null;
    if (!latest || latest.sha256 !== head.sha256) problems.push("latest.json does not equal the index head");
  }
  if (lastSnap) {
    for (const a of lastSnap.body.acs) {
      const t = await r.read(`${st}/ac/${a.acNo}.json`);
      if (!t) { problems.push(`ac ${a.acNo}: file missing`); continue; }
      const env = JSON.parse(t) as Envelope<AcBody>;
      if (!envOk(env, keys, o.pinnedKeyIds ?? null, `ac ${a.acNo}`, problems)) continue;
      acFiles++;
      if (env.body.acSha256 !== lastSnap.body.acHashes[String(a.acNo)] || sha256Hex(canonical(env.body.ac)) !== env.body.acSha256) problems.push(`ac ${a.acNo}: does not match the latest snapshot`);
    }
  }
  return res(head, n, acFiles);
}

/** Compare heads across mirrors: same seq with different hashes is a fork; a lower seq than another mirror is a rollback or lag. */
export function compareMirrors(results: { mirror: string; head: VerifyResult["head"] }[]): string[] {
  const out: string[] = [];
  const max = Math.max(0, ...results.map((x) => x.head?.seq ?? 0));
  for (const x of results) if ((x.head?.seq ?? 0) < max) out.push(`${x.mirror}: behind (seq ${x.head?.seq ?? 0} < ${max}): rollback or lag`);
  const bySeq = new Map<number, Set<string>>();
  for (const x of results) if (x.head) bySeq.set(x.head.seq, (bySeq.get(x.head.seq) ?? new Set()).add(x.head.sha256));
  for (const [s, set] of bySeq) if (set.size > 1) out.push(`fork at seq ${s}: mirrors disagree on the hash`);
  return out;
}
