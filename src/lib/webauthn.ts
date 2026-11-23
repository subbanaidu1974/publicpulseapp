/**
 * Browser WebAuthn helpers for the notification sender console (DESIGN_2028 3.8 item 4).
 * The server (server/civic/notify/webauthn.ts) sends options with base64url strings and verifies the credential as
 * base64url strings; the browser API wants ArrayBuffers. This file only converts and classifies failures: it never decides
 * anything, and it never keeps a key, a challenge or an assertion.
 */

export const toB64u = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const fromB64u = (s: string): ArrayBuffer => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

export const webauthnSupported = (): boolean => {
  try { return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials && typeof navigator.credentials.create === "function"; } catch { return false; }
};

export type WebAuthnFailure = "unsupported" | "cancelled" | "already_registered" | "insecure_context" | "failed";
export class WebAuthnClientError extends Error { constructor(public kind: WebAuthnFailure, m?: string) { super(m ?? kind); } }

/** Map a DOMException to a failure the UI can explain in plain words. */
export function classify(e: unknown): WebAuthnClientError {
  if (e instanceof WebAuthnClientError) return e;
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "AbortError") return new WebAuthnClientError("cancelled");
  if (name === "InvalidStateError") return new WebAuthnClientError("already_registered");
  if (name === "SecurityError") return new WebAuthnClientError("insecure_context");
  if (name === "NotSupportedError") return new WebAuthnClientError("unsupported");
  return new WebAuthnClientError("failed");
}

export interface RegistrationOptionsDto {
  challenge: string; rp: { id: string; name: string }; user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[]; attestation?: AttestationConveyancePreference; timeout?: number;
  authenticatorSelection?: AuthenticatorSelectionCriteria; excludeCredentials?: { type: "public-key"; id: string }[];
}
export interface AssertionOptionsDto {
  challenge: string; rpId: string; timeout?: number; userVerification?: UserVerificationRequirement;
  allowCredentials: { type: "public-key"; id: string }[]; message_hash?: string;
}
export interface RegistrationCredentialDto { id: string; rawId: string; type: string; response: { clientDataJSON: string; attestationObject: string } }
export interface AssertionDto { id: string; rawId: string; type: string; response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string } }

/** navigator.credentials.create with the server's options; returns the credential in the shape the server verifies. */
export async function createCredential(o: RegistrationOptionsDto): Promise<RegistrationCredentialDto> {
  if (!webauthnSupported()) throw new WebAuthnClientError("unsupported");
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: fromB64u(o.challenge), rp: o.rp, user: { id: fromB64u(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: o.pubKeyCredParams, attestation: o.attestation, timeout: o.timeout, authenticatorSelection: o.authenticatorSelection,
        excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ type: c.type, id: fromB64u(c.id) })),
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new WebAuthnClientError("cancelled");
    const r = cred.response as AuthenticatorAttestationResponse;
    return { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject) } };
  } catch (e) { throw classify(e); }
}

/** navigator.credentials.get with the server's challenge (which is bound to the message hash); returns the assertion the server verifies. */
export async function getAssertion(o: AssertionOptionsDto): Promise<AssertionDto> {
  if (!webauthnSupported()) throw new WebAuthnClientError("unsupported");
  try {
    const cred = (await navigator.credentials.get({
      publicKey: { challenge: fromB64u(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification, allowCredentials: o.allowCredentials.map((c) => ({ type: c.type, id: fromB64u(c.id) })) },
    })) as PublicKeyCredential | null;
    if (!cred) throw new WebAuthnClientError("cancelled");
    const r = cred.response as AuthenticatorAssertionResponse;
    return { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), ...(r.userHandle ? { userHandle: toB64u(r.userHandle) } : {}) } };
  } catch (e) { throw classify(e); }
}
