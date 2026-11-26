import { useCallback, useEffect, useState } from "react";
import { tokenStore } from "../../api/civic";
import { seenIds, setVideosMuted, videocastApi, videosMuted, type Correction, type VideoItem } from "../../api/videocast";

/**
 * The videos broadcast to members (S-230). Loads when someone is signed in, and again on sign-in, on focus and every minute.
 * "Unseen" is worked out on this device from a list kept only in this browser, so the server never records who watched what.
 */
export function useVideos(): { items: VideoItem[]; corrections: Correction[]; unseen: string[]; signedIn: boolean; muted: boolean; setMuted: (m: boolean) => void; reload: () => void } {
  const [signedIn, setSignedIn] = useState(() => !!tokenStore.get());
  const [items, setItems] = useState<VideoItem[]>([]);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [muted, setMutedState] = useState(videosMuted);
  const [seen, setSeen] = useState<string[]>(seenIds);
  const load = useCallback(() => {
    if (!tokenStore.get()) { setItems([]); setCorrections([]); return; }
    videocastApi.list().then((r) => { setItems(r.items); setCorrections(r.corrections ?? []); }).catch(() => undefined);
  }, []);
  useEffect(() => {
    const onSession = () => { setSignedIn(!!tokenStore.get()); load(); };
    const onSeen = () => { setSeen(seenIds()); setMutedState(videosMuted()); };
    window.addEventListener("pp-session", onSession);
    window.addEventListener("pp-video-seen", onSeen);
    window.addEventListener("focus", load);
    const t = window.setInterval(load, 60_000);
    load();
    return () => { window.removeEventListener("pp-session", onSession); window.removeEventListener("pp-video-seen", onSeen); window.removeEventListener("focus", load); window.clearInterval(t); };
  }, [load]);
  return { items, corrections, unseen: muted ? [] : items.filter((v) => !seen.includes(v.id)).map((v) => v.id), signedIn, muted, setMuted: setVideosMuted, reload: load };
}
