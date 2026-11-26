import { Fragment, useEffect, useState } from "react";
import { mediaApi, type LiveChannel } from "../../api/mediahub";
import { useT } from "../../i18n";
import { youtubeIdOf } from "./playerLogic";
import ReportButton from "./ReportButton";
import { mediaText as mt, type MediaKey } from "./mediaText";

const playable = (c: LiveChannel) => !!c.stream_url && c.health_ok !== false;

/** The embedded live player (stage). Nothing is requested from the channel or YouTube until the person taps Play. */
function Stage({ c, name }: { c: LiveChannel; name: string }) {
  const { lang } = useT();
  const t = (k: MediaKey) => mt(lang, k);
  const [on, setOn] = useState(false);
  const [err, setErr] = useState(false);
  const yt = c.stream_url ? youtubeIdOf(c.stream_url) : null;
  const down = !playable(c) || err;
  return (
    <div className="space-y-2" data-testid="live-stage">
      <div className="relative w-full aspect-video bg-black text-white">
        {on && !down && yt && <iframe data-testid="live-yt-frame" title={name} src={`https://www.youtube-nocookie.com/embed/${yt}?rel=0&playsinline=1&autoplay=1`} referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen; autoplay" allowFullScreen className="absolute inset-0 h-full w-full border-0" />}
        {on && !down && !yt && <video data-testid="live-video" aria-label={name} src={c.stream_url ?? undefined} controls preload="none" playsInline className="absolute inset-0 h-full w-full" onError={() => setErr(true)} />}
        {(!on || down) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
            <p className="font-bold break-words">{name}</p>
            {down
              ? <p role="status" data-testid="live-down" className="text-sm font-bold">{t("m.live.down")}</p>
              : <button type="button" data-testid="live-play" onClick={() => setOn(true)} className="border border-white px-4 py-2 font-bold min-h-[44px]">{t("m.live.play")}</button>}
          </div>
        )}
      </div>
      {!on && !down && <p className="text-xs">{t("m.yt.note")}</p>}
      {on && !down && <button type="button" data-testid="live-hide" onClick={() => setOn(false)} className="border border-black px-3 py-1 text-sm font-bold min-h-[44px]">{t("m.live.hide")}</button>}
    </div>
  );
}

/** Live channels (S-228): channels that confirmed we may show them. A player stage on top, the channel list below it; the official site is always offered. */
export default function LiveList() {
  const { lang } = useT();
  const t = (k: MediaKey) => mt(lang, k);
  const [list, setList] = useState<LiveChannel[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { let live = true; mediaApi.live().then((r) => { if (live) setList(r.channels); }).catch(() => { if (live) setList([]); }); return () => { live = false; }; }, []);
  if (!list) return <p role="status" className="text-sm">…</p>;
  if (!list.length) return (
    <div className="space-y-2" data-testid="media-live-empty">
      <h3 className="text-lg font-bold">{t("m.live.h")}</h3>
      <p className="text-sm">{t("m.live.none")}</p>
    </div>
  );
  const nameOf = (c: LiveChannel) => (lang === "te" && c.name_te) || c.name_en;
  const cur = list.find((c) => c.id === sel) ?? list.find(playable) ?? list[0];
  return (
    <div className="space-y-3" data-testid="live-list">
      <h3 className="text-lg font-bold">{t("m.live.h")}</h3>
      <p className="text-xs">{t("m.live.note")}</p>
      <Fragment key={cur.id}><Stage c={cur} name={nameOf(cur)} /></Fragment>
      <ul className="space-y-2">
        {list.map((c) => (
          <li key={c.id} data-testid="live-channel" data-current={c.id === cur.id ? "1" : "0"} className={`border p-3 space-y-1 ${c.id === cur.id ? "border-2 border-black" : "border-black"}`}>
            <button type="button" data-testid="live-pick" aria-current={c.id === cur.id ? "true" : undefined} onClick={() => setSel(c.id)} className="text-left font-bold break-words min-h-[44px] w-full"><span data-testid="live-name">{nameOf(c)}</span></button>
            {/* The channel's own site is always offered. We never host or re-stream; a stream plays here only if the channel gave an official stream address. */}
            <a data-testid="live-link" href={c.site_url} target="_blank" rel="noopener noreferrer" className="underline text-sm font-bold inline-flex min-h-[44px] items-center" onClick={() => { mediaApi.click("live", c.id).catch(() => undefined); }}>{t("m.live.open")}</a>
            <ReportButton kind="live" id={c.id} />
          </li>
        ))}
      </ul>
    </div>
  );
}
