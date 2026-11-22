import { useCallback, useEffect, useRef, useState } from "react";
import { issuesApi, uploadErrorCode, type UploadErrorCode } from "../../api/civic";
import { CONVERT_DEFAULTS, ConvertError, reencodeToJpeg } from "../../lib/mediaConvert";
import { useCivicT, type CivicKey } from "./civicText";
import { Btn } from "./ui";

type Phase = "idle" | "converting" | "uploading" | "done" | "error";
interface UploadState { phase: Phase; pct: number; err: CivicKey | null; retryable: boolean; name: string }
const IDLE: UploadState = { phase: "idle", pct: 0, err: null, retryable: false, name: "" };

/** One Telugu + English message per documented server upload error code (see data/civic/client-media-spec.json and issues/media.ts). */
export const UPLOAD_ERROR_KEY: Record<UploadErrorCode, CivicKey> = {
  convert_on_client: "c.issue.convertOnClient", unsupported_type: "c.issue.unsupported", wrong_kind: "c.issue.up.wrong_kind", too_large: "c.issue.tooLarge",
  dimensions_too_large: "c.issue.up.dimensions_too_large", scan_rejected: "c.issue.up.scan_rejected", scanner_unavailable: "c.issue.up.scanner_unavailable",
  daily_limit: "c.issue.up.daily_limit", network: "c.issue.uploadFail", error: "c.issue.uploadFail",
};
/** Worth showing Retry for: the same file may succeed later. */
const RETRYABLE: UploadErrorCode[] = ["scanner_unavailable", "network", "error"];

/** One recovery step per the client spec: given the server's refusal, produce a better blob (or null to stop). Tried once, never looped. */
type Recover = (code: UploadErrorCode) => Promise<Blob | null>;
const photoRecover = (file: File): Recover => async (code) => {
  if (code === "convert_on_client") return reencodeToJpeg(file); // spec: run the helper once and retry
  if (code === "dimensions_too_large") return reencodeToJpeg(file, { maxSide: Math.floor(CONVERT_DEFAULTS.maxSide * 0.75) });
  if (code === "too_large") return reencodeToJpeg(file, { quality: 0.6, maxSide: Math.floor(CONVERT_DEFAULTS.maxSide * 0.75), maxBytes: Math.floor(CONVERT_DEFAULTS.maxBytes * 0.5) });
  return null; // scan_rejected and everything else: do not retry
};

/** Upload state machine shared by photo and voice: POST /issues/media with progress, one spec-defined recovery, keep the blob so Retry does not re-pick. */
function useMediaUpload(onRef: (ref: string | null) => void) {
  const [s, setS] = useState<UploadState>(IDLE);
  const blob = useRef<{ b: Blob; name: string; recover?: Recover } | null>(null);
  const run = useCallback(async (b: Blob, name: string, recover?: Recover) => {
    blob.current = { b, name, recover }; onRef(null);
    setS({ phase: "uploading", pct: 0, err: null, retryable: false, name });
    let cur = b, recovered = false;
    for (;;) {
      try {
        const r = await issuesApi.uploadMedia(cur, (f) => setS((x) => ({ ...x, pct: Math.round(f * 100) })));
        onRef(r.ref); setS({ phase: "done", pct: 100, err: null, retryable: false, name }); return;
      } catch (e) {
        const code = uploadErrorCode(e);
        if (!recovered && recover) {
          recovered = true;
          let next: Blob | null = null;
          try { next = await recover(code); } catch (er) { if (er instanceof ConvertError && er.code === "too_large") { setS({ phase: "error", pct: 0, name, err: "c.issue.tooLarge", retryable: false }); return; } }
          if (next) { cur = next; blob.current = { b: next, name, recover }; setS({ phase: "uploading", pct: 0, err: null, retryable: false, name }); continue; }
        }
        setS({ phase: "error", pct: 0, name, err: UPLOAD_ERROR_KEY[code], retryable: RETRYABLE.includes(code) }); return;
      }
    }
  }, [onRef]);
  const retry = () => { const k = blob.current; if (k) void run(k.b, k.name, k.recover); };
  const clear = () => { blob.current = null; onRef(null); setS(IDLE); };
  return { s, setS, run, retry, clear };
}

function Progress({ s, retry, clear, removeKey }: { s: UploadState; retry: () => void; clear: () => void; removeKey: CivicKey }) {
  const c = useCivicT();
  if (s.phase === "idle") return null;
  return (
    <div className="space-y-2 text-sm" data-testid="media-status">
      {(s.phase === "uploading" || s.phase === "converting") && (
        <div role="status">
          <span>{s.phase === "converting" ? c("c.issue.converting") : `${c("c.issue.uploading")} ${s.pct}%`}</span>
          {s.phase === "uploading" && <progress className="block w-full h-3" max={100} value={s.pct} aria-label={c("c.issue.uploading")} />}
        </div>
      )}
      {s.phase === "done" && <p role="status" data-testid="media-done">{c("c.issue.uploaded")}: {s.name}</p>}
      {s.phase === "error" && s.err && <p role="alert" data-testid="media-error" className="text-red-800 font-bold">{c(s.err)}</p>}
      <div className="flex flex-wrap gap-2">
        {s.phase === "error" && s.retryable && <Btn secondary data-testid="media-retry" onClick={retry}>{c("c.issue.retry")}</Btn>}
        {(s.phase === "done" || s.phase === "error") && <Btn secondary data-testid="media-remove" onClick={clear}>{c(removeKey)}</Btn>}
      </div>
    </div>
  );
}

