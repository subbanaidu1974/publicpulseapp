import { useEffect, useRef, useState } from "react";
import { civicApi, issuesApi, type FeedParams, type Unit, type Village } from "../../api/civic";
import { useT } from "../../i18n";
import { useCategories } from "./categories";
import { useCivicT, type CivicKey } from "./civicText";
import { Btn, TextInput, inputCls } from "./ui";

type Scope = "all" | "village" | "mandal" | "district" | "constituency";
const SCOPES: Scope[] = ["all", "village", "mandal", "district", "constituency"];
const STATUSES = ["Reported", "Verified", "Assigned", "InProgress", "Resolved", "Confirmed", "Reopened"];
const scopeKey = (s: Scope): CivicKey => (s === "all" ? "c.issue.scopeAll" : (`c.issue.scope${s[0].toUpperCase()}${s.slice(1)}` as CivicKey));

/** Feed filters (S-139): free-text search plus a place (village search via /geo) and how wide to look (village, mandal, district, constituency from /geo/units). */
export default function IssueFilters({ onChange }: { onChange: (p: FeedParams) => void }) {
  const c = useCivicT();
  const { lang } = useT();
  const [q, setQ] = useState("");
  const [placeQ, setPlaceQ] = useState("");
  const [hits, setHits] = useState<Village[]>([]);
  const [place, setPlace] = useState<Village | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [scope, setScope] = useState<Scope>("all");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const { cats, label } = useCategories();
  const seq = useRef(0);
  const vName = (v: Village) => (lang === "te" ? v.nameTe ?? v.nameEn : v.nameEn);
  const uName = (u: Unit) => (lang === "te" ? u.nameTe ?? u.nameEn : u.nameEn);

  useEffect(() => {
    if (placeQ.trim().length < 2 || place) { setHits([]); return; }
    const mine = ++seq.current;
    const h = setTimeout(() => { civicApi.searchVillages(placeQ.trim()).then((v) => { if (mine === seq.current) setHits(v.slice(0, 6)); }).catch(() => { if (mine === seq.current) setHits([]); }); }, 250);
    return () => clearTimeout(h);
  }, [placeQ, place]);

  useEffect(() => {
    if (!place) { setUnits([]); return; }
    let live = true;
    issuesApi.villageScopes(place.lgd).then((u) => { if (live) setUnits(u); });
    return () => { live = false; };
  }, [place]);

  // Debounced emit of the effective filter.
  useEffect(() => {
    const h = setTimeout(() => {
      const p: FeedParams = {};
      if (q.trim()) p.q = q.trim();
      if (category) p.category = category;
      if (status) p.status = status;
      if (place && scope !== "all") {
        if (scope === "village") p.village = place.lgd;
        else { const u = units.find((x) => x.level === scope); if (u) p[scope] = u.lgd; }
      }
      onChange(p);
    }, 300);
    return () => clearTimeout(h);
  }, [q, place, scope, units, category, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const available = SCOPES.filter((s) => s === "all" || s === "village" || units.some((u) => u.level === s));
  const scoped = (s: Scope) => (s === "village" ? place && vName(place) : units.find((u) => u.level === s) && uName(units.find((u) => u.level === s)!));

  return (
    <form role="search" aria-label={c("c.issue.filters")} data-testid="issue-filters" className="space-y-2 border border-black p-3" onSubmit={(e) => e.preventDefault()}>
      <div>
        <label htmlFor="if-q" className="block text-sm font-bold">{c("c.issue.search")}</label>
        <TextInput id="if-q" data-testid="if-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="if-category" className="block text-sm font-bold">{c("c.issue.category")}</label>
          <select id="if-category" data-testid="if-category" className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{c("c.issue.anyCategory")}</option>{cats.map((k) => <option key={k.id} value={k.id}>{label(k.id)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="if-status" className="block text-sm font-bold">{c("c.issue.statusFilter")}</label>
          <select id="if-status" data-testid="if-status" className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{c("c.issue.anyStatus")}</option>{STATUSES.map((x) => <option key={x} value={x}>{c(`c.issue.s.${x}` as CivicKey)}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="if-place" className="block text-sm font-bold">{c("c.issue.place")}</label>
        <p className="text-xs">{c("c.issue.placeHelp")}</p>
        <TextInput id="if-place" data-testid="if-place" autoComplete="off" value={place ? vName(place) : placeQ} onChange={(e) => { setPlace(null); setScope("all"); setPlaceQ(e.target.value); }} />
        {hits.length > 0 && (
          <ul aria-label={c("c.issue.place")} className="border border-black bg-white">
            {hits.map((v) => (
              <li key={v.lgd}><button type="button" data-testid="if-place-option" className="w-full text-left min-h-[44px] px-3 py-2" onClick={() => { setPlace(v); setHits([]); setScope("village"); }}>{vName(v)}{v.mandal ? `, ${v.mandal}` : ""}</button></li>
            ))}
          </ul>
        )}
      </div>
      {place && (
        <div>
          <label htmlFor="if-scope" className="block text-sm font-bold">{c("c.issue.scope")}</label>
          <select id="if-scope" data-testid="if-scope" className={inputCls} value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            {available.map((s) => <option key={s} value={s}>{c(scopeKey(s))}{s !== "all" && scoped(s) ? `: ${scoped(s)}` : ""}</option>)}
          </select>
        </div>
      )}
      {(q || place || category || status) && <Btn secondary data-testid="if-clear" onClick={() => { setQ(""); setPlace(null); setPlaceQ(""); setScope("all"); setCategory(""); setStatus(""); }}>{c("c.issue.clear")}</Btn>}
    </form>
  );
}
