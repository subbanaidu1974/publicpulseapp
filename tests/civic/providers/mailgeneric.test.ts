import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { productionProblems } from "../../../server/civic/guards";
import { GenericHttpMailProvider, genericMailConfigFromEnv, type GenericMailConfig } from "../../../server/civic/providers/mailgeneric";
import { installProvidersFromEnv } from "../../../server/civic/providers/install";
import { getMail, isDevMailProvider, setMailProvider } from "../../../server/civic/providers/mail";
import { startGenericMailServer, type GenericMailServer } from "../../../server/civic/providers/mock/genericMailServer";
import { ProviderError, setProviderLogger } from "../../../server/civic/providers/util";

/** Mapping that matches the INVENTED simulator in providers/mock/genericMailServer.ts. Not any real vendor's mapping. */
const SIM = { authHeader: "x-mail-key", from: "noreply@example.test", requestFields: { to: "rcpt", from: "sender", subject: "subj", text: "body", idempotencyKey: "dedupe" } } satisfies Partial<GenericMailConfig>;
const RCPT = "officer.secret@dept.example.gov.in";
const CODE = "Your code is 482913-ZQ";

let sim: GenericMailServer;
let logs: string[];
let savedEnv: string | undefined;
const mk = (o: Partial<GenericMailConfig> = {}) => new GenericHttpMailProvider({ ...SIM, url: sim.url, authValue: sim.authValue, ...o });
const msg = (k?: string) => ({ to: RCPT, subject: "Confirm", text: CODE, ...(k ? { idempotencyKey: k } : {}) });

beforeEach(async () => { savedEnv = process.env.NODE_ENV; sim = await startGenericMailServer(); logs = []; setProviderLogger((l) => logs.push(l)); });
afterEach(async () => {
  setProviderLogger(null); setMailProvider(null); await sim.close();
  if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv;
});

