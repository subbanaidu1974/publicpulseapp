import { Fragment, useEffect, useState } from "react";
import { mediaApi, type NewsItem, type NewsPayload } from "../../api/mediahub";
import { useT } from "../../i18n";
import { useStateCtx } from "../../state/StateContext";
import ReportButton from "./ReportButton";
import { mediaText as mt, type MediaKey } from "./mediaText";

function Item({ n }: { n: NewsItem }) {
  const { lang } = useT();
  const t = (k: MediaKey) => mt(lang, k);
  const outlet = (lang === "te" && n.outlet_te) || n.outlet_en;
  return (
    <li data-testid="news-item" className="border border-black/40 p-3 space-y-1">
      <p className="font-bold break-words" data-testid="news-title">{n.title}</p>
      <p className="text-xs">{t("m.from")} <span data-testid="news-outlet">{outlet}</span> · <time dateTime={n.published_at}>{new Date(n.published_at).toLocaleString(lang === "te" ? "te-IN" : "en-IN", { dateStyle: "medium", timeStyle: "short" })}</time></p>
      {n.snippet && <p className="text-sm break-words">{n.snippet}</p>}
      <p>
        {/* A link to the publisher, in a new tab, with no referrer and no opener. A click is counted as a plain number, never against a person. */}
        <a data-testid="news-link" href={n.link} target="_blank" rel="noopener noreferrer" className="underline text-sm font-bold inline-flex min-h-[44px] items-center"
          onClick={() => { mediaApi.click("news", n.id).catch(() => undefined); }}>{t("m.open.pub")}</a>
      </p>
      <ReportButton kind="news" id={n.id} />
    </li>
  );
}

/** Daily news (S-226): headlines from sources an admin switched on after recording our permission. Each item links to its publisher. */
export default function NewsList() {
  const { lang } = useT();
  const { state } = useStateCtx();
  const t = (k: MediaKey) => mt(lang, k);
  const [data, setData] = useState<NewsPayload | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => mediaApi.news(state).then((d) => { if (live) { setData(d); setFailed(false); } }).catch(() => { if (live) setFailed(true); });
    load();
    const timer = window.setInterval(load, 5 * 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [state]);
  if (failed && !data) return <p role="alert" data-testid="news-fail" className="text-sm font-bold">{t("m.error.remote")}</p>;
  if (!data) return <p role="status" className="text-sm">…</p>;
  if (!data.items.length) return (
    <div className="space-y-2" data-testid="media-news-empty">
      <h3 className="text-lg font-bold">{t("m.news.h")}</h3>
      <p className="text-sm">{t("m.news.none")}</p>
    </div>
  );
  const top = new Set(data.digest.map((d) => d.id));
  const stale = data.sources.filter((s) => s.stale);
  return (
    <div className="space-y-4" data-testid="news-list">
      <h3 className="text-lg font-bold">{t("m.news.h")}</h3>
      <p className="text-xs" data-testid="news-pubnote">{t("m.pubnote")}</p>
      {stale.length > 0 && <p role="status" data-testid="news-stale" className="border border-black p-2 text-sm font-bold">{t("m.stale")} {stale.map((s) => (lang === "te" && s.name_te) || s.name_en).join(", ")}</p>}
      {data.digest.length > 0 && (
        <section aria-labelledby="news-top-h" className="space-y-2" data-testid="news-digest">
          <h4 id="news-top-h" className="font-bold">{t("m.top")}</h4>
          <ul className="space-y-2">{data.digest.map((n) => <Fragment key={n.id}><Item n={n} /></Fragment>)}</ul>
        </section>
      )}
      {data.items.some((n) => !top.has(n.id)) && (
        <section aria-labelledby="news-more-h" className="space-y-2">
          <h4 id="news-more-h" className="font-bold">{t("m.more")}</h4>
          <ul className="space-y-2">{data.items.filter((n) => !top.has(n.id)).map((n) => <Fragment key={n.id}><Item n={n} /></Fragment>)}</ul>
        </section>
      )}
    </div>
  );
}
