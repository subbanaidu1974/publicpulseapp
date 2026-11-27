import crypto from "node:crypto";
import { ident, type Db, type Param } from "./types";

/**
 * Copy and verify tables between two databases (S-250; the cutover itself is S-256). `copyTables` moves every row of the named tables from
 * `from` (the SQLite store) to `to` (MySQL) in batches inside one transaction per table, and refuses a target table that already has rows.
 * `verifyTables` compares row counts and an order-independent content digest per table, so a changed, missing or extra row is reported with
 * the table name. Values are compared as text (a number and its decimal string match), which is how both engines return them to the app.
 * This does not lock the source: run it against a stopped or read-only store (docs/backend/DATA_MODEL_MYSQL.md, cutover).
 */
export interface TableReport { table: string; rows: number; digest: string }
export interface CopyResult { tables: TableReport[]; rows: number }
export interface VerifyResult { ok: boolean; tables: { table: string; from: TableReport; to: TableReport; same: boolean }[] }

const q = (name: string, db: Db): string => (ident(name), db.engine === "mysql" ? "`" + name + "`" : name);

async function columnsOf(db: Db, table: string): Promise<string[]> {
  if (db.engine === "sqlite") return (await db.all<{ name: string }>(`PRAGMA table_info(${ident(table)})`)).map((r) => r.name);
  return (await db.all<{ n: string }>("SELECT column_name AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position", [table])).map((r) => r.n);
}

/** Primary key columns in key order (empty when the table has none), so paging is stable even for long text columns. */
async function keyOf(db: Db, table: string): Promise<string[]> {
  if (db.engine === "sqlite") return (await db.all<{ name: string; pk: number }>(`PRAGMA table_info(${ident(table)})`)).filter((r) => r.pk > 0).sort((a, b) => a.pk - b.pk).map((r) => r.name);
  return (await db.all<{ n: string }>("SELECT column_name AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = 'PRIMARY' ORDER BY seq_in_index", [table])).map((r) => r.n);
}

const canon = (v: unknown): string => (v === null || v === undefined ? "\u0000null" : typeof v === "bigint" || typeof v === "number" ? String(v) : v instanceof Uint8Array ? Buffer.from(v).toString("base64") : String(v));

async function* rowsOf(db: Db, table: string, cols: string[], batch: number, key: string[]): AsyncGenerator<Record<string, unknown>[]> {
  const order = (key.length ? key : cols).map((c) => q(c, db)).join(", ");
  const sel = cols.map((c) => q(c, db)).join(", ");
  for (let off = 0; ; off += batch) {
    const rows = await db.all<Record<string, unknown>>(`SELECT ${sel} FROM ${q(table, db)} ORDER BY ${order} LIMIT ${batch} OFFSET ${off}`);
    if (!rows.length) return;
    yield rows;
    if (rows.length < batch) return;
  }
}

export async function digestTable(db: Db, table: string, cols: string[], batch = 1000): Promise<TableReport> {
  let rows = 0; let acc = 0n;
  const MOD = 1n << 128n;
  for await (const chunk of rowsOf(db, table, cols, batch, await keyOf(db, table))) {
    for (const r of chunk) {
      rows++;
      const h = crypto.createHash("sha256").update(JSON.stringify(cols.map((c) => canon(r[c])))).digest();
      acc = (acc + BigInt("0x" + h.subarray(0, 16).toString("hex"))) % MOD; // order-independent: the sum of per-row digests
    }
  }
  return { table, rows, digest: acc.toString(16).padStart(32, "0") };
}

export async function copyTables(from: Db, to: Db, tables: string[], opts: { batch?: number } = {}): Promise<CopyResult> {
  const batch = opts.batch ?? 200;
  const out: TableReport[] = []; let total = 0;
  for (const table of tables) {
    ident(table);
    const cols = await columnsOf(from, table);
    if (!cols.length) throw new Error(`copy: table ${table} does not exist in the source`);
    const have = await to.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q(table, to)}`);
    if (Number(have?.n ?? 0) > 0) throw new Error(`copy: target table ${table} already has rows; it is not overwritten`);
    const toCols = await columnsOf(to, table);
    if (toCols.join() !== cols.join()) throw new Error(`copy: table ${table} has different columns in the target (${toCols.join()} vs ${cols.join()})`);
    const colSql = cols.map((c) => q(c, to)).join(", ");
    let n = 0;
    try {
      await to.tx(async (tx) => {
        for await (const chunk of rowsOf(from, table, cols, batch, await keyOf(from, table))) {
          const params: Param[] = [];
          for (const r of chunk) for (const c of cols) params.push((r[c] ?? null) as Param);
          await tx.run(`INSERT INTO ${q(table, to)} (${colSql}) VALUES ${chunk.map(() => "(" + cols.map(() => "?").join(", ") + ")").join(", ")}`, params);
          n += chunk.length;
        }
      });
    } catch (e) { throw new Error(`copy: table ${table} failed after ${n} rows (nothing from this table was kept): ${(e as Error).message}`); }
    total += n;
    out.push({ table, rows: n, digest: "" });
  }
  return { tables: out, rows: total };
}

export async function verifyTables(from: Db, to: Db, tables: string[]): Promise<VerifyResult> {
  const res: VerifyResult["tables"] = [];
  for (const table of tables) {
    const cols = await columnsOf(from, table);
    const a = await digestTable(from, table, cols); const b = await digestTable(to, table, cols);
    res.push({ table, from: a, to: b, same: a.rows === b.rows && a.digest === b.digest });
  }
  return { ok: res.every((r) => r.same), tables: res };
}
