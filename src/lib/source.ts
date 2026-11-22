/** The API envelope `source` is now an object (dataset, provenance, urls, licences, attribution, asOf); older payloads had a string. */
export function sourceLabel(src: unknown, fallback = "ECI / TCPD Lok Dhaba"): string {
  if (typeof src === "string" && src.trim()) return src;
  if (src && typeof src === "object") {
    const o = src as { provenance?: unknown; dataset?: unknown };
    if (o.provenance === "TCPD") return "ECI / TCPD Lok Dhaba";
    if (typeof o.provenance === "string" && o.provenance) return o.provenance;
    if (typeof o.dataset === "string" && o.dataset) return o.dataset;
  }
  return fallback;
}

/** As-of text from the envelope (`asOf` string, or the source object's asOf). */
export function asOfLabel(env: { asOf?: unknown; source?: unknown } | null | undefined, fallback: string): string {
  if (typeof env?.asOf === "string" && env.asOf) return env.asOf;
  const s = env?.source as { asOf?: unknown } | undefined;
  return typeof s?.asOf === "string" && s.asOf ? s.asOf : fallback;
}
