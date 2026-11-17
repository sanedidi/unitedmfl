"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Close, Download, LinkIcon } from "./Icons";
import type { MatchPhoto } from "@/lib/types";
import { responsive } from "@/lib/img";

/** One photo tile: 4:3 thumbnail, opens the viewer. */
function Tile({ p, onOpen, more, big }: { p: MatchPhoto; onOpen: () => void; more?: number; big?: boolean }) {
  return (
    <button type="button" className={`ph-tile${big ? " big" : ""}`} onClick={onOpen} aria-label={more ? `Yana ${more} ta foto` : p.caption || "Fotoni ochish"}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img {...(big ? responsive(p.url, "(max-width: 720px) 100vw, 66vw") : { src: p.thumb_url })} alt={p.caption} loading="lazy" decoding="async" width={p.width || undefined} height={p.height || undefined} />
      {more ? <span className="ph-more">+{more}</span> : null}
    </button>
  );
}

/** Media tab grid: first `step` photos, then «Yana N ta foto». */
export function PhotoGrid({ photos, onOpen }: { photos: MatchPhoto[]; onOpen: (i: number) => void }) {
  const [shown, setShown] = useState(12);
  useEffect(() => {
    if (window.matchMedia("(max-width: 720px)").matches) setShown(8);
  }, []);
  const rest = photos.length - shown;
  return (
    <>
      <div className="ph-grid">
        {photos.slice(0, shown).map((p, i) => <Tile key={p.id} p={p} onOpen={() => onOpen(i)} />)}
      </div>
      {rest > 0 && (
        <div className="row" style={{ justifyContent: "center", marginTop: 20 }}>
          <button type="button" className="btn btn-ghost ph-more-btn" onClick={() => setShown((n) => n + 24)}>Yana {rest} ta foto</button>
        </div>
      )}
    </>
  );
}

/** Overview teaser: one large + four small, the last says «+N». */
export function PhotoTeaser({ photos, credit, onOpen, onAll }: { photos: MatchPhoto[]; credit: string; onOpen: (i: number) => void; onAll: () => void }) {
  const small = photos.slice(1, 5);
  const more = photos.length - 5;
  return (
    <section className="card">
      <div className="ph-teaser-head">
        <h2 className="h4">Foto hisobot</h2>
        <button type="button" className="link-btn" onClick={onAll}>Barcha {photos.length} ta foto</button>
      </div>
      <div className={`ph-teaser${small.length ? "" : " single"}`}>
        <Tile p={photos[0]} big onOpen={() => onOpen(0)} />
        {small.length > 0 && (
          <div className="ph-teaser-side">
            {small.map((p, k) => <Tile key={p.id} p={p} onOpen={() => (k === 3 && more > 0 ? onAll() : onOpen(k + 1))} more={k === 3 && more > 0 ? more : undefined} />)}
          </div>
        )}
      </div>
      {credit && <p className="muted ph-credit">{credit}</p>}
    </section>
  );
}

/** Which of (at most) five dots marks the current photo. */
function dotOn(i: number, n: number) {
  if (n <= 5 || i < 2) return i;
  if (n - 1 - i < 2) return 4 - (n - 1 - i);
  return 2;
}

/** Full-screen viewer: arrows / ←→ / swipe, Esc closes, link to every photo. */
export function Lightbox({ photos, index, title, credit, onIndex, onClose }: {
  photos: MatchPhoto[]; index: number; title: string; credit: string; onIndex: (i: number) => void; onClose: () => void;
}) {
  const p = photos[index];
  const n = photos.length;
  const closeRef = useRef<HTMLButtonElement>(null);
  const touch = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const go = useCallback((d: number) => onIndex((index + d + n) % n), [index, n, onIndex]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
      opener?.focus?.();
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go, onClose]);
  // preload neighbours
  useEffect(() => {
    for (const d of [1, -1]) {
      const q = photos[(index + d + n) % n];
      if (q) new Image().src = q.url;
    }
  }, [index, n, photos]);

  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share && window.matchMedia("(pointer: coarse)").matches) await navigator.share({ title, url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      /* cancelled */
    }
  }

  if (!p) return null;
  // portal: page transitions animate opacity/transform on the page wrapper
  return createPortal(
    <div className="lb" role="dialog" aria-modal="true" aria-label={`Foto ${index + 1} / ${n}`}>
      <div className="lb-top">
        <div className="lb-title"><b className="tnum">{index + 1} / {n}</b><span>{title}</span></div>
        <div className="lb-actions">
          <a className="lb-btn hide-sm" href={p.url} download aria-label="Yuklab olish"><Download size={20} /></a>
          <button type="button" className="lb-btn hide-sm" onClick={share} aria-label="Havolani nusxalash"><LinkIcon size={20} /></button>
          {copied && <span className="lb-toast">Havola nusxalandi</span>}
          <button ref={closeRef} type="button" className="lb-btn" onClick={onClose} aria-label="Yopish"><Close size={20} /></button>
        </div>
      </div>
      <div
        className="lb-stage"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touch.current == null) return;
          const dx = e.changedTouches[0].clientX - touch.current;
          if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
          touch.current = null;
        }}
      >
        {n > 1 && <button type="button" className="lb-btn lb-nav prev" onClick={() => go(-1)} aria-label="Oldingi"><ChevronLeft size={24} /></button>}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={p.id} src={p.url} alt={p.caption} width={p.width || undefined} height={p.height || undefined} />
        {n > 1 && <button type="button" className="lb-btn lb-nav next" onClick={() => go(1)} aria-label="Keyingi"><ChevronRight size={24} /></button>}
      </div>
      <div className="lb-caption">
        {p.caption && <p>{p.caption}</p>}
        {credit && <span>{credit}</span>}
      </div>
      {n > 1 && (
        <div className="lb-thumbs" role="tablist" aria-label="Fotolar">
          {photos.map((q, i) => (
            <button key={q.id} type="button" role="tab" aria-selected={i === index} className={i === index ? "on" : ""} onClick={() => onIndex(i)} aria-label={`Foto ${i + 1}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={q.thumb_url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      <div className="lb-bottom show-sm">
        <span className="lb-dots" aria-hidden>
          {Array.from({ length: Math.min(n, 5) }, (_, k) => <i key={k} className={k === dotOn(index, n) ? "on" : ""} />)}
        </span>
        <span className="lb-actions">
          <a className="lb-btn" href={p.url} download aria-label="Yuklab olish"><Download size={20} /></a>
          <button type="button" className="lb-btn" onClick={share} aria-label="Ulashish"><LinkIcon size={20} /></button>
        </span>
      </div>
    </div>,
    document.body,
  );
}
