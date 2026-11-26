import { useState } from "react";
import { useT } from "../../i18n";
import { mediaText as mt, type MediaKey } from "./mediaText";
import { youtubeIdOf } from "./playerLogic";

/**
 * Play a YouTube link (member's own choice). Client only: the link is never sent to our server or stored. Nothing is requested from YouTube until the person
 * taps Play, and then only YouTube's no-cookie embed player loads (the page's CSP allows only that host for frames).
 */
export default function YoutubePlayer() {
  const { lang } = useT();
  const t = (k: MediaKey) => mt(lang, k);
  const [text, setText] = useState("");
  const [id, setId] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const go = () => { const v = youtubeIdOf(text); setBad(!v); setId(v); };
  return (
    <section aria-labelledby="yt-h" data-testid="yt-player" className="space-y-3 border-t border-black/40 pt-4">
      <h3 id="yt-h" className="text-lg font-bold">{t("m.yt.h")}</h3>
      <p className="text-sm">{t("m.yt.lead")} {t("m.noauto")}</p>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <label className="block text-sm font-bold" htmlFor="yt-link">{t("m.yt.label")}</label>
        <input id="yt-link" data-testid="yt-link" type="url" inputMode="url" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" className="block w-full max-w-xl border border-black bg-transparent p-2 min-h-[44px]" />
        <button type="submit" data-testid="yt-go" className="border border-black px-3 py-1 text-sm font-bold min-h-[44px]">{t("m.yt.go")}</button>
      </form>
      {bad && <p role="alert" data-testid="yt-bad" className="text-sm font-bold">{t("m.yt.bad")}</p>}
      {id && (
        <div className="space-y-2">
          <iframe data-testid="yt-frame" title={t("m.yt.h")} src={`https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1`} referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen" allowFullScreen className="w-full aspect-video border-0 bg-black" />
          <button type="button" data-testid="yt-clear" onClick={() => { setId(null); setText(""); }} className="border border-black px-3 py-1 text-sm font-bold min-h-[44px]">{t("m.yt.clear")}</button>
        </div>
      )}
    </section>
  );
}
