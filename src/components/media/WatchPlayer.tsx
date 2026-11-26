import { useEffect, useMemo, useRef, useState } from "react";
import { mediaApi, type NewsItem } from "../../api/mediahub";
import { videocastApi, type VideoItem } from "../../api/videocast";
import { useT } from "../../i18n";
import { useStateCtx } from "../../state/StateContext";
import { mediaText as mt, type MediaKey } from "./mediaText";
import { buildPlaylist, stepEntry, type WatchEntry } from "./playerLogic";

type Filter = "all" | "own" | "youtube";

/** A drawn tile, not a picture from YouTube: loading YouTube's thumbnails would contact YouTube before anyone chose to play. */
function Tile({ e, big }: { e: WatchEntry; big?: boolean }) {
  return (
    <span aria-hidden="true" className={`relative grid shrink-0 place-items-center overflow-hidden rounded-xl text-white ${big ? "w-full aspect-video" : "w-[168px] aspect-video"} ${e.kind === "own" ? "bg-gradient-to-br from-neutral-900 to-neutral-600" : "bg-gradient-to-br from-red-900 to-neutral-800"}`}>
      <span className="grid h-9 w-9 place-items-center rounded-full bg-black/60"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z" /></svg></span>
      <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[10px] font-bold">{e.kind === "own" ? (e.media === "audio" ? "♪" : "▶") : "YouTube"}</span>
    </span>
  );
}

/**
 * Watch tab, laid out like a video site's watch page: a large rounded stage with the title, the channel row and a description box under it, and a list of
 * related videos with filter chips beside it (below it on a phone). The list is our own approved videos (signed-in members) plus YouTube videos from news
 * sources an admin switched on. Own videos play from their file; YouTube videos load only YouTube's no-cookie embed once a row is chosen.
 * No recommendations, no autoplay of the next video, nothing remembered about what a person watched.
 */
