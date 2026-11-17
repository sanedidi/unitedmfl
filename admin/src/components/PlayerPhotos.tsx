import { useEffect, useState } from "react";
import { I } from "@/components/Icons";

// Player photos on the application review page: a 40 px thumbnail in the
// roster and a viewer that opens it large (← → to the next player, Esc).

// same as SITE_URL in Layout
const SITE = ((import.meta.env.VITE_SITE_URL as string | undefined) || "https://unitedmfl.com").replace(/\/+$/, "");

/** Path of one of our uploads ("/uploads/…"), or "" for anything else. */
function uploadPath(src: string): string {
  if (src.startsWith("/uploads/")) return src;
  if (src.startsWith(SITE + "/uploads/")) return src.slice(SITE.length);
  return "";
}

/** A small resized WebP from the site's image optimizer instead of the full photo. */
function thumb(src: string, width: 64 | 128 | 256): string {
  const p = uploadPath(src);
  return p ? `${SITE}/_next/image?url=${encodeURIComponent(p)}&w=${width}&q=75` : src;
}

export function PhotoThumb({ src, name, onOpen }: { src: string; name: string; onOpen: () => void }) {
  const [url, setUrl] = useState(() => thumb(src, 128));
  useEffect(() => setUrl(thumb(src, 128)), [src]);
  if (!src) return <span className="pl-photo empty" title="Foto yuklanmagan" aria-label="Foto yuklanmagan"><I.user size={18} /></span>;
  return (
    <button type="button" className="pl-photo" onClick={onOpen} title="Fotoni kattalashtirish" aria-label={`${name} — fotoni kattalashtirish`}>
      {/* falls back to the original when the site's optimizer is not reachable */}
      <img src={url} alt="" loading="lazy" decoding="async" onError={() => { if (url !== src) setUrl(src); }} />
    </button>
  );
}

export type PhotoItem = { src: string; name: string; meta: string; file: string };

export function PhotoViewer({ items, start, onClose }: { items: PhotoItem[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const n = items.length;
  const it = items[i];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setI((x) => (x + 1) % n);
      else if (e.key === "ArrowLeft") setI((x) => (x - 1 + n) % n);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [n, onClose]);
  // warm up the neighbours so ← → feel instant
  useEffect(() => {
    for (const j of [i + 1, i - 1]) if (n > 1) new Image().src = items[(j + n) % n].src;
  }, [i, n, items]);
  if (!it) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal photo-viewer" role="dialog" aria-modal="true" aria-label={it.name}>
        <div className="modal-head"><h2>{it.name}</h2><button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Yopish"><I.x /></button></div>
        <div className="modal-body stack" style={{ gap: 12, padding: "20px 24px" }}>
          <div className="pv-stage">
            <img key={it.src} src={it.src} alt={it.name} />
            {n > 1 && <>
              <button type="button" className="pv-nav prev" onClick={() => setI((i - 1 + n) % n)} aria-label="Oldingi o‘yinchi"><span style={{ display: "inline-flex", transform: "rotate(90deg)" }}><I.down size={20} /></span></button>
              <button type="button" className="pv-nav next" onClick={() => setI((i + 1) % n)} aria-label="Keyingi o‘yinchi"><span style={{ display: "inline-flex", transform: "rotate(-90deg)" }}><I.down size={20} /></span></button>
            </>}
            <span className="pv-count tnum">{i + 1} / {n}</span>
          </div>
          <div className="small" style={{ color: "var(--text-2)" }}>{it.meta}</div>
        </div>
        <div className="modal-foot" style={{ alignItems: "center" }}>
          <span className="small muted grow hide-mobile">← → — almashtirish · Esc — yopish</span>
          <button className="btn btn-ghost" onClick={onClose}>Yopish</button>
          <a className="btn" href={it.src} download={it.file}><I.download size={16} /> Asl faylni yuklab olish</a>
        </div>
      </div>
    </div>
  );
}
