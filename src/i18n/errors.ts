import type { Key } from "./index";

/** API error codes the server sends (server/api.ts) mapped to i18n keys. Unknown codes fall back by HTTP status. */
const CODE_KEYS: Record<string, Key> = {
  network: "err.network",
  missing_state: "err.missing_state",
  unknown_state: "err.unknown_state",
  invalid_year: "err.invalid_year",
  invalid_type: "err.invalid_type",
  no_data: "err.no_data",
  missing_range: "err.missing_range",
  invalid_range: "err.invalid_range",
  invalid_threshold: "err.invalid_threshold",
  route_not_found: "err.route_not_found",
  bad_request: "err.bad_request",
  internal: "err.internal",
};

export const ERR_KEYS: Key[] = [...new Set<Key>([...Object.values(CODE_KEYS), "err.unauthorized", "err.forbidden", "err.rate", "err.generic"])];

export function isErrKey(s: string): s is Key {
  return (ERR_KEYS as string[]).includes(s);
}

/** Turn any thrown value into an i18n key. Raw server strings are never returned, so they can never reach the screen. */
export function errorKey(e: unknown): Key {
  const err = e as { code?: unknown; status?: unknown } | null;
  const code = typeof err?.code === "string" ? err.code : "";
  if (code && CODE_KEYS[code]) return CODE_KEYS[code];
  const status = typeof err?.status === "number" ? err.status : -1;
  if (status === 0) return "err.network";
  if (status === 401) return "err.unauthorized";
  if (status === 403) return "err.forbidden";
  if (status === 404) return "err.no_data";
  if (status === 429) return "err.rate";
  if (status >= 500) return "err.internal";
  if (status >= 400) return "err.bad_request";
  return "err.generic";
}
