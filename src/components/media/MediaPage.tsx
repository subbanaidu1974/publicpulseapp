import { useEffect, useState, type KeyboardEvent } from "react";
import { useT } from "../../i18n";
import { TranslationNote } from "../TranslationNote";
import MediaPlayer from "./MediaPlayer";
import WatchPlayer from "./WatchPlayer";
import VideoCards, { Card } from "./VideoCards";
import NewsList from "./NewsList";
import { mediaApi } from "../../api/mediahub";
import LiveList from "./LiveList";
import { useVideos } from "./useVideos";
import { mediaText as mt, type MediaKey } from "./mediaText";

const SECTIONS = ["news", "watch", "live", "ours"] as const;
type Section = (typeof SECTIONS)[number];
const KEY = "pp-media-tab";
const read = (): Section => { try { const v = sessionStorage.getItem(KEY); return SECTIONS.find((x) => x === v) ?? "news"; } catch { return "news"; } };

/** Media tab shell (S-224). News, Live and From us are honest empty states until their stories land (S-226, S-228, S-229); Watch holds the free player (S-227). */
export default function MediaPage() {
  const { lang } = useT();
  const t = (k: MediaKey) => mt(lang, k);
  const [sec, setSec] = useState<Section>(read);
  const vids = useVideos();
  // Something new from us opens that section first, once.
  const [jumped, setJumped] = useState(false);
  const [preview, setPreview] = useState(false);
  useEffect(() => { let on = true; mediaApi.preview().then((r) => { if (on) setPreview(!!r.preview); }).catch(() => undefined); return () => { on = false; }; }, []);
  useEffect(() => { if (!jumped && vids.unseen.length) { setJumped(true); setSec("ours"); } }, [jumped, vids.unseen.length]);
  const pick = (s: Section) => { setSec(s); try { sessionStorage.setItem(KEY, s); } catch { /* ignore */ } };
  const onKey = (e: KeyboardEvent) => {
    const i = SECTIONS.indexOf(sec);
    const n = e.key === "ArrowRight" ? SECTIONS[(i + 1) % SECTIONS.length] : e.key === "ArrowLeft" ? SECTIONS[(i + SECTIONS.length - 1) % SECTIONS.length] : e.key === "Home" ? SECTIONS[0] : e.key === "End" ? SECTIONS[SECTIONS.length - 1] : null;
    if (!n) return;
    e.preventDefault(); pick(n);
    requestAnimationFrame(() => document.getElementById(`media-tab-${n}`)?.focus());
  };
  const empty = (h: MediaKey, none: MediaKey, id: string) => (
    <div className="space-y-2" data-testid={`media-${id}-empty`}>
      <h3 className="text-lg font-bold">{t(h)}</h3>
      <p className="text-sm">{t(none)}</p>
    </div>
  );
  return (
    <div data-testid="media-home" lang={lang} className={`${sec === "watch" || sec === "news" ? "max-w-6xl" : "max-w-3xl"} mx-auto w-full space-y-6 overflow-x-hidden`}>
      <header className="space-y-2">
        <h2 className="text-2xl font-serif italic">{t("m.title")}</h2>
        <p className="text-sm">{t("m.intro")}</p>
        <TranslationNote status="machine-draft" />
        {preview && <p role="note" data-testid="media-preview-banner" className="border border-black p-2 text-sm font-bold">{t("m.preview")}</p>}
      </header>
      <div role="tablist" aria-label={t("m.tabs")} data-testid="media-tabs" className="flex gap-1 border-b border-black overflow-x-auto whitespace-nowrap" onKeyDown={onKey}>
        {SECTIONS.map((s) => (
          <button key={s} type="button" role="tab" id={`media-tab-${s}`} aria-selected={sec === s} aria-controls={`media-panel-${s}`} tabIndex={sec === s ? 0 : -1}
            data-testid={`media-tab-${s}`} onClick={() => pick(s)}
            className={`min-h-[44px] px-4 py-2 text-sm font-bold shrink-0 border border-black border-b-0 -mb-px ${sec === s ? "bg-black text-white" : "bg-transparent text-inherit"}`}>
            {t(`m.tab.${s}` as MediaKey)}
          </button>
        ))}
      </div>
      {vids.signedIn && (
        <div className="text-sm">
          <label className="inline-flex items-center gap-2 min-h-[44px]"><input data-testid="media-mute" type="checkbox" checked={vids.muted} onChange={(e) => vids.setMuted(e.target.checked)} />{t("m.mute")}</label>
          <p className="text-xs">{t("m.mute.note")}</p>
        </div>
      )}
      <section role="tabpanel" id="media-panel-news" aria-labelledby="media-tab-news" data-testid="media-panel-news" hidden={sec !== "news"}>{sec === "news" && <NewsList />}</section>
      <section role="tabpanel" id="media-panel-watch" aria-labelledby="media-tab-watch" data-testid="media-panel-watch" hidden={sec !== "watch"}>
        <div className="space-y-6">
          {sec === "watch" && <WatchPlayer own={vids.items} />}
          {vids.signedIn && (
            <section aria-labelledby="lib-h" data-testid="video-library" className="space-y-3">
              <h3 id="lib-h" className="text-lg font-bold">{t("m.lib.h")}</h3>
              {vids.items.some((v) => v.library)
                ? <ul className="space-y-4">{vids.items.filter((v) => v.library).map((v) => <li key={v.id}><Card v={v} isNew={false} /></li>)}</ul>
                : <p className="text-sm" data-testid="video-library-empty">{t("m.lib.none")}</p>}
            </section>
          )}
          <MediaPlayer />
        </div>
      </section>
      <section role="tabpanel" id="media-panel-live" aria-labelledby="media-tab-live" data-testid="media-panel-live" hidden={sec !== "live"}>{sec === "live" && <LiveList />}</section>
      <section role="tabpanel" id="media-panel-ours" aria-labelledby="media-tab-ours" data-testid="media-panel-ours" hidden={sec !== "ours"}>
        {!vids.signedIn ? <div className="space-y-2" data-testid="media-ours-signin"><h3 className="text-lg font-bold">{t("m.ours.h")}</h3><p className="text-sm">{t("m.ours.signin")}</p></div>
          : (vids.items.length || vids.corrections.length) ? <div className="space-y-3"><h3 className="text-lg font-bold">{t("m.ours.h")}</h3>{sec === "ours" && <VideoCards items={vids.items} corrections={vids.corrections} />}</div>
          : empty("m.ours.h", "m.ours.none", "ours")}
      </section>
    </div>
  );
}
