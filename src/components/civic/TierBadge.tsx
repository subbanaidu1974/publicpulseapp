import type { ReactNode } from "react";
import { useCivicT, type CivicKey } from "./civicText";

export type Tier = "T0" | "T1" | "T2";

const ICON: Record<Tier, ReactNode> = {
  // phone
  T0: <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></>,
  // house / pin
  T1: <><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></>,
  // house with check
  T2: <><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M8.5 14.5l2.5 2.5 4.5-5" /></>,
};

/** Icon-led trust badge. The tier is always written out in plain words next to a decorative icon (never colour alone). */
export default function TierBadge({ tier, withHint = false }: { tier: string | undefined; withHint?: boolean }) {
  const c = useCivicT();
  const t: Tier = tier === "T1" || tier === "T2" ? tier : "T0";
  return (
    <div data-testid="tier-badge" data-tier={t} role="group" aria-label={`${c("c.tier.label")}: ${c(`c.tier.${t}` as CivicKey)}`} className="inline-flex items-start gap-3 border border-black bg-[#FAF8F5] p-3 max-w-md">
      <svg aria-hidden="true" focusable="false" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-black">{ICON[t]}</svg>
      <div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-wide">{c("c.tier.label")}</p>
        <p data-testid="tier-label" className="text-base font-bold break-words">{c(`c.tier.${t}` as CivicKey)}</p>
        {withHint && <p className="text-xs mt-1">{c(`c.tier.d${t.slice(1)}` as CivicKey)}</p>}
      </div>
    </div>
  );
}
