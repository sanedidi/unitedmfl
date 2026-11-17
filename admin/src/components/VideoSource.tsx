import { useEffect, useRef, useState } from "react";
import { ApiError, uploadImage, uploadWithProgress } from "@/lib/api";
import type { CardCtx } from "./Crud";
import { I } from "./Icons";
import { fmtBytes } from "./MatchPhotos";
import { useToast } from "./ui";

/** Must match MAX_VIDEO_MB on the server (deploy/.env, default 2048). */
export const MAX_VIDEO_MB = 2048;
const ACCEPT = "video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm";

export const isUploadedVideo = (u: string) => /\/uploads\/videos\/[0-9a-f]{32}\.(mp4|mov|webm)$/.test(u || "");
export function youtubeId(url: string) {
  const m = (url || "").match(/(?:youtu\.be\/|v=|shorts\/|embed\/|live\/)([\w-]{11})/);
  return m ? m[1] : "";
}

type Upload = { name: string; size: number; share: number; sent: boolean };

/** Reads the duration and grabs a cover frame in the browser (no ffmpeg on the server). */
async function probe(file: File): Promise<{ duration?: number; cover?: Blob }> {
  const src = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = src;
  const wait = (ev: "loadeddata" | "seeked") =>
    new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 20000);
      v.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
      v.addEventListener("error", () => { clearTimeout(t); rej(new Error("decode")); }, { once: true });
    });
  try {
    await wait("loadeddata");
    const duration = Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : undefined;
    if (!v.videoWidth) return { duration };
    v.currentTime = Math.min(1, (v.duration || 3) / 3);
    await wait("seeked");
    const w = Math.min(1280, v.videoWidth);
    const h = Math.round((w * v.videoHeight) / v.videoWidth);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    cv.getContext("2d")?.drawImage(v, 0, 0, w, h);
    const cover = await new Promise<Blob | undefined>((res) => cv.toBlob((b) => res(b || undefined), "image/jpeg", 0.85));
    return { duration, cover };
  } catch {
    return {}; // the browser can't decode this file (e.g. HEVC) — the admin fills these in
  } finally {
    URL.revokeObjectURL(src);
    v.removeAttribute("src");
    v.load();
  }
}

/**
 * «Video» card of the video edit page: upload a file (default) or paste a
 * YouTube link. Edits the hidden `source` and `url` fields of the form; while
 * a file is uploading `__uploading` keeps the Save button disabled.
 */
