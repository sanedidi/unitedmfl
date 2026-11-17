"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Close, Play } from "./Icons";
import type { Partner } from "@/lib/types";
import { partnerHost, partnerKindLabel } from "@/lib/partners";
import { sized } from "@/lib/img";

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Logo tile / card logo: a partner with a video opens the video window,
 * otherwise the partner's site opens in a new tab (or nothing, without a link).
 */
export function PartnerLink({ p, className, label, children }: { p: Partner; className: string; label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (p.video_url) {
    return (
      <>
        <button type="button" className={className} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={label || `${p.name} — videoni ko‘rish`}>{children}</button>
        {open && <PartnerVideoModal p={p} onClose={() => setOpen(false)} />}
      </>
    );
  }
  if (p.url) {
    return <a className={className} href={p.url} target="_blank" rel="noopener noreferrer sponsored" aria-label={label || `${p.name} sayti`}>{children}</a>;
  }
  return <div className={className}>{children}</div>;
}

/** «Videoni ko‘rish» button of the featured sponsor. */
export function PartnerVideoButton({ p, className, children }: { p: Partner; className: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!p.video_url) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} aria-haspopup="dialog">{children}</button>
      {open && <PartnerVideoModal p={p} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The partner's promo video in a window over the page (design P4). */
export function PartnerVideoModal({ p, onClose }: { p: Partner; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(p.video_duration_sec || 0);
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
  function play() {
    setStarted(true);
    video.current?.play().catch(() => {});
  }
  return createPortal(
    <div className="pv" role="dialog" aria-modal="true" aria-label={`${p.name} — video`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pv-box">
        <div className="pv-head">
          <div className="pv-brand">
            <span className="pv-chip">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {p.logo_url ? <img {...sized(p.logo_url, 256)} alt="" /> : p.name}
            </span>
            <div className="pv-title"><b>{p.name}</b><span>{partnerKindLabel(p.kind)}</span></div>
          </div>
          <button ref={closeRef} type="button" className="pv-close" onClick={onClose} aria-label="Yopish"><Close size={18} /></button>
        </div>
        <div className="pv-stage">
          <video ref={video} src={`${p.video_url}#t=0.1`} controls={started} playsInline preload="metadata"
            onPlay={() => setStarted(true)}
            onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDur(d); }}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} />
          {!started && <button type="button" className="pv-play" onClick={play} aria-label="Videoni ijro etish"><Play size={32} /></button>}
        </div>
        <div className="pv-foot">
          <span className="pv-time">{fmtClock(time)}{dur ? ` / ${fmtClock(dur)}` : ""}</span>
          {p.url && <a className="pv-site" href={p.url} target="_blank" rel="noopener noreferrer sponsored">{partnerHost(p.url)} saytiga o‘tish <ArrowRight size={16} /></a>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