describe("GenericHttpMailProvider against the generic mail simulator", () => {
  it("delivers one message with mapped fields, auth and Idempotency-Key header", async () => {
    await mk().send(msg("k1"));
    expect(sim.received).toHaveLength(1);
    expect(sim.received[0]).toMatchObject({ rcpt: RCPT, sender: "noreply@example.test", subj: "Confirm", body: CODE, dedupe: "k1", idempotencyHeader: "k1" });
    expect(sim.received[0].contentType).toBe("application/json");
  });

  it("supports the form format", async () => {
    await mk({ format: "form" }).send(msg("k2"));
    expect(sim.received[0]).toMatchObject({ rcpt: RCPT, body: CODE });
    expect(sim.received[0].contentType).toContain("x-www-form-urlencoded");
  });

  it("dedupes by idempotency key in process, including concurrent calls; a failed send is not remembered", async () => {
    const p = mk();
    await Promise.all([p.send(msg("dup")), p.send(msg("dup"))]);
    await p.send(msg("dup"));
    expect(sim.requests).toBe(1);
    sim.mode = "error500";
    await expect(p.send(msg("again"))).rejects.toBeInstanceOf(ProviderError);
    sim.mode = "ok";
    await p.send(msg("again"));
    expect(sim.received.filter((r) => r.dedupe === "again")).toHaveLength(1);
  });

  it("4xx and 5xx throw a ProviderError after exactly one attempt (no retry)", async () => {
    sim.mode = "reject400";
    await expect(mk().send(msg("a"))).rejects.toMatchObject({ name: "ProviderError", kind: "http", status: 400, retryable: false });
    sim.mode = "error500";
    await expect(mk().send(msg("b"))).rejects.toMatchObject({ kind: "http", status: 500 });
    expect(sim.requests).toBe(2);
  });

  it("times out after the configured deadline with a single attempt", async () => {
    sim.mode = "timeout";
    await expect(mk({ timeoutMs: 150 }).send(msg("t"))).rejects.toMatchObject({ kind: "timeout" });
    expect(sim.requests).toBe(1);
  });

  it("a wrong credential is a 401 ProviderError", async () => {
    await expect(mk({ authValue: "wrong" }).send(msg("w"))).rejects.toMatchObject({ kind: "http", status: 401 });
    expect(sim.unauthorised).toBe(1);
  });

  it("never puts the recipient or the body into errors or log output", async () => {
    const errs: string[] = [];
    for (const mode of ["reject400", "error500", "timeout"] as const) {
      sim.mode = mode;
      try { await mk({ timeoutMs: 100 }).send(msg("x" + mode)); } catch (e) { errs.push(String((e as Error).message) + JSON.stringify(e) + String((e as Error).stack?.split("\n")[0])); }
    }
    const down = new GenericHttpMailProvider({ ...SIM, url: "http://127.0.0.1:1/x", authValue: "k", fetchImpl: async () => { throw new Error(`connect failed for ${RCPT} ${CODE}`); } });
    try { await down.send(msg("net")); } catch (e) { errs.push(String((e as Error).message) + JSON.stringify(e)); }
    expect(errs).toHaveLength(4);
    const all = errs.join("\n") + "\n" + logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [RCPT, "officer.secret", "482913", CODE, sim.authValue]) expect(all).not.toContain(secret);
  });

  it("refuses an http URL in production and a missing auth value", () => {
    expect(() => mk({ authValue: "" })).toThrow(/CIVIC_MAIL_AUTH_VALUE/);
    process.env.NODE_ENV = "production";
    expect(() => mk()).toThrow(/https/);
    expect(() => new GenericHttpMailProvider({ url: "https://mail.example.test/send", authValue: "k" })).not.toThrow();
  });

  it("builds config from the environment and rejects malformed JSON at startup", () => {
    const c = genericMailConfigFromEnv({ CIVIC_MAIL_URL: "https://m.example.test", CIVIC_MAIL_AUTH_VALUE: "k", CIVIC_MAIL_FORMAT: "form", CIVIC_MAIL_REQUEST_FIELDS: '{"to":"recipient"}', CIVIC_MAIL_TIMEOUT_MS: "900", CIVIC_MAIL_FROM: "a@b.test" });
    expect(c).toMatchObject({ format: "form", requestFields: { to: "recipient" }, timeoutMs: 900, from: "a@b.test" });
    expect(new GenericHttpMailProvider(c).buildFields(msg("z"))).toMatchObject({ recipient: RCPT, idempotency_key: "z" });
    expect(() => genericMailConfigFromEnv({ CIVIC_MAIL_REQUEST_FIELDS: "[1]" })).toThrow(/JSON object/);
  });
});

describe("installProvidersFromEnv for mail", () => {
  it("installs the adapter only when CIVIC_MAIL_URL is set", () => {
    installProvidersFromEnv({});
    expect(isDevMailProvider()).toBe(true);
    installProvidersFromEnv({ CIVIC_MAIL_URL: "http://127.0.0.1:9/x", CIVIC_MAIL_AUTH_VALUE: "k" });
    expect(isDevMailProvider()).toBe(false);
    expect(getMail().name).toBe("generic-http");
  });
  it("does not replace a mail provider something else installed", () => {
    const other = { name: "vendor", send: async () => undefined };
    setMailProvider(other);
    installProvidersFromEnv({ CIVIC_MAIL_URL: "http://127.0.0.1:9/x", CIVIC_MAIL_AUTH_VALUE: "k" });
    expect(getMail()).toBe(other);
  });
  it("production problems flag a missing credential and a non-https URL", () => {
    process.env.NODE_ENV = "production";
    const keep = { u: process.env.CIVIC_MAIL_URL, v: process.env.CIVIC_MAIL_AUTH_VALUE };
    process.env.CIVIC_MAIL_URL = "http://m.example.test"; delete process.env.CIVIC_MAIL_AUTH_VALUE;
    try {
      const p = productionProblems().join(" | ");
      expect(p).toMatch(/CIVIC_MAIL_AUTH_VALUE is missing/);
      expect(p).toMatch(/CIVIC_MAIL_URL must be https/);
    } finally { for (const [k, v] of [["CIVIC_MAIL_URL", keep.u], ["CIVIC_MAIL_AUTH_VALUE", keep.v]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });
});