export function VideoSourceCard({ c }: { c: CardCtx }) {
  const { values, set, errors } = c;
  const source: "file" | "link" = values.source === "link" ? "link" : "file";
  const url: string = values.url || "";
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const latest = useRef(values);
  latest.current = values;
  // the address of the other mode is kept while switching back and forth
  const kept = useRef({ file: source === "file" ? url : "", link: source === "link" ? url : "" });
  const [up, setUp] = useState<Upload | null>(null);
  const [over, setOver] = useState(false);
  const [meta, setMeta] = useState<{ name: string; size: number } | null>(null);

  useEffect(() => () => abort.current?.abort(), []); // leaving the page stops the upload

  function switchTo(s: "file" | "link") {
    if (s === source || up) return;
    kept.current[source] = url;
    set("source", s);
    set("url", kept.current[s] || "");
  }

  async function pick(file?: File | null) {
    if (!file || up) return;
    if (!/\.(mp4|m4v|mov|webm)$/i.test(file.name) && !/^video\/(mp4|quicktime|webm)$/.test(file.type)) {
      toast("Faqat MP4, MOV yoki WebM video yuklash mumkin", "error");
      return;
    }
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
      toast(`Video ${MAX_VIDEO_MB / 1024} GB dan katta bo‘lmasligi kerak`, "error");
      return;
    }
    const ctl = new AbortController();
    abort.current = ctl;
    setUp({ name: file.name, size: file.size, share: 0, sent: false });
    set("__uploading", true);
    const probing = probe(file);
    try {
      const r = await uploadWithProgress<{ url: string; size: number }>("/admin/video-uploads", file,
        (share) => setUp((u) => u && { ...u, share }),
        () => setUp((u) => u && { ...u, sent: true }),
        ctl.signal);
      set("source", "file");
      set("url", r.url);
      kept.current.file = r.url;
      setMeta({ name: file.name, size: r.size });
      const { duration, cover } = await probing;
      const now = latest.current;
      if (duration && (now.duration_sec === "" || now.duration_sec == null)) set("duration_sec", String(duration));
      if (cover && !now.thumbnail_url) {
        try {
          set("thumbnail_url", await uploadImage(new File([cover], "muqova.jpg", { type: "image/jpeg" })));
        } catch {
          /* the cover is optional */
        }
      }
      toast("Video yuklandi — saqlashni unutmang");
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "aborted")) toast(e instanceof Error ? e.message : "Yuklashda xato", "error");
    } finally {
      abort.current = null;
      setUp(null);
      set("__uploading", false);
      if (input.current) input.current.value = "";
    }
  }

  const yt = source === "link" ? youtubeId(url) : "";
  const pct = up ? Math.round(up.share * 100) : 0;

  return (
    <div className="card">
      <div className="card-head"><h3>Video *</h3></div>
      <div className="card-pad stack" style={{ gap: 16 }}>
        <div className="seg" role="group" aria-label="Video manbasi" style={{ alignSelf: "flex-start" }}>
          <button type="button" aria-pressed={source === "file"} disabled={!!up} onClick={() => switchTo("file")}><I.upload size={15} /> Fayl yuklash</button>
          <button type="button" aria-pressed={source === "link"} disabled={!!up} onClick={() => switchTo("link")}><I.link size={15} /> YouTube havola</button>
        </div>

        {source === "file" ? (
          up ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="upload-row">
                <b className="small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={up.name}>{up.name}</b>
                <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => abort.current?.abort()}><I.x size={15} /> Bekor qilish</button>
              </div>
              <span className="muted small">
                {up.sent ? "Server faylni saqlayapti…" : `${fmtBytes(up.size * up.share)} / ${fmtBytes(up.size)} · ${pct}%`} · yuklash tugaguncha sahifani yopmang
              </span>
            </div>
          ) : url ? (
            <div className="stack" style={{ gap: 10 }}>
              <video key={url} className="video-preview" src={url} controls preload="metadata" poster={values.thumbnail_url || undefined} />
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                <span className="muted small">{meta ? `${meta.name} · ${fmtBytes(meta.size)}` : "Yuklangan video fayl"}</span>
                <div className="row">
                  <button type="button" className="btn btn-sm" onClick={() => input.current?.click()}><I.refresh size={15} /> Almashtirish</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => { set("url", ""); kept.current.file = ""; setMeta(null); }}>Olib tashlash</button>
                </div>
              </div>
            </div>
          ) : (
            <div
              className={`dropzone${over ? " over" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => input.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}
            >
              <I.upload size={24} />
              <b>Videoni shu yerga tashlang yoki kompyuterdan tanlang</b>
              <span className="muted small">MP4, MOV yoki WebM · {MAX_VIDEO_MB / 1024} GB gacha · 16:9 tavsiya etiladi</span>
              <span className="btn btn-sm">Fayl tanlash</span>
            </div>
          )
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <div className="field">
              <label htmlFor="f-url">Havola (YouTube) *</label>
              <input id="f-url" className="input" type="url" inputMode="url" placeholder="https://youtu.be/…" value={url} aria-invalid={!!errors.url || undefined}
                onChange={(e) => { set("url", e.target.value); kept.current.link = e.target.value; }} />
            </div>
            {yt && <iframe className="video-preview" src={`https://www.youtube-nocookie.com/embed/${yt}`} title="Video" loading="lazy" allow="encrypted-media; picture-in-picture" allowFullScreen />}
          </div>
        )}

        {errors.url ? <span className="err">{errors.url}</span> : source === "file" && !up && !url && <span className="muted small">Davomiylik va muqova fayldan avtomatik olinadi.</span>}
        <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => pick(e.target.files?.[0])} />
      </div>
    </div>
  );
}
