import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import { identityRouter } from "../../../server/civic/identity/routes";

/** Start the identity router on an ephemeral port. */
export async function serveIdentity(): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use("/api/v1/civic/identity", identityRouter);
  let server!: Server;
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic/identity` };
}

export interface Reply { status: number; json: Record<string, any> }
export function caller(base: string) {
  return async (method: string, p: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Reply> => {
    const r = await fetch(base + p, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : {} };
  };
}

/** Full sign-up through the HTTP API (needs CIVIC_EXPOSE_DEV_OTP=1). */
export async function signupVia(call: ReturnType<typeof caller>, phone: string, pin = "4821") {
  const rq = await call("POST", "/signup/request", { phone });
  expect(rq.status, JSON.stringify(rq.json)).toBe(200);
  const v = await call("POST", "/signup/verify", { phone, otp: rq.json.dev_otp, pin });
  expect(v.status, JSON.stringify(v.json)).toBe(201);
  return { token: v.json.token as string, id: v.json.person.id as string, person: v.json.person as Record<string, any> };
}
