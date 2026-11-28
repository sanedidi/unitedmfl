"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Close, Play } from "./Icons";
import { fmtDate } from "@/lib/format";
import type { Video } from "@/lib/types";
import { sized } from "@/lib/img";

import { useT } from "@/lib/i18n";
/** Card of an uploaded video file: opens our own player instead of leaving the site. */
export function FileVideoCard({ v }: { v: Video }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="video-card" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <div className="video-thumb">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {v.thumbnail_url && <img {...sized(v.thumbnail_url, 480)} alt="" loading="lazy" decoding="async" width={480} height={270} />}
          <span className="play"><Play size={20} /></span>
        </div>
        <div className="news-body">
          <h3>{v.title}</h3>
          {v.published_at && <span className="news-date">{fmtDate(v.published_at)}</span>}
        </div>
      </button>
      {open && <VideoModal v={v} onClose={() => setOpen(false)} />}
    </>
  );
}

export function VideoModal({ v, onClose }: { v: Pick<Video, "title" | "url" | "thumbnail_url">; onClose: () => void }) {
  const tx = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", key);
      opener?.focus?.();
    };
  }, [onClose]);
  // portal: page transitions animate opacity/transform on the page wrapper
  return createPortal(
    <div className="lb" role="dialog" aria-modal="true" aria-label={v.title}>
      <div className="lb-top">
        <div className="lb-title"><b>{v.title}</b></div>
        <div className="lb-actions">
          <button ref={closeRef} type="button" className="lb-btn" onClick={onClose} aria-label={tx("Yopish")}><Close size={20} /></button>
        </div>
      </div>
      <div className="lb-stage lb-video" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <video src={v.url} poster={v.thumbnail_url || undefined} controls autoPlay playsInline preload="metadata" />
      </div>
    </div>,
    document.body,
  );
}
