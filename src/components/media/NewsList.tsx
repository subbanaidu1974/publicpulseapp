import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { mediaApi, type NewsItem, type NewsPayload } from "../../api/mediahub";
import { useT } from "../../i18n";
import { useStateCtx } from "../../state/StateContext";
import ReportButton from "./ReportButton";
import { mediaText as mt, type MediaKey } from "./mediaText";

const VIEW_KEY = "pp-news-view";
type View = "tiles" | "swipe";
const readView = (): View | null => { try { const v = sessionStorage.getItem(VIEW_KEY); return v === "tiles" || v === "swipe" ? v : null; } catch { return null; } };

/** True on a phone-sized screen (the swipe feed is the default there). */
function useIsPhone(): boolean {
  const q = "(max-width: 767px)";
  const [m, setM] = useState(() => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(q).matches);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

function useWhen(n: NewsItem) {
  const { lang } = useT();
  const outlet = (lang === "te" && n.outlet_te) || n.outlet_en;
  const when = new Date(n.published_at).toLocaleString(lang === "te" ? "te-IN" : "en-IN", { dateStyle: "medium", timeStyle: "short" });
  return { lang, outlet, when };
}

/** A link to the publisher, in a new tab, with no referrer and no opener. A click is counted as a plain number, never against a person. */
function PublisherLink({ n }: { n: NewsItem }) {
  const { lang } = useT();
  return (
    <a data-testid="news-link" href={n.link} target="_blank" rel="noopener noreferrer" className="underline text-sm font-bold inline-flex min-h-[44px] items-center"
      onClick={() => { mediaApi.click("news", n.id).catch(() => undefined); }}>{mt(lang, "m.open.pub")}</a>
  );
}

/** Click to load: nothing from YouTube is requested until the member taps. YouTube's no-cookie embed, no autoplay, no related videos from other channels. */
function YouTube({ n }: { n: NewsItem }) {
  const { lang } = useT();
  const t = (k: MediaKey) => mt(lang, k);
  const [play, setPlay] = useState(false);
  if (!n.youtube) return null;
  return (
    <div className="space-y-2" data-testid="news-yt">
      <button type="button" data-testid="news-yt-play" aria-expanded={play} onClick={() => { if (!play) mediaApi.click("news", n.id).catch(() => undefined); setPlay(!play); }} className="block border border-black px-3 py-1 text-sm font-bold min-h-[44px]">{play ? t("m.yt.hide") : t("m.yt.play")}</button>
      {play && <iframe data-testid="news-yt-frame" title={n.title} src={`https://www.youtube-nocookie.com/embed/${n.youtube}?rel=0&playsinline=1`} loading="lazy" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen" allowFullScreen className="w-full aspect-video border-0 bg-black" />}
      {!play && <p className="text-xs">{t("m.yt.note")}</p>}
    </div>
  );
}

/** A tile: outlet, time and headline, with a button that opens the snippet, the video and the report control. The publisher link is always there. */
function Tile({ n }: { n: NewsItem }) {
  const { lang, outlet, when } = useWhen(n);
  const t = (k: MediaKey) => mt(lang, k);
  const [open, setOpen] = useState(false);
  const bodyId = `news-body-${n.id}`;
  return (
    <li data-testid="news-item" data-open={open} className="border border-black/40 p-3 flex flex-col gap-2 bg-white/40 min-w-0">
      <p className="text-xs">{t("m.from")} <span data-testid="news-outlet">{outlet}</span> · <time dateTime={n.published_at}>{when}</time></p>
      <p className={`font-bold break-words ${open ? "" : "line-clamp-3"}`} data-testid="news-title">{n.title}</p>
      {open && (
        <div id={bodyId} data-testid="news-body" className="space-y-2">
          {n.snippet && <p className="text-sm break-words" data-testid="news-snippet">{n.snippet}</p>}
          <YouTube n={n} />
          <ReportButton kind="news" id={n.id} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 mt-auto">
        <button type="button" data-testid="news-expand" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen(!open)}
          className="text-sm font-bold border border-black px-3 min-h-[44px]">{open ? t("m.collapse") : t("m.expand")}</button>
        <PublisherLink n={n} />
      </div>
    </li>
  );
}

/** One full-screen story of the swipe feed: everything is on the card, nothing to open. */
function Card({ n, i, total }: { n: NewsItem; i: number; total: number }) {
  const { lang, outlet, when } = useWhen(n);
  const t = (k: MediaKey) => mt(lang, k);
  return (
    <li data-testid="news-item" data-index={i} aria-label={`${t("m.story")} ${i + 1} / ${total}`} className="snap-start snap-always h-full shrink-0 border border-black p-4 flex flex-col gap-3 bg-white overflow-hidden">
      <p className="text-xs">{t("m.from")} <span data-testid="news-outlet" className="font-bold">{outlet}</span> · <time dateTime={n.published_at}>{when}</time></p>
      <p className="font-serif text-2xl leading-snug font-bold break-words line-clamp-6" data-testid="news-title">{n.title}</p>
      {n.snippet && <p className="text-base break-words line-clamp-6" data-testid="news-snippet">{n.snippet}</p>}
      <div className="mt-auto space-y-2">
        <YouTube n={n} />
        <div className="flex flex-wrap items-center gap-x-4">
          <PublisherLink n={n} />
          <ReportButton kind="news" id={n.id} />
        </div>
      </div>
    </li>
  );
}

/** Instagram-style feed for a phone: one story per screen, swipe up for the next. Native scroll snapping, so it feels like the platform; keys and buttons do the same. */
const SWIPE_STEP = 40, TILE_STEP = 30;
function SwipeFeed({ all }: { all: NewsItem[] }) {
  const { lang } = useT();
  const t = (k: MediaKey) => mt(lang, k);
  const box = useRef<HTMLUListElement>(null);
  const [at, setAt] = useState(0);
  const [limit, setLimit] = useState(SWIPE_STEP); // only the first stories are drawn; more are added as the reader nears the end
  const items = all.slice(0, limit);
  useEffect(() => { if (at >= limit - 3 && limit < all.length) setLimit((l) => l + SWIPE_STEP); }, [at, limit, all.length]);
  const go = useCallback((d: number) => {
    const el = box.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ top: d * el.clientHeight, behavior: reduce ? "auto" : "smooth" });
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting && e.intersectionRatio > 0.6) setAt(Number((e.target as HTMLElement).dataset.index)); }, { root: el, threshold: [0.6] });
    el.querySelectorAll("[data-index]").forEach((c) => io.observe(c));
    return () => io.disconnect();
  }, [items]);
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // keys inside a card (the report form, the video) are theirs
    if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); go(1); }
    else if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); go(-1); }
  };
  return (
    <div data-testid="news-swipe" className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span data-testid="news-swipe-hint">{t("m.swipe.hint")}</span>
        <span data-testid="news-swipe-count" aria-live="off">{at + 1} / {all.length}</span>
      </div>
      <div className="relative">
        <ul ref={box} tabIndex={0} role="list" aria-label={t("m.news.h")} onKeyDown={onKey} data-testid="news-swipe-feed"
          className="h-[calc(100dvh-14rem)] min-h-[22rem] overflow-y-auto snap-y snap-mandatory overscroll-contain flex flex-col gap-3 list-none p-0 m-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-black">
          {items.map((n, i) => <Fragment key={n.id}><Card n={n} i={i} total={all.length} /></Fragment>)}
        </ul>
        <div className="absolute right-2 bottom-2 flex flex-col gap-2">
          <button type="button" data-testid="news-prev" aria-label={t("m.prev")} disabled={at === 0} onClick={() => go(-1)} className="min-h-[44px] min-w-[44px] border border-black bg-white font-bold disabled:opacity-40">↑</button>
          <button type="button" data-testid="news-next" aria-label={t("m.next")} disabled={at >= all.length - 1} onClick={() => go(1)} className="min-h-[44px] min-w-[44px] border border-black bg-white font-bold disabled:opacity-40">↓</button>
        </div>
      </div>
    </div>
  );
}

