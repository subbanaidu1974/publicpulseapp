/** Small dependency-free geometry helpers: validate, simplify, round, measure. */
export type Pos = [number, number];
export type Ring = Pos[];
export type Poly = Ring[];
export interface Geom { type: "Polygon" | "MultiPolygon"; coordinates: any }

export const toPolys = (g: Geom): Poly[] => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);
export const fromPolys = (p: Poly[]): Geom => (p.length === 1 ? { type: "Polygon", coordinates: p[0] } : { type: "MultiPolygon", coordinates: p });

/** Signed shoelace area in degrees squared. */
export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, n = r.length - 1; i < n; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return a / 2;
}
export function polyArea(p: Poly): number {
  return Math.abs(ringArea(p[0])) - p.slice(1).reduce((s, h) => s + Math.abs(ringArea(h)), 0);
}

function perpDist(p: Pos, a: Pos, b: Pos): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function douglasPeucker(pts: Pos[], tol: number): Pos[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let m = -1, md = tol;
    for (let i = s + 1; i < e; i++) { const d = perpDist(pts[i], pts[s], pts[e]); if (d > md) { md = d; m = i; } }
    if (m >= 0) { keep[m] = 1; stack.push([s, m], [m, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** Douglas-Peucker on a closed ring, split at the point farthest from the start so closure is stable. */
export function simplifyRing(r: Ring, tol: number): Ring {
  if (r.length <= 5) return r;
  let far = 0, fd = -1;
  for (let i = 1; i < r.length - 1; i++) { const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = douglasPeucker(r.slice(0, far + 1), tol), b = douglasPeucker(r.slice(far), tol);
  return [...a, ...b.slice(1)];
}
export const roundPos = (p: Pos, decimals: number): Pos => { const f = 10 ** decimals; return [Math.round(p[0] * f) / f, Math.round(p[1] * f) / f]; };

/** Simplify and round; drops rings that collapse and holes/islands smaller than minArea (deg^2). */
export function simplifyGeom(g: Geom, tol: number, decimals = 4, minArea = tol * tol * 4): Geom | null {
  const out: Poly[] = [];
  for (const poly of toPolys(g)) {
    const rings: Poly = [];
    poly.forEach((ring, i) => {
      let r = simplifyRing(ring, tol).map(p => roundPos(p, decimals));
      r = r.filter((p, j) => j === 0 || p[0] !== r[j - 1][0] || p[1] !== r[j - 1][1]);
      if (r.length < 4 || Math.abs(ringArea(r)) < (i === 0 ? minArea : minArea * 2)) return;
      const f = r[0], l = r[r.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) r.push([f[0], f[1]]);
      rings.push(r);
    });
    if (rings.length && polyArea(rings) > 0) out.push(rings);
  }
  return out.length ? fromPolys(out) : null;
}

/** Returns violations for a polygonal geometry ([] = valid enough to ship). */
export function geomErrors(g: any): string[] {
  const errs: string[] = [];
  if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon") || !Array.isArray(g.coordinates)) return ["geometry is not a Polygon/MultiPolygon"];
  const polys = toPolys(g);
  if (!polys.length) return ["empty geometry"];
  for (const poly of polys) {
    if (!poly.length) { errs.push("polygon without rings"); continue; }
    poly.forEach((r, i) => {
      if (r.length < 4) { errs.push("ring with fewer than 4 positions"); return; }
      const f = r[0], l = r[r.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) errs.push("unclosed ring");
      if (r.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < 60 || p[0] > 100 || p[1] < 5 || p[1] > 40)) errs.push("coordinate outside India bounds");
      if (i === 0 && ringArea(r) === 0) errs.push("zero-area ring");
    });
  }
  return errs;
}
export function bbox(g: Geom): [number, number, number, number] {
  let a = 180, b = 90, c = -180, d = -90;
  for (const p of toPolys(g)) for (const [x, y] of p[0]) { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
  return [a, b, c, d];
}
export const countVertices = (g: Geom) => toPolys(g).reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0);