export default function WatchPlayer({ own }: { own: VideoItem[] }) {
  const { lang } = useT();
  const { state } = useStateCtx();
  const t = (k: MediaKey) => mt(lang, k);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [key, setKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [err, setErr] = useState(false);
  const counted = useRef<string | null>(null);
  useEffect(() => { let live = true; mediaApi.news(state).then((d) => { if (live) setNews(d.items); }).catch(() => undefined); return () => { live = false; }; }, [state]);
  const when = (iso: string) => new Date(iso).toLocaleString(lang === "te" ? "te-IN" : "en-IN", { dateStyle: "medium", timeStyle: "short" });
  const list = useMemo(() => buildPlaylist(
    own.map((v): WatchEntry => ({ key: "own:" + v.id, kind: "own", title: (lang === "te" && v.title_te) || v.title_en, by: v.credit, src: v.media_url, media: v.kind, note: (lang === "te" && v.note_te) || v.note_en, when: v.live_at ? when(v.live_at) : null })),
    news.filter((n) => n.youtube).map((n): WatchEntry => ({ key: "yt:" + n.youtube, kind: "youtube", title: n.title, by: (lang === "te" && n.outlet_te) || n.outlet_en, src: n.youtube!, note: n.snippet, when: when(n.published_at) })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [own, news, lang]);
  const shown = list.filter((e) => filter === "all" || e.kind === filter);
  const cur = list.find((e) => e.key === key) ?? null;
  const choose = (e: WatchEntry | null) => { setErr(false); setKey(e ? e.key : null); };
  const chip = (f: Filter, label: string) => (
    <button key={f} type="button" data-testid={`wp-chip-${f}`} aria-pressed={filter === f} onClick={() => setFilter(f)}
      className={`rounded-lg px-3 py-1.5 text-sm font-semibold min-h-[36px] ${filter === f ? "bg-black text-white" : "bg-black/10 text-black"}`}>{label}</button>
  );
  return (
    <section aria-labelledby="wp-h" data-testid="watch-player" className="space-y-3">
      <h3 id="wp-h" className="sr-only">{t("m.wp.h")}</h3>
      {!list.length ? <p className="text-sm" data-testid="wp-empty">{t("m.wp.none")}</p> : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-3 min-w-0" data-testid="wp-stage">
            {!cur && <div className="aspect-video w-full overflow-hidden rounded-xl bg-black text-white grid place-items-center p-4 text-center text-sm" data-testid="wp-placeholder">{t("m.wp.pick")}</div>}
            {cur?.kind === "youtube" && <iframe key={cur.key} data-testid="wp-yt-frame" title={cur.title} src={`https://www.youtube-nocookie.com/embed/${cur.src}?rel=0&playsinline=1`} referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen" allowFullScreen className="w-full aspect-video rounded-xl border-0 bg-black" />}
            {cur?.kind === "own" && (
              <video key={cur.key} data-testid="wp-video" aria-label={cur.title} src={cur.src} controls preload="metadata" playsInline className={cur.media === "audio" ? "w-full h-14 rounded-xl bg-black" : "w-full aspect-video rounded-xl bg-black"}
                onPlay={() => { if (counted.current !== cur.key) { counted.current = cur.key; videocastApi.view(cur.key.slice(4)).catch(() => undefined); } }} onError={() => setErr(true)} />
            )}
            {err && <p role="alert" className="text-sm font-bold" data-testid="wp-error">{t("m.error.remote")}</p>}
            {cur && (
              <div className="space-y-3">
                <h4 className="text-xl font-bold break-words" data-testid="wp-title">{cur.title}</h4>
                <div className="flex flex-wrap items-center gap-3">
                  <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black text-white font-bold">{cur.by.trim().charAt(0).toUpperCase()}</span>
                  <div className="min-w-0 flex-1"><p className="font-bold leading-tight break-words" data-testid="wp-by">{cur.by}</p><p className="text-xs">{cur.kind === "own" ? t("m.wp.own") : t("m.wp.yt")}</p></div>
                  <div className="flex gap-2">
                    <button type="button" data-testid="wp-prev" onClick={() => choose(stepEntry(list, key, -1))} className="rounded-full bg-black/10 px-4 py-2 text-sm font-semibold min-h-[44px]">{t("m.wp.prev")}</button>
                    <button type="button" data-testid="wp-next" onClick={() => choose(stepEntry(list, key, 1))} className="rounded-full bg-black/10 px-4 py-2 text-sm font-semibold min-h-[44px]">{t("m.wp.next")}</button>
                  </div>
                </div>
                <div className="rounded-xl bg-black/5 p-3 text-sm space-y-1" data-testid="wp-desc">
                  {cur.when && <p className="font-bold">{cur.when}</p>}
                  <p className="whitespace-pre-line break-words">{cur.note || t("m.wp.nodesc")}</p>
                </div>
              </div>
            )}
            {!cur && (<div className="flex gap-2"><button type="button" data-testid="wp-prev" onClick={() => choose(stepEntry(list, key, -1))} className="rounded-full bg-black/10 px-4 py-2 text-sm font-semibold min-h-[44px]">{t("m.wp.prev")}</button><button type="button" data-testid="wp-next" onClick={() => choose(stepEntry(list, key, 1))} className="rounded-full bg-black/10 px-4 py-2 text-sm font-semibold min-h-[44px]">{t("m.wp.next")}</button></div>)}
          </div>
          <div className="min-w-0 space-y-3">
            <div role="group" aria-label={t("m.wp.filters")} className="flex flex-wrap gap-2">{chip("all", t("m.wp.all"))}{chip("own", t("m.wp.own"))}{chip("youtube", t("m.wp.yt"))}</div>
            <h4 className="sr-only" id="wp-list-h">{t("m.wp.upnext")} ({shown.length})</h4>
            <ul aria-labelledby="wp-list-h" data-testid="wp-list" className="space-y-3 lg:max-h-[75vh] lg:overflow-y-auto">
              {shown.map((e) => (
                <li key={e.key}>
                  <button type="button" data-testid="wp-item" data-kind={e.kind} aria-current={e.key === key ? "true" : undefined} onClick={() => choose(e)}
                    className={`flex w-full gap-3 rounded-xl p-1.5 text-left min-h-[44px] ${e.key === key ? "bg-black/10" : "hover:bg-black/5"}`}>
                    <Tile e={e} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-bold leading-snug break-words line-clamp-3">{e.title}</span>
                      <span className="block text-xs pt-1 break-words">{e.by}</span>
                      <span className="block text-xs">{e.kind === "own" ? t("m.wp.own") : t("m.wp.yt")}{e.when ? ` · ${e.when}` : ""}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
