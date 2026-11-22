import { useCallback, useEffect, useRef, useState } from "react";
import { CivicApiError, issuesApi, type FeedParams, type Issue } from "../../api/civic";
import { useT } from "../../i18n";
import { useCivicT, type CivicKey } from "./civicText";
import { glyphFor, useCategories } from "./categories";
import IssueDetail from "./IssueDetail";
import IssueFilters from "./IssueFilters";
import { Btn } from "./ui";

export const statusLabel = (c: (k: CivicKey) => string, s: string) => { const k = `c.issue.s.${s}` as CivicKey; return c(k) === undefined || c(k) === k ? s : c(k); };

/** Public feed (S-139): filters, cursor pagination, detail view and the open-data download. Never shows reporter identity (the API has none). */
export default function IssueFeed({ refreshKey = 0 }: { refreshKey?: number }) {
  const c = useCivicT();
  const { lang } = useT();
  const { cats, label } = useCategories();
  const [filters, setFilters] = useState<FeedParams>({});
  const [items, setItems] = useState<Issue[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<Issue | null>(null);
  const gen = useRef(0);
  const [fmt, setFmt] = useState<"csv" | "ndjson">("csv");
  const [exportCursor, setExportCursor] = useState<string | null>(null);
  const [exportMsg, setExportMsg] = useState<CivicKey | null>(null);

  useEffect(() => {
    const mine = ++gen.current;
    issuesApi.feed(filters).then((p) => { if (mine === gen.current) { setItems(p.items); setCursor(p.nextCursor); setErr(false); } }).catch(() => { if (mine === gen.current) setErr(true); });
  }, [filters, refreshKey]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const p = await issuesApi.feed({ ...filters, cursor });
      setItems((cur) => { const seen = new Set((cur ?? []).map((i) => i.id)); return [...(cur ?? []), ...p.items.filter((i) => !seen.has(i.id))]; });
      setCursor(p.nextCursor);
    } catch { setErr(true); } finally { setMore(false); }
  }, [cursor, filters]);

  if (open) return <IssueDetail id={open.id} fallback={open} onBack={() => setOpen(null)} />;
  const shown = items ?? [];
  // Export: one part per click (the server caps rows per file); X-Next-Cursor says whether another part follows. Same filters as the list.
  const download = async (cursor?: string) => {
    setExportMsg(null);
    try {
      const part = await issuesApi.exportPart(fmt, filters, cursor);
      const url = URL.createObjectURL(part.blob);
      const a = document.createElement("a"); a.href = url; a.download = `issues${cursor ? "-next" : ""}.${fmt}`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setExportCursor(part.nextCursor); setExportMsg(part.nextCursor ? "c.issue.exportMore" : "c.issue.exportDone");
    } catch (e) { setExportMsg(e instanceof CivicApiError && e.status === 429 ? "c.issue.exportLimit" : "c.issue.exportFail"); }
  };
  return (
    <section data-testid="issue-feed" aria-labelledby="feed-h" className="space-y-3">
      <h2 id="feed-h" className="text-xl font-bold">{c("c.feed")}</h2>
      <IssueFilters onChange={(p) => { setFilters(p); setExportCursor(null); setExportMsg(null); }} />
      <div className="text-sm">
        <label htmlFor="if-fmt" className="block text-xs font-bold">{c("c.issue.exportFormat")}</label>
        <select id="if-fmt" data-testid="issue-export-format" className="min-h-[44px] border border-black bg-white px-2" value={fmt} onChange={(e) => { setFmt(e.target.value as "csv" | "ndjson"); setExportCursor(null); }}>
          <option value="csv">{c("c.issue.exportCsv")}</option><option value="ndjson">{c("c.issue.exportNdjson")}</option>
        </select>
        {" "}<a data-testid="issue-export" href={issuesApi.exportUrl(fmt, filters)} download onClick={(e) => { e.preventDefault(); void download(); }} className="inline-flex items-center min-h-[44px] underline font-bold">{c("c.issue.download")}</a>
        {exportCursor && <Btn secondary data-testid="issue-export-next" onClick={() => void download(exportCursor)}>{c("c.issue.exportNext")}</Btn>}
        {exportMsg && <p role="status" data-testid="issue-export-msg" className="text-xs">{c(exportMsg)}</p>}
        <p className="text-xs">{c("c.issue.downloadNote")}</p>
      </div>
      {err && <p role="alert" className="text-sm">{c("c.issue.loadFail")}</p>}
      {items && shown.length === 0 && !err && <p className="text-sm">{c("c.feedEmpty")}</p>}
      <ul className="space-y-2">
        {shown.map((i) => (
          <li key={i.id} data-testid="issue-item" className="border border-black p-3 text-sm break-words flex items-start gap-2">
            <span aria-hidden="true" className="text-2xl leading-none">{glyphFor(cats.find((k) => k.id === i.category) ?? { id: i.category })}</span>
            <div className="min-w-0 flex-1 space-y-1">
              <p><strong>{label(i.category)}</strong> <span className="text-xs" data-testid="issue-status">({statusLabel(c, i.status)})</span></p>
              {(lang === "te" ? i.textTe ?? i.text : i.text ?? i.textTe) && <p>{lang === "te" ? i.textTe ?? i.text : i.text ?? i.textTe}</p>}
              <Btn secondary data-testid="issue-open" onClick={() => setOpen(i)} aria-label={`${c("c.issue.details")}: ${label(i.category)}`}>{c("c.issue.details")}</Btn>
            </div>
          </li>
        ))}
      </ul>
      {cursor && <Btn secondary data-testid="issue-more" disabled={more} onClick={() => void loadMore()}>{c("c.issue.more")}</Btn>}
    </section>
  );
}
