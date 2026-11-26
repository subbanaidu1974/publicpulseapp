import { useEffect, useRef, useState } from "react";
import { markSeen, videocastApi, type VideoItem } from "../../api/videocast";
import { useT } from "../../i18n";
import { mediaText as mt, type MediaKey } from "./mediaText";

function Card({ v, isNew }: { v: VideoItem; isNew: boolean }) {
  const { lang } = useT();
  const t = (k: MediaKey) => mt(lang, k);
  const [err, setErr] = useState(false);
  const counted = useRef(false);
  const title = (lang === "te" && v.title_te) || v.title_en;
  const note = (lang === "te" && v.note_te) || v.note_en;
  return (
    <div data-testid="video-card" data-id={v.id} data-new={isNew ? "1" : "0"} className="border border-black p-3 space-y-2">
      <h4 className="font-bold break-words">
        {isNew && <span data-testid="video-new" className="mr-2 border border-black bg-black px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">{t("m.new")}</span>}
        <span data-testid="video-title">{title}</span>
      </h4>
      {note && <p className="text-sm break-words">{note}</p>}
      {/* The browser's own controls; it never starts by itself. A play is counted once per card as a plain number, never against a person. */}
      <video
        data-testid="video-media" aria-label={`${t("m.player")}: ${title}`} src={v.media_url} controls preload="none" playsInline
        className={v.kind === "audio" ? "w-full h-12 bg-black" : "w-full max-h-[60vh] bg-black"}
        onPlay={() => { if (!counted.current) { counted.current = true; videocastApi.view(v.id).catch(() => undefined); } }}
        onError={() => setErr(true)}
      />
      {err && <p role="alert" data-testid="video-error" className="text-sm font-bold">{t("m.error.remote")}</p>}
      <p className="text-xs break-words">{t("m.credit")}: {v.credit}</p>
    </div>
  );
}

/** The "From us" section for a signed-in member: videos an admin broadcast and a second admin approved (S-230). */
export default function VideoCards({ items }: { items: VideoItem[] }) {
  const { lang } = useT();
  const [firstSeen] = useState(() => new Set<string>()); // ids that were new when the section opened, so their "New" label stays while they are looked at
  const [unseenAtOpen, setUnseenAtOpen] = useState<Set<string>>(firstSeen);
  useEffect(() => {
    if (!items.length) return;
    const fresh = items.filter((v) => !firstSeen.has(v.id) && !localSeen(v.id)).map((v) => v.id);
    if (fresh.length) setUnseenAtOpen((s) => new Set([...s, ...fresh]));
    markSeen(items.map((v) => v.id)); // from here they are no longer counted in the Media badge
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((v) => v.id).join(",")]);
  return (
    <ul data-testid="video-list" lang={lang} className="space-y-4">
      {items.map((v) => <li key={v.id}><Card v={v} isNew={unseenAtOpen.has(v.id)} /></li>)}
    </ul>
  );
}
function localSeen(id: string): boolean { try { return (JSON.parse(localStorage.getItem("pp-video-seen") ?? "[]") as string[]).includes(id); } catch { return false; } }
