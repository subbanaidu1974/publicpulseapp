import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { mediaText as mt, type MediaKey } from "./mediaText";
import { SPEEDS, clock, isSpeed, kindOf } from "./playerLogic";

/**
 * Free media player (S-227). The browser's own <video> element with its own keyboard and screen-reader controls, plus speed, audio-only and optional captions.
 * Plays a file chosen on this device (an object URL that lives only in this tab): nothing is uploaded, stored or counted, and it never starts by itself.
 */
export default function MediaPlayer() {
  const { lang } = useT();
  const t = (k: MediaKey) => mt(lang, k);
  const [file, setFile] = useState<{ url: string; name: string; kind: "audio" | "video" } | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [audioOnly, setAudioOnly] = useState(false);
  const [time, setTime] = useState({ now: 0, len: 0 });
  const el = useRef<HTMLVideoElement | null>(null);

  useEffect(() => () => { if (file) URL.revokeObjectURL(file.url); }, [file]);
  useEffect(() => () => { if (cap) URL.revokeObjectURL(cap); }, [cap]);
  useEffect(() => { if (el.current) el.current.playbackRate = speed; }, [speed, file]);

  const pick = (f: File | undefined) => {
    setMsg(null); setErr(false);
    if (!f) return;
    const kind = kindOf(f.name, f.type);
    if (!kind) { setMsg(t("m.pick.bad")); return; }
    setFile({ url: URL.createObjectURL(f), name: f.name, kind }); setCap(null); setTime({ now: 0, len: 0 });
  };
  const pickCaps = (f: File | undefined) => {
    setMsg(null);
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".vtt")) { setMsg(t("m.captions.bad")); return; }
    setCap(URL.createObjectURL(f));
  };
  const clear = () => { setFile(null); setCap(null); setErr(false); };

  // <video> plays audio files too, so one element serves both; audio-only hides the picture and keeps the sound.
  const hidePicture = file?.kind === "audio" || audioOnly;
  return (
    <section aria-labelledby="mp-h" data-testid="media-player" className="space-y-3">
      <h3 id="mp-h" className="text-lg font-bold">{t("m.watch.h")}</h3>
      <p className="text-sm">{t("m.watch.lead")} {t("m.noauto")}</p>
      <div className="space-y-2">
        <label className="block text-sm font-bold" htmlFor="mp-file">{t("m.pick")}</label>
        <input id="mp-file" data-testid="mp-file" type="file" accept="video/*,audio/*,.mp3,.m4a,.wav,.ogg,.opus,.mp4,.webm" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} className="block text-sm max-w-full" />
      </div>
      {msg && <p role="alert" data-testid="mp-msg" className="text-sm font-bold">{msg}</p>}
      {!file ? <p data-testid="mp-empty" className="text-sm">{t("m.nofile")}</p> : (
        <div className="space-y-3">
          <p className="text-sm break-words"><span className="font-bold">{t("m.nowplaying")}:</span> <span data-testid="mp-name">{file.name}</span></p>
          <video
            ref={el} key={file.url} data-testid="mp-media" aria-label={`${t("m.player")}: ${file.name}`}
            src={file.url} controls preload="metadata" playsInline
            className={hidePicture ? "w-full h-12 bg-black" : "w-full max-h-[60vh] bg-black"}
            onLoadedMetadata={(e) => { const m = e.currentTarget; const len = m.duration; setTime((x) => ({ ...x, len })); m.playbackRate = speed; }}
            onTimeUpdate={(e) => { const m = e.currentTarget; setTime({ now: m.currentTime, len: m.duration }); }}
            onError={() => setErr(true)}
          >
            {cap && <track kind="captions" src={cap} srcLang={lang} label={lang === "te" ? "తెలుగు" : "English"} default />}
          </video>
          <p data-testid="mp-time" className="text-xs">{clock(time.now)} / {clock(time.len)}</p>
          {err && <p role="alert" data-testid="mp-error" className="text-sm font-bold">{t("m.error")}</p>}
          <div className="flex flex-wrap items-end gap-4">
            <label className="text-sm font-bold">{t("m.speed")}{" "}
              <select data-testid="mp-speed" value={speed} onChange={(e) => { const n = Number(e.target.value); if (isSpeed(n)) setSpeed(n); }} className="border border-black bg-transparent p-1 ml-1">
                {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
              </select>
            </label>
            {file.kind === "video" && (
              <label className="text-sm font-bold inline-flex items-center gap-2"><input data-testid="mp-audioonly" type="checkbox" checked={audioOnly} onChange={(e) => setAudioOnly(e.target.checked)} />{t("m.audioonly")}</label>
            )}
            <button type="button" data-testid="mp-clear" onClick={clear} className="border border-black px-3 py-1 text-sm font-bold">{t("m.clear")}</button>
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-bold" htmlFor="mp-cap">{t("m.captions")}</label>
            <input id="mp-cap" data-testid="mp-cap" type="file" accept=".vtt,text/vtt" onChange={(e) => { pickCaps(e.target.files?.[0]); e.target.value = ""; }} className="block text-sm max-w-full" />
          </div>
        </div>
      )}
    </section>
  );
}
