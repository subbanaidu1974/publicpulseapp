import { useEffect, useState } from "react";
import { ContestantPage, LeadersPage, MembersPage, PartyProfilePage, PeopleHome, ProcessPage } from "./pages";

/** Parses `#/people/...` into path segments; anything else is the home view. */
function parse(hash: string): string[] {
  const m = /^#\/people\/?(.*)$/.exec(hash);
  return m && m[1] ? m[1].split("/").map(s => { try { return decodeURIComponent(s); } catch { return s; } }) : [];
}

export const isPeopleHash = (hash: string) => /^#\/people(\/|$)/.test(hash);

/** Hash-routed container for the people pages: #/people, /party/<code>, /candidate/<id>, /leaders, /members/<ST>/<type>, /process. */
export default function PeoplePage() {
  const [seg, setSeg] = useState<string[]>(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => { setSeg(parse(window.location.hash)); window.scrollTo?.(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const [view, a, b] = seg;
  if (view === "party" && a) return <PartyProfilePage code={a} />;
  if (view === "candidate" && a) return <ContestantPage id={a} />;
  if (view === "leaders") return <LeadersPage />;
  if (view === "members") return <MembersPage state={a ?? "AP"} type={b ?? "assembly"} />;
  if (view === "process") return <ProcessPage />;
  return <PeopleHome />;
}
