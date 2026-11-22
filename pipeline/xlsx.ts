import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { createInflateRaw } from "node:zlib";

/**
 * Minimal streaming .xlsx reader (zero dependencies). The Census DCHB village workbook has a 360 MB sheet XML, so
 * sheets are inflated as a stream and parsed row by row instead of loading the workbook into memory.
 * Supports shared strings, inline strings and numbers; no formulas, styles or zip64.
 */

interface ZipEntry { name: string; method: number; csize: number; offset: number }

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  readSync(fd, b, 0, len, pos);
  return b;
}

export function zipEntries(path: string): Map<string, ZipEntry> {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const tailLen = Math.min(size, 66000);
    const tail = readAt(fd, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error(`${path}: not a complete zip archive (end-of-central-directory not found; truncated download?)`);
    const total = tail.readUInt16LE(e + 10);
    const cdSize = tail.readUInt32LE(e + 12);
    const cdOff = tail.readUInt32LE(e + 16);
    const cd = readAt(fd, cdOff, cdSize);
    const out = new Map<string, ZipEntry>();
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nlen);
      out.set(name, { name, method, csize, offset });
      p += 46 + nlen + xlen + clen;
    }
    return out;
  } finally { closeSync(fd); }
}

function entryStream(path: string, z: ZipEntry): NodeJS.ReadableStream {
  const fd = openSync(path, "r");
  let start: number;
  try {
    const h = readAt(fd, z.offset, 30);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error("corrupt zip local header");
    start = z.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally { closeSync(fd); }
  const raw = createReadStream(path, { start, end: start + z.csize - 1 });
  if (z.method === 0) return raw;
  if (z.method !== 8) throw new Error(`unsupported zip compression method ${z.method}`);
  return raw.pipe(createInflateRaw());
}

async function readWhole(path: string, z: ZipEntry): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of entryStream(path, z)) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    out.push(unescapeXml([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(x => x[1]).join("")));
  }
  return out;
}

export function sheetNames(path: string): Promise<string[]> {
  const z = zipEntries(path).get("xl/workbook.xml");
  if (!z) throw new Error("not an xlsx workbook");
  return readWhole(path, z).then(x => [...x.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map(m => unescapeXml(m[1])));
}

/** Iterate rows of one sheet as `{ A: "...", B: "..." }` (column letter -> text). Empty cells are omitted. */
export async function* xlsxRows(path: string, sheet: string): AsyncGenerator<Record<string, string>> {
  const entries = zipEntries(path);
  const wb = entries.get("xl/workbook.xml"), rels = entries.get("xl/_rels/workbook.xml.rels");
  if (!wb || !rels) throw new Error("not an xlsx workbook");
  const wbXml = await readWhole(path, wb), relXml = await readWhole(path, rels);
  const sh = [...wbXml.matchAll(/<sheet ([^>]*)\/>/g)].map(m => m[1]).find(a => unescapeXml(/name="([^"]*)"/.exec(a)?.[1] ?? "") === sheet);
  if (!sh) throw new Error(`sheet '${sheet}' not found`);
  const rid = /r:id="([^"]*)"/.exec(sh)?.[1];
  const rel = [...relXml.matchAll(/<Relationship ([^>]*)\/>/g)].map(m => m[1]).find(a => new RegExp(`Id="${rid}"`).test(a));
  const target = /Target="([^"]*)"/.exec(rel ?? "")?.[1];
  if (!target) throw new Error(`sheet '${sheet}' has no worksheet part`);
  const part = entries.get(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  if (!part) throw new Error(`worksheet part ${target} missing`);
  const ssEntry = entries.get("xl/sharedStrings.xml");
  const shared = ssEntry ? parseSharedStrings(await readWhole(path, ssEntry)) : [];

  const cellRe = /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const parseRow = (xml: string): Record<string, string> => {
    const row: Record<string, string> = {};
    cellRe.lastIndex = 0;
    for (let m = cellRe.exec(xml); m; m = cellRe.exec(xml)) {
      if (m[3] === undefined) continue;
      const attrs = m[2], body = m[3];
      let val: string | undefined;
      if (/t="inlineStr"/.test(attrs)) val = unescapeXml([...body.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(x => x[1]).join(""));
      else {
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        if (v !== undefined) val = /t="s"/.test(attrs) ? shared[Number(v)] : unescapeXml(v);
      }
      if (val !== undefined && val !== "") row[m[1]] = val;
    }
    return row;
  };

  let buf = "";
  const stream = entryStream(path, part);
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    buf += chunk as string;
    let end: number;
    while ((end = buf.indexOf("</row>")) >= 0) {
      const start = buf.lastIndexOf("<row ", end);
      if (start >= 0) yield parseRow(buf.slice(start, end));
      buf = buf.slice(end + 6);
    }
    // Keep only a bounded tail so a huge header-less prefix cannot grow the buffer.
    if (buf.length > 5_000_000) buf = buf.slice(-1_000_000);
  }
}
