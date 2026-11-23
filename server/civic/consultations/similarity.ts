/**
 * Near-duplicate detection for consultation comments (S-36 a). PURE functions.
 *
 *   normalise  NFKC, lower case, punctuation and digits removed (letters and Telugu marks kept), whitespace collapsed
 *   shingles   word 3-grams (single tokens for very short comments)
 *   minhash    64 hash functions; LSH banding (16 bands x 4) finds candidate pairs without an O(n^2) scan
 *   cluster    candidate pairs are verified with the exact Jaccard similarity of the shingle sets; union-find groups them
 *
 * Clusters are an analyst aid and an astroturf flag. They never change an aggregate: every aggregate counts one feedback row per
 * (person, clause) whatever the comments say.
 */
export function normaliseComment(text: string): string {
  return String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function shingles(norm: string, k = 3): Set<string> {
  const w = norm ? norm.split(" ") : [];
  const out = new Set<string>();
  if (w.length < k) { if (w.length) out.add(w.join(" ")); return out; }
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const fnv = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
const P = 4294967291; // prime below 2^32
const HASHES = 64, BANDS = 16, ROWS = 4;
// fixed pseudo-random coefficients (deterministic: clusters are reproducible)
const COEF: [number, number][] = (() => {
  const out: [number, number][] = []; let x = 123456789;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  for (let i = 0; i < HASHES; i++) out.push([(next() % (P - 1)) + 1, next() % P]);
  return out;
})();
const mulmod = (a: number, b: number): number => Number((BigInt(a) * BigInt(b)) % BigInt(P));

export function minhash(sh: Set<string>): number[] {
  const base = [...sh].map(fnv);
  return COEF.map(([a, b]) => { let m = Infinity; for (const x of base) { const v = (mulmod(a, x) + b) % P; if (v < m) m = v; } return m; });
}

export interface CommentItem { id: string; text: string }
export interface Cluster { ids: string[]; size: number; representative: string }

/**
 * Cluster near-identical comments. Items whose normalised text is empty are ignored. Deterministic for a given input order
 * (the representative is the first id of the cluster in input order). Singleton clusters are returned only when `includeSingles`.
 */
export function clusterComments(items: CommentItem[], threshold = 0.8, includeSingles = false): Cluster[] {
  const rows = items.map((it) => ({ id: it.id, norm: normaliseComment(it.text) })).filter((r) => r.norm.length > 0);
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };

  // exact normalised duplicates first (the common copy-paste case): O(n)
  const byNorm = new Map<string, number>();
  rows.forEach((r, i) => { const j = byNorm.get(r.norm); if (j === undefined) byNorm.set(r.norm, i); else union(i, j); });

  // near duplicates over the distinct texts only
  const distinct = [...byNorm.values()];
  const sets = new Map<number, Set<string>>();
  const buckets = new Map<string, number[]>();
  for (const i of distinct) {
    const sh = shingles(rows[i].norm);
    sets.set(i, sh);
    const sig = minhash(sh);
    for (let b = 0; b < BANDS; b++) {
      const key = b + ":" + sig.slice(b * ROWS, (b + 1) * ROWS).join(",");
      const arr = buckets.get(key); if (arr) arr.push(i); else buckets.set(key, [i]);
    }
  }
  const seen = new Set<string>();
  for (const arr of buckets.values()) {
    if (arr.length < 2 || arr.length > 2000) continue;
    for (let x = 0; x < arr.length; x++) for (let y = x + 1; y < arr.length; y++) {
      const a = arr[x], b = arr[y], key = a < b ? a + "-" + b : b + "-" + a;
      if (seen.has(key) || find(a) === find(b)) continue;
      seen.add(key);
      if (jaccard(sets.get(a)!, sets.get(b)!) >= threshold) union(a, b);
    }
  }
  const groups = new Map<number, string[]>();
  rows.forEach((r, i) => { const g = find(i); (groups.get(g) ?? groups.set(g, []).get(g)!).push(r.id); });
  return [...groups.values()].filter((ids) => includeSingles || ids.length > 1).map((ids) => ({ ids, size: ids.length, representative: ids[0] })).sort((a, b) => b.size - a.size);
}
