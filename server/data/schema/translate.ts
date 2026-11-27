/**
 * SQLite -> MySQL 8.4 schema translator (S-250). Input is the DDL SQLite itself reports for a fully migrated store (sqlite_master), so the MySQL
 * schema is derived from what the code really creates, not from a second hand-kept copy. The rules (docs/backend/DATA_MODEL_MYSQL.md):
 *  - every text column that is in a key (primary, unique, any index) becomes VARCHAR(190); other TEXT becomes MEDIUMTEXT; INTEGER becomes BIGINT;
 *  - AUTOINCREMENT / INTEGER PRIMARY KEY becomes AUTO_INCREMENT;
 *  - every table and column uses utf8mb4_bin, because SQLite compares text exactly (case and accents matter) and MySQL's default collation does not;
 *  - a partial unique index `WHERE col IS NOT NULL` becomes a plain unique index (MySQL lets a unique column hold many NULLs); any other partial
 *    index, FOREIGN KEY, trigger or view stops the translation, so nobody gets a silently different schema;
 *  - CHECK constraints are kept; defaults on text columns are written as expressions, which MySQL requires for TEXT.
 * Every identifier is quoted with backticks in the output. Code that queries a column named like a MySQL reserved word (for example `key`) must quote it too.
 */
export interface SqliteObject { type: string; name: string; tbl_name: string; sql: string }

interface Col { name: string; type: string; notNull: boolean; pk: boolean; auto: boolean; unique: boolean; def: string | null; check: string | null }
interface Tbl { name: string; cols: Col[]; pk: string[]; uniques: string[][]; checks: string[] }

const stripComments = (s: string): string => {
  let out = ""; let q = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { out += c; if (c === q) q = ""; continue; }
    if (c === "'" || c === '"') { q = c; out += c; continue; }
    if (c === "-" && s[i + 1] === "-") { while (i < s.length && s[i] !== "\n") i++; out += "\n"; continue; }
    out += c;
  }
  return out;
};