/** Daily news (S-226): headlines from sources an admin switched on after recording our permission. Each item links to its publisher. */
export default function NewsList() {
  const { lang } = useT();
  const { state } = useStateCtx();
  const t = (k: MediaKey) => mt(lang, k);
  const phone = useIsPhone();
  const [chosen, setChosen] = useState<View | null>(readView);
  const view: View = phone ? (chosen ?? "swipe") : "tiles";
  const pick = (v: View) => { setChosen(v); try { sessionStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
  const [data, setData] = useState<NewsPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState(TILE_STEP);
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
  const rest = data.items.filter((n) => !top.has(n.id));
  const stale = data.sources.filter((s) => s.stale);
  const grid = "grid gap-3 sm:grid-cols-2 lg:grid-cols-3 items-start list-none p-0 m-0";
  return (
    <div className="space-y-4" data-testid="news-list" data-view={view}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-bold">{t("m.news.h")}</h3>
        {phone && (
          <div role="group" aria-label={t("m.view")} className="flex">
            {(["swipe", "tiles"] as const).map((v) => (
              <button key={v} type="button" data-testid={`news-view-${v}`} aria-pressed={view === v} onClick={() => pick(v)}
                className={`min-h-[44px] px-3 text-sm font-bold border border-black ${view === v ? "bg-black text-white" : ""}`}>{t(v === "swipe" ? "m.view.swipe" : "m.view.tiles")}</button>
            ))}
          </div>
        )}
      </div>
      <p className="text-xs" data-testid="news-pubnote">{t("m.pubnote")}</p>
      {stale.length > 0 && <p role="status" data-testid="news-stale" className="border border-black p-2 text-sm font-bold">{t("m.stale")} {stale.map((s) => (lang === "te" && s.name_te) || s.name_en).join(", ")}</p>}
      {view === "swipe" ? <SwipeFeed all={[...data.digest, ...rest]} /> : (
        <>
          {data.digest.length > 0 && (
            <section aria-labelledby="news-top-h" className="space-y-2" data-testid="news-digest">
              <h4 id="news-top-h" className="font-bold">{t("m.top")}</h4>
              <ul className={grid}>{data.digest.map((n) => <Fragment key={n.id}><Tile n={n} /></Fragment>)}</ul>
            </section>
          )}
          {rest.length > 0 && (
            <section aria-labelledby="news-more-h" className="space-y-2">
              <h4 id="news-more-h" className="font-bold">{t("m.more")}</h4>
              <ul className={grid}>{rest.slice(0, shown).map((n) => <Fragment key={n.id}><Tile n={n} /></Fragment>)}</ul>
              {rest.length > shown && <button type="button" data-testid="news-show-more" onClick={() => setShown(shown + TILE_STEP)} className="border border-black px-4 min-h-[44px] font-bold text-sm">{t("m.showmore")} ({rest.length - shown})</button>}
            </section>
          )}
        </>
      )}
    </div>
  );
}
