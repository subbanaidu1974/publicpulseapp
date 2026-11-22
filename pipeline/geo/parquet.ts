import { readFileSync } from "node:fs";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

/** Read a whole parquet file into row objects (BigInt values converted to numbers when safe). */
export async function readParquet(path: string, columns?: string[]): Promise<Record<string, any>[]> {
  const buf = readFileSync(path);
  const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const rows = (await parquetReadObjects({ file, compressors, columns } as any)) as Record<string, any>[];
  for (const r of rows) for (const k in r) if (typeof r[k] === "bigint") r[k] = Number(r[k]);
  return rows;
}
