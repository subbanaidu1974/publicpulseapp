import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CivicApiError } from "../../../api/civic";
import { useCivicT, type CivicKey } from "../civicText";
import { Btn } from "../ui";

export type LoadState = "loading" | "ok" | "401" | "403" | "fail";

export const stateOf = (e: unknown): LoadState => (e instanceof CivicApiError ? (e.status === 401 ? "401" : e.status === 403 ? "403" : "fail") : "fail");

/** Load data for a console panel. The server is the only authority: a 401/403 from the API replaces the panel with an explanation, whatever the client believes about roles. */
export function useGuarded<T>(load: () => Promise<T>): { data: T | null; state: LoadState; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [n, setN] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, [n]);
  useEffect(() => {
    let live = true;
    setState((s) => (s === "ok" ? s : "loading"));
    run().then((d) => { if (live) { setData(d); setState("ok"); } }).catch((e) => { if (live) setState(stateOf(e)); });
    return () => { live = false; };
  }, [run]);
  return { data, state, reload: () => setN((x) => x + 1) };
}

/** Renders the explanation for a non-ok state, or the children. */
export function Gate({ state, onRetry, children }: { state: LoadState; onRetry?: () => void; children: ReactNode }) {
  const c = useCivicT();
  if (state === "loading") return <p role="status" data-testid="gate-loading" className="text-sm">{c("c.cons.checking")}</p>;
  if (state === "401" || state === "403") return <p role="alert" data-testid={`gate-${state}`} className="text-sm font-bold">{c(state === "401" ? "c.cons.401" : "c.cons.403")}</p>;
  if (state === "fail") return (
    <div className="space-y-2"><p role="alert" data-testid="gate-fail" className="text-sm font-bold">{c("c.cons.fail")}</p>{onRetry && <Btn secondary onClick={onRetry}>{c("c.cons.refresh")}</Btn>}</div>
  );
  return <>{children}</>;
}

/** Message for a failed action. */
export function actionError(e: unknown, c: (k: CivicKey) => string, forbidden: CivicKey = "c.cons.403"): string {
  if (e instanceof CivicApiError) { if (e.status === 401) return c("c.cons.401"); if (e.status === 403) return c(forbidden); }
  return c("c.error");
}

export const pct = (v?: number) => (v === undefined ? "-" : `${Math.round(v * 1000) / 10}%`);

/** Server error `code` (body.code), falling back to the error text. */
export const errCode = (e: unknown): string => (e instanceof CivicApiError ? String((e.body as { code?: unknown }).code ?? e.code) : "");

/** Message for a failed admin action (second-factor and dual-control errors are explained, never swallowed). */
export function adminError(e: unknown, c: (k: CivicKey) => string): string {
  if (e instanceof CivicApiError) {
    const code = errCode(e);
    const map: Record<string, CivicKey> = { dual_control: "c.adm.errDual", mfa_required: "c.adm.errTotp", mfa_invalid: "c.adm.errTotpBad", mfa_enrol_required: "c.adm.errEnrol", request_expired: "c.adm.errExpired", last_admin: "c.adm.errLastAdmin", self_grant: "c.adm.errSelf" };
    if (map[code]) return c(map[code]);
    if (e.status === 429) return c("c.adm.errRate");
    if (e.status === 404) return c("c.adm.errPerson");
    if (e.status === 409) return c("c.adm.errDup");
  }
  return actionError(e, c);
}
