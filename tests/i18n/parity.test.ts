import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MESSAGES } from "../../src/i18n";
import { ERR_KEYS, errorKey, isErrKey } from "../../src/i18n/errors";
import { FAQS, METHODOLOGY, PRIVACY, ROLES, ROLE_LABELS, TERMS, WHO_NOTES, WHO_SEES, reviewStatus } from "../../src/i18n/content";

const hasTelugu = (s: string) => /[ఀ-౿]/.test(s);
const bi = (b: { en: string; te: string }, where: string) => {
  expect(b.en.trim(), `${where} en`).not.toBe("");
  expect(b.te.trim(), `${where} te`).not.toBe("");
  expect(hasTelugu(b.te), `${where} te contains Telugu script`).toBe(true);
};
const EN = MESSAGES.en as Record<string, string>;
const TE = MESSAGES.te as Record<string, string>;

describe("i18n key parity (S-126)", () => {
  const en = Object.keys(EN).sort();
  const te = Object.keys(TE).sort();
  it("@E2E-141 every EN key has a TE key and vice versa", () => {
    expect(te.filter((k) => !en.includes(k)), "keys only in TE").toEqual([]);
    expect(en.filter((k) => !te.includes(k)), "keys only in EN").toEqual([]);
  });
  it("@E2E-141 no value is empty in either language", () => {
    for (const [k, v] of Object.entries(EN)) expect(String(v).trim(), `en:${k}`).not.toBe("");
    for (const [k, v] of Object.entries(TE)) expect(String(v).trim(), `te:${k}`).not.toBe("");
  });
  it("@E2E-141 Telugu values are not just the English copy", () => {
    const same = en.filter((k) => TE[k] === EN[k]);
    expect(same).toEqual([]);
  });
  it("@E2E-141 numbers survive translation", () => {
    const nums = (s: string) => (s.match(/\d+%?/g) ?? []).sort().join(",");
    for (const k of en) {
      if (k.startsWith("meta.")) continue;
      expect(nums(TE[k]), `numbers in ${k}`).toBe(nums(EN[k]));
    }
  });
});

describe("bilingual long-form content (S-126, S-129)", () => {
  it("@E2E-141 FAQ, methodology, privacy and terms have both languages and unique ids", () => {
    for (const list of [FAQS, METHODOLOGY, PRIVACY, TERMS]) expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
    for (const f of FAQS) { bi(f.q, `faq ${f.id} q`); bi(f.a, `faq ${f.id} a`); }
    for (const m of METHODOLOGY) { bi(m.h, `meth ${m.id} h`); bi(m.p, `meth ${m.id} p`); }
    for (const s of [...PRIVACY, ...TERMS]) { bi(s.h, `legal ${s.id} h`); bi(s.p, `legal ${s.id} p`); }
  });
  it("@E2E-144 who-sees-what covers every role for every row, in both languages", () => {
    expect(WHO_SEES.length).toBeGreaterThanOrEqual(4);
    for (const r of ROLES) bi(ROLE_LABELS[r], `role ${r}`);
    for (const row of WHO_SEES) { bi(row.label, row.id); for (const r of ROLES) bi(row.cells[r], `${row.id}/${r}`); }
    for (const n of WHO_NOTES) bi(n, "note");
  });
  it("@E2E-141 machine-drafted Telugu is flagged until reviewed", () => {
    for (const [k, v] of Object.entries(reviewStatus)) expect(["machine-draft", "reviewed"], k).toContain(v);
    expect(Object.values(reviewStatus)).toContain("machine-draft");
  });
  it("@E2E-144 privacy text never claims Aadhaar storage or benefit linkage", () => {
    const all = PRIVACY.map((s) => s.p.en).join(" ");
    expect(all).toMatch(/never store Aadhaar/i);
    expect(all).toMatch(/not affect your pension/i);
  });
});

describe("API error localisation (S-126)", () => {
  it("@E2E-141 every error key exists in both languages", () => {
    for (const k of ERR_KEYS) { expect(EN[k], k).toBeTruthy(); expect(TE[k], k).toBeTruthy(); expect(hasTelugu(TE[k])).toBe(true); }
  });
  it("@E2E-141 every code the server sends is mapped to a specific message", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "server", "api.ts"), "utf8");
    for (const c of ["missing_state", "unknown_state", "invalid_year", "invalid_type", "no_data", "missing_range", "invalid_range", "invalid_threshold", "route_not_found"]) {
      expect(src, c).toContain(`"${c}"`);
      expect(errorKey({ code: c, status: 400 }), c).not.toBe("err.generic");
    }
  });
  it("@E2E-141 raw server strings never become the message; unknown codes fall back by status", () => {
    const k = errorKey(Object.assign(new Error("Unknown state 'XX'. Valid: AP, TG"), { status: 404, code: "unknown_state" }));
    expect(k).toBe("err.unknown_state");
    expect(isErrKey(k)).toBe(true);
    expect(errorKey({ status: 0 })).toBe("err.network");
    expect(errorKey({ status: 503 })).toBe("err.internal");
    expect(errorKey({ status: 401 })).toBe("err.unauthorized");
    expect(errorKey(new Error("whatever"))).toBe("err.generic");
    expect(isErrKey("Unknown state XX")).toBe(false);
  });
});

describe("hard-coded UI labels (S-126)", () => {
  it("@E2E-141 ConstituencySearch and DataStatusPanel have no hard-coded English labels left", () => {
    for (const f of ["ConstituencySearch", "DataStatusPanel"]) {
      const src = fs.readFileSync(path.join(process.cwd(), "src", "components", `${f}.tsx`), "utf8");
      for (const w of [">Winner<", ">Party<", ">Margin<", ">Population<", ">Literacy<", "\"n/a\"", "Source: Census", "Source: ECI", "Survey pulse", "take-survey"]) expect(src, `${f} ${w}`).not.toContain(w);
    }
  });
});
