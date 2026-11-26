import { useCallback, useEffect, useState } from "react";
import { tokenStore } from "../../api/civic";
import { seenIds, videocastApi, type VideoItem } from "../../api/videocast";

/**
 * The videos broadcast to members (S-230). Loads when someone is signed in, and again on sign-in, on focus and every minute.
 * "Unseen" is worked out on this device from a list kept only in this browser, so the server never records who watched what.
 */
export function useVideos(): { items: VideoItem[]; unseen: string[]; signedIn: boolean; reload: () => void } {
  const [signedIn, setSignedIn] = useState(() => !!tokenStore.get());
  const [items, setItems] = useState<VideoItem[]>([]);
  const [seen, setSeen] = useState<string[]>(seenIds);
  const load = useCallback(() => {
    if (!tokenStore.get()) { setItems([]); return; }
    videocastApi.list().then((r) => setItems(r.items)).catch(() => undefined);
  }, []);
  useEffect(() => {
    const onSession = () => { setSignedIn(!!tokenStore.get()); load(); };
    const onSeen = () => setSeen(seenIds());
    window.addEventListener("pp-session", onSession);
    window.addEventListener("pp-video-seen", onSeen);
    window.addEventListener("focus", load);
    const t = window.setInterval(load, 60_000);
    load();
    return () => { window.removeEventListener("pp-session", onSession); window.removeEventListener("pp-video-seen", onSeen); window.removeEventListener("focus", load); window.clearInterval(t); };
  }, [load]);
  return { items, unseen: items.filter((v) => !seen.includes(v.id)).map((v) => v.id), signedIn, reload: load };
}