/** Photo: any browser-decodable image is resized and re-encoded to JPEG on the phone (also drops EXIF/GPS) before upload. */
export function PhotoPicker({ onRef }: { onRef: (ref: string | null) => void }) {
  const c = useCivicT();
  const { s, setS, run, retry, clear } = useMediaUpload(onRef);
  return (
    <div className="space-y-2" data-testid="photo-picker">
      <label htmlFor="ir-photo" className="block text-sm font-bold">{c("c.issue.photo")}</label>
      <p id="ir-photo-help" className="text-xs">{c("c.issue.photoHelp")}</p>
      <input id="ir-photo" data-testid="ir-photo" type="file" accept="image/*" aria-describedby="ir-photo-help" className="w-full min-h-[44px] text-sm"
        onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = "";
          if (!f) return;
          if (f.type && !/^image\//.test(f.type) && !/\.(heic|heif)$/i.test(f.name)) { setS({ phase: "error", pct: 0, name: f.name, err: "c.issue.notImage", retryable: false }); return; }
          setS({ phase: "converting", pct: 0, err: null, retryable: false, name: f.name });
          try { await run(await reencodeToJpeg(f), f.name, photoRecover(f)); }
          catch (er) { setS({ phase: "error", pct: 0, name: f.name, retryable: false, err: er instanceof ConvertError ? (er.code === "convert_on_client" ? "c.issue.convertOnClient" : er.code === "too_large" ? "c.issue.tooLarge" : "c.issue.notImage") : "c.issue.uploadFail" }); }
        }} />
      <Progress s={s} retry={retry} clear={clear} removeKey="c.issue.photoRemove" />
    </div>
  );
}

const MAX_SECONDS = 60;

/** Voice note: MediaRecorder where available, always with a file-pick fallback (also used when the microphone is denied). */
export function VoiceRecorder({ onRef }: { onRef: (ref: string | null) => void }) {
  const c = useCivicT();
  const { s, run, retry, clear } = useMediaUpload(onRef);
  const [rec, setRec] = useState(false);
  const [secs, setSecs] = useState(0);
  const [micErr, setMicErr] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const canRecord = typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); recorder.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  const stop = () => { if (timer.current) clearInterval(timer.current); timer.current = null; if (recorder.current?.state === "recording") recorder.current.stop(); setRec(false); };
  const start = async () => {
    setMicErr(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream); const chunks: Blob[] = [];
      r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      r.onstop = () => { stream.getTracks().forEach((t) => t.stop()); if (chunks.length) void run(new Blob(chunks, { type: (r.mimeType || "audio/webm").split(";")[0] }), "voice-note"); };
      recorder.current = r; r.start(); setRec(true); setSecs(0);
      timer.current = setInterval(() => setSecs((n) => { if (n + 1 >= MAX_SECONDS) stop(); return n + 1; }), 1000);
    } catch { setMicErr(true); }
  };

  return (
    <div className="space-y-2" data-testid="voice-recorder">
      <p className="block text-sm font-bold" id="ir-voice-label">{c("c.voice")}</p>
      <p className="text-xs">{c("c.issue.voiceHelp")}</p>
      {canRecord && (
        <div className="flex items-center gap-3 flex-wrap">
          {!rec
            ? <Btn data-testid="ir-record" onClick={() => void start()} aria-describedby="ir-voice-label"><span aria-hidden="true">🎤 </span>{c("c.issue.record")}</Btn>
            : <Btn data-testid="ir-stop" onClick={stop}><span aria-hidden="true">⏹ </span>{c("c.issue.stop")}</Btn>}
          {rec && <span role="status" data-testid="ir-recording">{c("c.issue.recording")} {secs}s</span>}
        </div>
      )}
      {micErr && <p role="alert" data-testid="mic-denied" className="text-sm font-bold">{c("c.issue.micDenied")}</p>}
      <label htmlFor="ir-voice" className="block text-xs">{c("c.issue.voiceFile")}</label>
      <input id="ir-voice" data-testid="ir-voice" type="file" accept="audio/*" className="w-full min-h-[44px] text-sm"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void run(f, f.name); }} />
      <Progress s={s} retry={retry} clear={clear} removeKey="c.issue.voiceRemove" />
      <span className="sr-only" aria-live="polite">{s.phase === "done" ? c("c.issue.uploaded") : ""}</span>
    </div>
  );
}
