import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { productionProblems } from "../../../server/civic/guards";
import { startGenericSmsServer } from "../../../server/civic/providers/mock/genericSmsServer";
import { GenericHttpSmsProvider, GenericHttpSmsTransport, genericSmsConfigFromEnv, getPath, type GenericSmsConfig } from "../../../server/civic/providers/smsgeneric";
import { createSmsReceiptRouter, setSmsGateway, type SmsGatewayOpts } from "../../../server/civic/providers/sms";
import { runSmsProviderContract, type SmsHarness } from "./contract/sms.contract";

/** Mapping that matches the INVENTED simulator in providers/mock/genericSmsServer.ts. Not any real vendor's mapping. */
const SIM_MAPPING = {
  authHeader: "x-gw-key",
  entityId: "ENT-1",
  requestFields: { to: "mobile", text: "message", sender: "senderid", templateId: "dlt_te_id", entityId: "dlt_pe_id", reference: "ref" },
  staticFields: { unicode: 1 },
  responsePaths: { id: "data.id", status: "data.state", cost: "data.price", currency: "data.cur" },
  receiptPaths: { list: "dlr", id: "id", status: "state", error: "err" },
} satisfies Partial<GenericSmsConfig>;

runSmsProviderContract("GenericHttpSmsProvider + generic gateway simulator", async (o: SmsGatewayOpts): Promise<SmsHarness> => {
  const sim = await startGenericSmsServer();
  const app = express();
  app.use("/sms-receipt", createSmsReceiptRouter());
  let srv!: Server;
  await new Promise<void>((r) => { srv = app.listen(0, "127.0.0.1", r); });
  const cb = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/sms-receipt`;
  const provider = new GenericHttpSmsProvider({ ...SIM_MAPPING, url: sim.url, authValue: sim.authValue, receiptSecret: sim.receiptSecret, callbackUrl: cb }, o);
  setSmsGateway(provider);
  return {
    provider,
    setMode: (m) => { sim.mode = m; },
    received: () => sim.received.map((r) => ({ to: r.to, text: r.text, idempotencyKey: r.reference, templateId: null as string | null, dltTemplateId: r.dltTemplateId, senderId: r.sender, messageId: r.messageId })).map((r) => ({ ...r, templateId: r.dltTemplateId === "DLT-OTP-1" ? "otp" : r.dltTemplateId === "DLT-TE-1" ? "te_notice" : null })),
    requests: () => sim.requests,
    deliverReceipt: (id, status, err) => sim.sendReceipt(cb, [{ id, state: status, ...(err ? { err } : {}) }]),
    deliverForgedReceipt: (id, status) => sim.sendReceipt(cb, [{ id, state: status }], { secret: "wrong-secret" }),
    setVendorPrice: (p) => { sim.price = p; },
    close: async () => { setSmsGateway(null); await sim.close(); srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r())); },
  };
});

describe("generic SMS gateway adapter (S-63)", () => {
  const base: GenericSmsConfig = { url: "http://127.0.0.1:9/x", authValue: "k" };
  const msg = { idempotencyKey: "k1", to: "+919876501234", text: "hi", senderId: "PPULSE", template: { id: "otp", dltTemplateId: "DLT-1", language: "en", category: "otp" as const }, variables: {} };

  it("@E2E-78 field mapping: custom names, entity id, static fields; omitted values are not sent", () => {
    const t = new GenericHttpSmsTransport({ ...base, ...SIM_MAPPING });
    expect(t.buildFields(msg)).toEqual({ unicode: 1, mobile: "+919876501234", message: "hi", senderid: "PPULSE", dlt_te_id: "DLT-1", dlt_pe_id: "ENT-1", ref: "k1" });
    expect(new GenericHttpSmsTransport(base).buildFields({ ...msg, template: null, senderId: undefined })).toEqual({ to: "+919876501234", text: "hi", reference: "k1" });
  });

  it("@E2E-78 form encoding and the auth header go out as configured", async () => {
    let seen: { headers: Record<string, string>; body: string } | null = null;
    const t = new GenericHttpSmsTransport({ ...base, format: "form", authHeader: "apikey", fetchImpl: async (_u, i) => { seen = { headers: i.headers, body: i.body }; return { status: 200, text: async () => JSON.stringify({ message_id: "m1" }) }; } });
    expect(await t.submit(msg, { timeoutMs: 100 })).toMatchObject({ messageId: "m1", status: "queued" });
    expect(seen!.headers.apikey).toBe("k");
    expect(seen!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(seen!.body).get("dlt_template_id")).toBe("DLT-1");
  });

  it("@E2E-78 receipts: with no secret or token configured every receipt is refused; a static token works; paths are safe", () => {
    expect(new GenericHttpSmsTransport(base).verifyReceipt("{}", {})).toBe(false);
    const t = new GenericHttpSmsTransport({ ...base, receiptToken: "tok", receiptTokenHeader: "x-dlr" });
    expect(t.verifyReceipt("{}", { "x-dlr": "tok" })).toBe(true);
    expect(t.verifyReceipt("{}", { "x-dlr": "nope" })).toBe(false);
    expect(t.verifyReceipt("{}", {})).toBe(false);
    expect(getPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(getPath({}, "__proto__.x")).toBeUndefined();
    expect(getPath({ a: 1 }, "toString")).toBeUndefined();
  });

  it("@E2E-78 default neutral receipt shape parses; unknown statuses and oversized lists are dropped or refused", () => {
    const t = new GenericHttpSmsTransport(base);
    expect(t.parseReceipt(JSON.stringify({ receipts: [{ message_id: "a", status: "DELIVRD", error_code: "X" }, { message_id: "b", status: "???" }] }))).toEqual([{ messageId: "a", status: "delivered", errorCode: "X" }]);
    expect(() => t.parseReceipt("nope")).toThrow();
    expect(() => t.parseReceipt(JSON.stringify({ receipts: new Array(501).fill({}) }))).toThrow();
  });

  it("@E2E-78 config guards: https in production, credential required, malformed JSON config fails at startup", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try { expect(() => new GenericHttpSmsTransport({ ...base, url: "http://gw.example/send" })).toThrow(/https/); } finally { process.env.NODE_ENV = prev; }
    expect(() => new GenericHttpSmsTransport({ ...base, authValue: "" })).toThrow(/AUTH_VALUE/);
    expect(() => genericSmsConfigFromEnv({ CIVIC_SMSGW_URL: "https://x", CIVIC_SMSGW_AUTH_VALUE: "k", CIVIC_SMSGW_REQUEST_FIELDS: "{bad" })).toThrow(/JSON object/);
    expect(genericSmsConfigFromEnv({ CIVIC_SMSGW_URL: "https://x", CIVIC_SMSGW_AUTH_VALUE: "k", CIVIC_SMSGW_FORMAT: "form", CIVIC_SMSGW_RESPONSE_PATHS: '{"id":"data.id"}' })).toMatchObject({ format: "form", responsePaths: { id: "data.id" } });
  });

  describe("production guards", () => {
    const keys = ["CIVIC_SMSGW_URL", "CIVIC_SMSGW_AUTH_VALUE", "CIVIC_SMSGW_RECEIPT_SECRET", "CIVIC_SMSGW_RECEIPT_TOKEN"];
    afterEach(() => { for (const k of keys) delete process.env[k]; });
    it("@E2E-78 a half-configured or plain-http generic gateway is a production problem", () => {
      process.env.CIVIC_SMSGW_URL = "http://gw.example/send";
      const p = productionProblems().join(" ");
      expect(p).toMatch(/CIVIC_SMSGW_AUTH_VALUE is missing/);
      expect(p).toMatch(/neither CIVIC_SMSGW_RECEIPT_SECRET nor CIVIC_SMSGW_RECEIPT_TOKEN/);
      expect(p).toMatch(/CIVIC_SMSGW_URL must be https/);
      process.env.CIVIC_SMSGW_URL = "https://gw.example/send"; process.env.CIVIC_SMSGW_AUTH_VALUE = "k"; process.env.CIVIC_SMSGW_RECEIPT_TOKEN = "t";
      expect(productionProblems().join(" ")).not.toMatch(/CIVIC_SMSGW/);
    });
  });
});
