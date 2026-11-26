import { Fragment, useEffect, useState } from "react";
import { mediaApi, type LiveChannel } from "../../api/mediahub";
import { useT } from "../../i18n";
import YoutubePlayer from "./YoutubePlayer";
import { youtubeIdOf } from "./playerLogic";
import ReportButton from "./ReportButton";
import { mediaText as mt, type MediaKey } from "./mediaText";

function Channel({ c }: { c: LiveChannel }) {
  const { lang } = useT();
  const t = (k: MediaKey) => mt(lang, k);
  const [show, setShow] = useState(false);
  const [err, setErr] = useState(false);
  const name = (lang === "te" && c.name_te) || c.name_en;
  const down = c.health_ok === false || err;
  const yt = c.stream_url ? youtubeIdOf(c.stream_url) : null;
  return (
    <li data-testid="live-channel" className="border border-black p-3 space-y-2">
      <h4 className="font-bold break-words" data-testid="live-name">{name}</h4>
      {/* The channel's own site is always offered. We never host or re-stream; a stream plays here only if the channel gave an official stream address. */}
      <a data-testid="live-link" href={c.site_url} target="_blank" rel="noopener noreferrer" className="underline text-sm font-bold inline-flex min-h-[44px] items-center" onClick={() => { mediaApi.click("live", c.id).catch(() => undefined); }}>{t("m.live.open")}</a>
      {c.stream_url && !down && (
        <div className="space-y-2">
          <button type="button" data-testid="live-play" aria-expanded={show} onClick={() => setShow(!show)} className="block border border-black px-3 py-1 text-sm font-bold min-h-[44px]">{show ? t("m.live.hide") : t("m.live.play")}</button>
          {show && yt && <iframe data-testid="live-yt-frame" title={name} src={`https://www.youtube-nocookie.com/embed/${yt}?rel=0&playsinline=1`} referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen" allowFullScreen className="w-full aspect-video border-0 bg-black" />}
          {show && !yt && <video data-testid="live-video" aria-label={name} src={c.stream_url} controls preload="none" playsInline className="w-full max-h-[60vh] bg-black" onError={() => setErr(true)} />}
        </div>
      )}
      {down && <p role="status" data-testid="live-down" className="text-sm font-bold">{t("m.live.down")}</p>}
      <ReportButton kind="live" id={c.id} />
    </li>
  );
}

/** Live channels (S-228): channels that confirmed we may show them. Official site always; official stream only when given and healthy. */
export default function LiveList() {
  const { lang } = useT();
  const t = (k: MediaKey) => mt(lang, k);
  const [list, setList] = useState<LiveChannel[] | null>(null);
  useEffect(() => { let live = true; mediaApi.live().then((r) => { if (live) setList(r.channels); }).catch(() => { if (live) setList([]); }); return () => { live = false; }; }, []);
  if (!list) return <p role="status" className="text-sm">…</p>;
  if (!list.length) return (
    <div className="space-y-2" data-testid="media-live-empty">
      <h3 className="text-lg font-bold">{t("m.live.h")}</h3>
      <p className="text-sm">{t("m.live.none")}</p>
      <YoutubePlayer />
    </div>
  );
  return (
    <div className="space-y-3" data-testid="live-list">
      <h3 className="text-lg font-bold">{t("m.live.h")}</h3>
      <p className="text-xs">{t("m.live.note")}</p>
      <ul className="space-y-3">{list.map((c) => <Fragment key={c.id}><Channel c={c} /></Fragment>)}</ul>
      <YoutubePlayer />
    </div>
  );
}
