import { useEffect, useState } from "react";
import { useAT } from "./analyticsText";
import { analyticsHref } from "./common";
import TurnoutPage from "./TurnoutPage";
import ComparePage from "./ComparePage";
import HistoryPage from "./HistoryPage";
import PartiesPage from "./PartiesPage";

export const isAnalyticsHash = (hash: string) => /^#\/analytics\/(turnout|compare|history|parties)\/?$/.test(hash);
const parse = (hash: string) => (/^#\/analytics\/([a-z]+)/.exec(hash)?.[1] ?? "turnout") as "turnout" | "compare" | "history" | "parties";

/** Quiet link strip placed above the legacy analytics page so the new pages are reachable without typing a hash. */
export function AnalyticsLinks() {
  const { a } = useAT();
  return (
    <nav data-testid="analytics-links" aria-label={a("an2.title")} className="mb-6 border border-black p-3 font-sans text-xs space-y-1">
      <strong className="block uppercase tracking-widest text-[10px]">{a("an2.title")}</strong>
      <ul className="list-disc pl-5">
        <li><a className="underline inline-block py-1" data-testid="link-turnout" href={analyticsHref("turnout")}>{a("an2.link.turnout")}</a></li>
        <li><a className="underline inline-block py-1" data-testid="link-compare" href={analyticsHref("compare")}>{a("an2.link.compare")}</a></li>
        <li><a className="underline inline-block py-1" data-testid="link-history" href={analyticsHref("history")}>{a("an2.link.history")}</a></li>
        <li><a className="underline inline-block py-1" data-testid="link-parties" href={analyticsHref("parties")}>{a("an2.link.parties")}</a></li>
      </ul>
    </nav>
  );
}

/** Hash-routed container: #/analytics/turnout, compare, history and parties. */
export default function AnalyticsRoot() {
  const { a } = useAT();
  const [page, setPage] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => { setPage(parse(window.location.hash)); window.scrollTo?.(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const tabs = [["turnout", "an2.nav.turnout"], ["compare", "an2.nav.compare"], ["history", "an2.nav.history"], ["parties", "an2.nav.parties"]] as const;
  return (
    <div className="space-y-6" data-testid="analytics-root">
      <header className="border-b border-black pb-3 space-y-2 font-sans">
        <a href="#/analytics" data-testid="analytics-back" className="text-xs underline">{a("an2.legacy")}</a>
        <h1 className="font-serif text-3xl sm:text-4xl">{a("an2.title")}</h1>
        <p className="text-sm max-w-3xl">{a("an2.intro")}</p>
        <nav className="flex flex-wrap gap-2" aria-label={a("an2.title")}>
          {tabs.map(([id, k]) => (
            <a key={id} data-testid={`an-nav-${id}`} href={analyticsHref(id)} aria-current={page === id ? "page" : undefined}
              className={`border border-black px-3 py-1 text-[11px] uppercase tracking-widest font-black ${page === id ? "bg-black text-white" : "bg-transparent"}`}>{a(k)}</a>
          ))}
        </nav>
      </header>
      {page === "turnout" && <TurnoutPage />}
      {page === "compare" && <ComparePage />}
      {page === "history" && <HistoryPage />}
      {page === "parties" && <PartiesPage />}
    </div>
  );
}
