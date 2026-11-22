/**
 * Share cards (S-122): one layout, rendered to SVG (string) or to a canvas (PNG).
 * Guardrails against misinformation: every card carries the source and the data as-of date; a model projection carries the
 * projection disclaimer; demo data is stamped; entries are listed alphabetically so the card never ranks or favours a party.
 */
export interface CardInput {
  title: string;
  lines: { label: string; value: string }[];
  source: string;
  asOf: string;
  /** true for model projections: adds the not-a-poll disclaimer */
  projection?: boolean;
  demo?: boolean;
  labels: { source: string; asOf: string; projection: string; demo: string; footer: string };
}

export interface Prim { kind: "rect" | "text"; x: number; y: number; w?: number; h?: number; fill: string; text?: string; size?: number; weight?: number; anchor?: "start" | "end" }
export interface Card { width: number; height: number; prims: Prim[]; text: string[] }

const W = 1080;
const PAD = 56;
const FONT = `"Noto Sans Telugu", system-ui, "Segoe UI", Roboto, "Nirmala UI", sans-serif`;

/** Greedy wrap by character count (a fair approximation for both Latin and Telugu at these sizes). */
export function wrap(s: string, max: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + " " + w : w;
  }
  if (cur) out.push(cur);
  return out;
}

export function buildCard(i: CardInput): Card {
  const prims: Prim[] = [];
  const text: string[] = [];
  let y = PAD + 8;
  const add = (t: string, size: number, weight = 400, fill = "#121212", x = PAD, anchor: "start" | "end" = "start") => {
    prims.push({ kind: "text", x, y, fill, text: t, size, weight, anchor });
  };
  const para = (t: string, size: number, weight = 400, fill = "#121212", max = 64) => {
    for (const ln of wrap(t, max)) { y += Math.round(size * 1.5); add(ln, size, weight, fill); }
    text.push(t);
  };

  y += 30; add(i.title, 40, 700); text.push(i.title);
  if (i.demo) { y += 52; add(i.labels.demo, 26, 700, "#7a3e00"); text.push(i.labels.demo); }
  y += 28;
  const sorted = [...i.lines].sort((a, b) => a.label.localeCompare(b.label));
  for (const l of sorted) {
    y += 56;
    add(l.label, 32, 700);
    add(l.value, 32, 400, "#121212", W - PAD, "end");
    text.push(`${l.label} ${l.value}`);
    prims.push({ kind: "rect", x: PAD, y: y + 14, w: W - 2 * PAD, h: 1, fill: "#00000022" });
  }
  y += 30;
  const meta = `${i.labels.source}: ${i.source}`;
  y += 30; para(meta, 24, 400, "#333", 70);
  y += 8; para(`${i.labels.asOf}: ${i.asOf}`, 24, 400, "#333", 70);
  if (i.projection) { y += 22; para(i.labels.projection, 24, 700, "#7a3e00", 66); }
  y += 26; para(i.labels.footer, 20, 400, "#555", 80);
  const height = y + PAD;
  prims.unshift({ kind: "rect", x: 0, y: 0, w: W, h: height, fill: "#FAF8F5" }, { kind: "rect", x: 0, y: 0, w: W, h: 12, fill: "#121212" });
  return { width: W, height, prims, text };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function cardToSvg(c: Card): string {
  const body = c.prims.map((p) => p.kind === "rect"
    ? `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="${p.fill}"/>`
    : `<text x="${p.x}" y="${p.y}" font-size="${p.size}" font-weight="${p.weight}" fill="${p.fill}" text-anchor="${p.anchor === "end" ? "end" : "start"}" font-family='${FONT}'>${esc(p.text ?? "")}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${c.width}" height="${c.height}" viewBox="0 0 ${c.width} ${c.height}" role="img" aria-label="${esc(c.text.join(". "))}">${body}</svg>`;
}

export function drawCard(ctx: CanvasRenderingContext2D, c: Card): void {
  for (const p of c.prims) {
    ctx.fillStyle = p.fill;
    if (p.kind === "rect") { ctx.fillRect(p.x, p.y, p.w ?? 0, p.h ?? 0); continue; }
    ctx.font = `${p.weight} ${p.size}px ${FONT}`;
    ctx.textAlign = p.anchor === "end" ? "right" : "left";
    ctx.fillText(p.text ?? "", p.x, p.y);
  }
}
