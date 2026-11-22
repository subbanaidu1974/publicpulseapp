import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  dchbRecordToUnit, parseUnitCsv, parseUnitRows, rollupDistricts, rollupSubDistricts, stateOfDistrict2011, unitToRow, UNIT_COLUMNS, validateUnits,
} from "../../pipeline/census";
import { sheetNames, xlsxRows } from "../../pipeline/xlsx";

const ROOT = resolve(__dirname, "../..");
const gen = (f: string) => JSON.parse(readFileSync(resolve(ROOT, "data/generated", f), "utf8"));
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pp-census-")); tmps.push(d); return d; };
afterAll(() => tmps.forEach(d => rmSync(d, { recursive: true, force: true })));

/** Build a minimal .xlsx (zip with deflate) in memory so the streaming reader is tested without network or big files. */
function miniXlsx(path: string, rows: string[][]): void {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const strings: string[] = [];
  const idx = (s: string) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${rows.map((r, ri) =>
    `<row r="${ri + 1}">${r.map((v, ci) => v === "" ? `<c r="${col(ci)}${ri + 1}"/>` : isNaN(Number(v)) ? `<c r="${col(ci)}${ri + 1}" t="s"><v>${idx(v)}</v></c>` : `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const files: [string, string][] = [
    ["xl/workbook.xml", `<workbook><sheets><sheet name="Data_2800" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", sheet],
    ["xl/sharedStrings.xml", `<sst>${strings.map(s => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`],
  ];
  const parts: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, "utf8"), comp = deflateRawSync(data), nm = Buffer.from(name), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  writeFileSync(path, Buffer.concat([...parts, cd, eocd]));
}

const VILLAGE_HEADER = ["State Code", "District Code", "District Name", "Sub District Code", "Sub District Name", "Village Code", "Village Name",
  "Total   Households ", "Total Population of Village", "Total Male Population of Village", "Total Female Population of Village",
  "Total Scheduled Castes Population of Village", "Total Scheduled Tribes Population of Village"];
const rec = (vals: (string | number)[], header = VILLAGE_HEADER) => Object.fromEntries(header.map((h, i) => [h, String(vals[i])]));

describe("@E2E-99 census pipeline (district, sub-district, village keyed by Census 2011 codes)", () => {
  it("maps Census 2011 district codes to the current states", () => {
    expect(stateOfDistrict2011("532")).toBe("TG");
    expect(stateOfDistrict2011("541")).toBe("TG");
    expect(stateOfDistrict2011("542")).toBe("AP");
    expect(stateOfDistrict2011("554")).toBe("AP");
    expect(stateOfDistrict2011("555")).toBeNull();
    expect(stateOfDistrict2011("abc")).toBeNull();
  });

  it("normalises a DCHB village record, treats blanks as zero only for uninhabited villages", () => {
    const ok = dchbRecordToUnit("V", rec([28, "532", "ADILABAD", "04305", "Tamsi", "568945", "Karanji (T)", 504, 2232, 1104, 1128, 258, 795]));
    expect(ok).toMatchObject({ kind: "V", state: "TG", districtCode: "532", district: "Adilabad", subDistrictCode: "04305", code: "568945", population: 2232, males: 1104, females: 1128, scPop: 258, stPop: 795, households: 504 });
    const empty = dchbRecordToUnit("V", rec([28, "532", "ADILABAD", "04305", "Tamsi", "568977", "Mallapur", "", 0, "", "", "", ""]));
    expect(empty).toMatchObject({ population: 0, males: 0, females: 0, scPop: 0, stPop: 0, households: 0 });
    const bad = dchbRecordToUnit("V", rec([28, "532", "ADILABAD", "04305", "Tamsi", "568978", "Broken", 10, 100, "", "", "", ""]));
    expect(bad).toBeNull();
    expect(dchbRecordToUnit("V", rec([28, "999", "X", "1", "Y", "1", "Z", 1, 2, 1, 1, 0, 0]))).toBeNull();
  });

  it("rolls villages and towns up to district and sub-district with correct shares and sex ratio", () => {
    const units = [
      dchbRecordToUnit("V", rec([28, "542", "SRIKAKULAM", "00001", "A", "1", "v1", 10, 100, 60, 40, 20, 10]))!,
      dchbRecordToUnit("V", rec([28, "542", "SRIKAKULAM", "00001", "A", "2", "v2", 10, 100, 40, 60, 0, 0]))!,
      dchbRecordToUnit("T", { ...rec([28, "542", "SRIKAKULAM", "00000", "Town spread over more than one sub-district", "9", "t1", 50, 200, 100, 100, 40, 0], VILLAGE_HEADER), "Total Population of Town": "200", "Total Male Population of Town": "100", "Total Female Population of Town": "100", "Total Scheduled Castes Population of Town": "40", "Total Scheduled Tribes Population of Town": "0", "Town Code": "9", "Town Name": "t1" })!,
    ];
    const [d] = rollupDistricts(units, "t");
    expect(d).toMatchObject({ state: "AP", districtCode: "542", population: 400, males: 200, females: 200, scPop: 60, stPop: 10, households: 70, literate: null, literacyPct: null, sexRatio: 1000, scPct: 15, stPct: 2.5 });
    const subs = rollupSubDistricts(units);
    expect(subs.map(s => [s.subDistrictCode, s.population, s.villages, s.towns])).toEqual([["00000", 200, 0, 1], ["00001", 200, 2, 0]]);
  });

  it("validates units: mismatching male+female and duplicates are reported", () => {
    const u = dchbRecordToUnit("V", rec([28, "542", "S", "1", "A", "1", "v", 1, 100, 60, 30, 0, 0]))!;
    expect(validateUnits([u]).join()).toMatch(/males\+females/);
    const ok = { ...u, females: 40 };
    expect(validateUnits([ok, ok]).join()).toMatch(/duplicate/);
    expect(validateUnits([ok])).toEqual([]);
  });

  it("streams a real .xlsx structure (shared strings, empty cells, entities) without loading it whole", async () => {
    const dir = tmp(), f = join(dir, "mini.xlsx");
    miniXlsx(f, [["Village Name", "Pop", "X"], ["Karanji (T) & Co", "2232", ""], ["B", "7", "z"]]);
    expect(await sheetNames(f)).toEqual(["Data_2800"]);
    const out: Record<string, string>[] = [];
    for await (const r of xlsxRows(f, "Data_2800")) out.push(r);
    expect(out).toEqual([{ A: "Village Name", B: "Pop", C: "X" }, { A: "Karanji (T) & Co", B: "2232" }, { A: "B", B: "7", C: "z" }]);
    writeFileSync(join(dir, "trunc.xlsx"), readFileSync(f).subarray(0, 40));
    await expect(xlsxRows(join(dir, "trunc.xlsx"), "Data_2800").next()).rejects.toThrow(/zip/);
  });

  it("manual drop-in unit CSV is parsed with the documented columns", () => {
    const csv = "kind,district_code,district,subdistrict_code,subdistrict,code,name,households,population,males,females,sc,st\n" +
      "V,532,ADILABAD,04305,Tamsi,568945,Karanji,504,2232,1104,1128,258,795\nV,999,X,1,y,1,bad,1,1,1,0,0,0\n";
    const units = parseUnitCsv(csv);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ state: "TG", code: "568945", population: 2232 });
    expect(parseUnitRows(UNIT_COLUMNS, [unitToRow(units[0])])[0]).toMatchObject({ code: "568945", population: 2232, scPop: 258 });
  });

  it("fetch-census uses a data/raw/census drop-in CSV (manual-csv provenance) instead of the demo fixture", () => {
    const raw = tmp(), out = tmp();
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, "units.csv"), "kind,district_code,district,subdistrict_code,subdistrict,code,name,households,population,males,females,sc,st\nV,542,SRIKAKULAM,00001,A,1,v1,10,100,60,40,20,10\n");
    const env = { ...process.env, PIPELINE_OUT_DIR: out, CENSUS_RAW_DIR: raw } as NodeJS.ProcessEnv;
    delete env.DATA_GOV_IN_API_KEY;
    const r = spawnSync(process.execPath, [resolve(ROOT, "node_modules/tsx/dist/cli.mjs"), resolve(ROOT, "scripts/fetch-census.ts")], { env, encoding: "utf8", cwd: ROOT });
    expect(r.status).toBe(0);
    const snap = JSON.parse(readFileSync(join(out, "census.json"), "utf8"));
    expect(snap.provenance).toBe("manual-csv");
    expect(snap.districts[0]).toMatchObject({ districtCode: "542", state: "AP", population: 100 });
  });

  describe("committed real data (Census 2011 DCHB village and town directories)", () => {
    const districts = gen("census.json").districts as { state: string; districtCode: string; district: string; population: number }[];
    const subs = gen("census-subdistricts.json").subDistricts as { state: string; population: number }[];
    const units = gen("census-units.json");

    it("is real, not demo, and states its provenance", () => {
      expect(gen("census.json").provenance).toBe("census-dchb-2011");
      expect(gen("census.json").source).toMatch(/censusindia\.gov\.in/);
    });

    it("state totals equal the published Census 2011 populations (AP 49,386,799; TG 35,193,978)", () => {
      const sum = (rows: { state: string; population: number }[], s: string) => rows.filter(r => r.state === s).reduce((a, r) => a + r.population, 0);
      for (const rows of [districts, subs]) {
        expect(sum(rows, "AP")).toBe(49386799);
        expect(sum(rows, "TG")).toBe(35193978);
      }
    });

    it("has 13 AP and 10 TG Census 2011 districts keyed by 3-digit code", () => {
      expect(districts.filter(d => d.state === "AP")).toHaveLength(13);
      expect(districts.filter(d => d.state === "TG")).toHaveLength(10);
      expect(districts.find(d => d.districtCode === "536")).toMatchObject({ district: "Hyderabad", state: "TG", population: 3943323 });
      expect(districts.find(d => d.districtCode === "548")).toMatchObject({ district: "Guntur", state: "AP", population: 4887813 });
    });

    it("village/town units are consistent and join key is the Census 2011 code", () => {
      expect(units.columns).toEqual([...UNIT_COLUMNS]);
      expect(units.units).toHaveLength(28155);
      const parsed = parseUnitRows(units.columns, units.units);
      expect(validateUnits(parsed)).toEqual([]);
      expect(parsed.filter(u => u.kind === "V")).toHaveLength(27800);
      expect(parsed.filter(u => u.kind === "T")).toHaveLength(355);
      expect(parsed[0].code).toMatch(/^\d{6}$/);
    });
  });
});
