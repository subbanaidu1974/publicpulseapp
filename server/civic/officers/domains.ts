/**
 * Official e-mail domain registry (S-141). The allow-list lives in data/civic/officer-domains.json (CIVIC_OFFICER_DOMAINS, a comma
 * list, replaces it for ops and tests). The check is automated and strict: ASCII only (no look-alike letters), exactly one "@", and
 * the domain must equal an allow-list entry or be a subdomain of one on a label boundary ("evilgov.in" and "gov.in.example.com" fail).
 * Passing the domain check proves only that the address is on an allowed domain. It does not prove the person owns it or holds the
 * post; the letter check by two admins covers that (docs/OFFICERS.md).
 */
import fs from "node:fs";
import path from "node:path";

export interface OfficerDomain { domain: string; body_en: string; body_te: string }

let cache: { file: string; list: OfficerDomain[] } | null = null;
const registryFile = () => path.resolve(process.cwd(), "data/civic/officer-domains.json");

export function officerDomains(): OfficerDomain[] {
  const env = process.env.CIVIC_OFFICER_DOMAINS;
  if (env !== undefined && env.trim()) return env.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean).map((domain) => ({ domain, body_en: domain, body_te: domain }));
  const f = registryFile();
  if (cache?.file === f) return cache.list;
  let list: OfficerDomain[];
  try { list = (JSON.parse(fs.readFileSync(f, "utf8")) as { domains?: OfficerDomain[] }).domains ?? []; } catch { list = []; } // fail closed: no registry, no applications
  cache = { file: f, list: list.map((d) => ({ ...d, domain: String(d.domain).toLowerCase() })) };
  return cache.list;
}

const EMAIL = /^[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+)$/;

export type DomainCheck = { ok: true; email: string; domain: string; matched: string } | { ok: false; reason: "bad_email" | "domain_not_allowed" | "registry_empty" };

/** Automated domain check of an official e-mail address. */
export function checkOfficialEmail(raw: string): DomainCheck {
  const email = String(raw ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[\x21-\x7e]+$/.test(email)) return { ok: false, reason: "bad_email" };
  const m = EMAIL.exec(email);
  if (!m) return { ok: false, reason: "bad_email" };
  const domain = m[1];
  const list = officerDomains();
  if (!list.length) return { ok: false, reason: "registry_empty" };
  const hit = list.find((d) => domain === d.domain || domain.endsWith("." + d.domain));
  return hit ? { ok: true, email, domain, matched: hit.domain } : { ok: false, reason: "domain_not_allowed" };
}
