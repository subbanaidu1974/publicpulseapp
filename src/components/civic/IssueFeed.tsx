import { useEffect, useState } from "react";
import { civicApi, type Issue } from "../../api/civic";
import { CATEGORY_IDS, useCivicT, type CivicKey } from "./civicText";

export default function IssueFeed({ refreshKey = 0 }: { refreshKey?: number }) {
  const c = useCivicT();
  const [items, setItems] = useState<Issue[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    civicApi.listIssues().then((i) => { if (live) { setItems(i); setErr(false); } }).catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [refreshKey]);
  const label = (cat: string) => ((CATEGORY_IDS as readonly string[]).includes(cat) ? c(`c.cat.${cat}` as CivicKey) : cat);
  return (
    <section data-testid="issue-feed" aria-labelledby="feed-h" className="space-y-2">
      <h2 id="feed-h" className="text-xl font-bold">{c("c.feed")}</h2>
      {err && <p role="alert" className="text-sm">{c("c.error")}</p>}
      {items && items.length === 0 && <p className="text-sm">{c("c.feedEmpty")}</p>}
      <ul className="space-y-2">
        {(items ?? []).map((i) => (
          <li key={i.id} data-testid="issue-item" className="border border-black p-3 text-sm break-words">
            <strong>{label(i.category)}</strong> <span className="text-xs">({i.status})</span>
            {i.text && <p>{i.text}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