/** Split on commas that are not inside parentheses or quotes. */
function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0; let q = ""; let cur = "";
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = ""; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const names = (s: string): string[] => s.split(",").map((x) => x.trim().replace(/^["`\[]|["`\]]$/g, "").replace(/\s+(ASC|DESC)$/i, ""));
const bt = (n: string): string => "`" + n.replace(/`/g, "") + "`";

/** The text after the first `(` up to its matching `)`. */
function parenBody(s: string, from: number): { body: string; end: number } {
  let depth = 0; let q = "";
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ""; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === "(") { if (depth++ === 0) from = i; }
    else if (c === ")" && --depth === 0) return { body: s.slice(from + 1, i), end: i };
  }
  throw new Error("unbalanced parentheses in: " + s.slice(0, 80));
}

function parseTable(sql: string): Tbl {
  const clean = stripComments(sql);
  const m = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?(\w+)["`]?\s*\(/i.exec(clean);
  if (!m) throw new Error("not a CREATE TABLE: " + sql.slice(0, 80));
  const { body, end } = parenBody(clean, m.index + m[0].length - 1);
  if (/WITHOUT ROWID/i.test(clean.slice(end))) throw new Error(`table ${m[1]}: WITHOUT ROWID is not translated`);
  const t: Tbl = { name: m[1], cols: [], pk: [], uniques: [], checks: [] };
  for (const item of splitTop(body)) {
    let r: RegExpExecArray | null;
    if ((r = /^PRIMARY KEY\s*\((.*)\)$/is.exec(item))) { t.pk = names(r[1]); continue; }
    if ((r = /^UNIQUE\s*\((.*)\)$/is.exec(item))) { t.uniques.push(names(r[1])); continue; }
    if ((r = /^CHECK\s*(\(.*\))$/is.exec(item))) { t.checks.push(r[1]); continue; }
    if (/^(FOREIGN KEY|CONSTRAINT)\b/i.test(item) || /\bREFERENCES\b/i.test(item)) throw new Error(`table ${t.name}: foreign keys / constraints are not translated: ${item.slice(0, 60)}`);
    r = /^["`]?(\w+)["`]?\s+(\w+)\s*(.*)$/is.exec(item);
    if (!r) throw new Error(`table ${t.name}: cannot read column: ${item.slice(0, 60)}`);
    const rest = r[3];
    const col: Col = { name: r[1], type: r[2].toUpperCase(), notNull: /\bNOT NULL\b/i.test(rest), pk: /\bPRIMARY KEY\b/i.test(rest), auto: /\bAUTOINCREMENT\b/i.test(rest), unique: /\bUNIQUE\b/i.test(rest), def: null, check: null };
    const d = /\bDEFAULT\s+('(?:[^']|'')*'|-?\d+(?:\.\d+)?|NULL|\([^)]*\))/i.exec(rest);
    if (d) col.def = d[1];
    const ck = /\bCHECK\s*\(/i.exec(rest);
    if (ck) col.check = "(" + parenBody(rest, ck.index + ck[0].length - 1).body + ")";
    if (col.pk && !t.pk.includes(col.name)) t.pk.push(col.name);
    t.cols.push(col);
  }
  return t;
}

interface Idx { name: string; table: string; unique: boolean; cols: string[] }
function parseIndex(o: SqliteObject): Idx {
  const m = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?["`]?(\w+)["`]?\s+ON\s+["`]?(\w+)["`]?\s*\((.*)\)\s*(WHERE\s+(.*))?$/is.exec(stripComments(o.sql).trim());
  if (!m) throw new Error("cannot read index: " + o.sql.slice(0, 80));
  if (m[5]) {
    const col = /^["`]?(\w+)["`]?\s+IS NOT NULL$/i.exec(m[6].trim());
    if (!col || !m[1] || names(m[4]).length !== 1 || names(m[4])[0] !== col[1]) throw new Error(`index ${m[2]}: partial index is not translated: ${m[5]}`);
  }
  return { name: m[2], table: m[3], unique: !!m[1], cols: names(m[4]) };
}

function colType(c: Col, keyed: boolean): string {
  if (c.auto || (c.type === "INTEGER" && c.pk)) return "BIGINT";
  switch (c.type) {
    case "INTEGER": case "INT": case "BIGINT": return "BIGINT";
    case "TEXT": case "VARCHAR": return keyed ? "VARCHAR(190)" : "MEDIUMTEXT";
    case "REAL": case "FLOAT": case "DOUBLE": return "DOUBLE";
    default: throw new Error(`column ${c.name}: type ${c.type} is not translated`);
  }
}

/** MySQL DDL for the given sqlite_master rows (tables, then indexes). The result is deterministic and ends with a newline. */
export function translateSqlite(objects: SqliteObject[], skip: string[] = ["migrations"]): string {
  const bad = objects.find((o) => (o.type === "trigger" || o.type === "view"));
  if (bad) throw new Error(`${bad.type} ${bad.name} is not translated`);
  const tables = objects.filter((o) => o.type === "table" && !skip.includes(o.name) && !o.name.startsWith("sqlite_")).map((o) => parseTable(o.sql)).sort((a, b) => a.name.localeCompare(b.name));
  const idx = objects.filter((o) => o.type === "index" && !skip.includes(o.tbl_name)).map(parseIndex).sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name));
  const out: string[] = [];
  for (const t of tables) {
    const keyed = new Set<string>([...t.pk, ...t.uniques.flat(), ...t.cols.filter((c) => c.unique).map((c) => c.name), ...idx.filter((i) => i.table === t.name).flatMap((i) => i.cols)]);
    const lines: string[] = [];
    for (const c of t.cols) {
      const isAuto = c.auto || (c.type === "INTEGER" && c.pk && t.pk.length === 1);
      let l = `${bt(c.name)} ${colType(c, keyed.has(c.name))}`;
      if (c.type === "TEXT" || c.type === "VARCHAR") l += " COLLATE utf8mb4_bin";
      if (c.notNull || t.pk.includes(c.name)) l += " NOT NULL";
      if (isAuto) l += " AUTO_INCREMENT";
      if (c.def !== null && !isAuto) l += ` DEFAULT ${c.type === "TEXT" && !keyed.has(c.name) && c.def !== "NULL" ? "(" + c.def + ")" : c.def}`;
      if (c.check) l += ` CHECK ${c.check}`;
      lines.push(l);
    }
    if (t.pk.length) lines.push(`PRIMARY KEY (${t.pk.map(bt).join(", ")})`);
    for (const u of t.uniques) lines.push(`UNIQUE KEY (${u.map(bt).join(", ")})`);
    for (const c of t.cols.filter((x) => x.unique)) lines.push(`UNIQUE KEY (${bt(c.name)})`);
    for (const ck of t.checks) lines.push(`CHECK ${ck}`);
    out.push(`CREATE TABLE IF NOT EXISTS ${bt(t.name)} (\n  ${lines.join(",\n  ")}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;`);
  }
  for (const i of idx) out.push(`CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${bt(i.name)} ON ${bt(i.table)} (${i.cols.map(bt).join(", ")});`);
  return out.join("\n\n") + "\n";
}
