"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight, Clock, Pin, Ticket } from "./Icons";
import type { Banner } from "@/lib/types";

const INTERVAL = 5000;

function badgeClass(t: string) {
  if (t === "stage") return "badge badge-stage";
  if (t === "live") return "badge badge-live";
  if (t === "muted") return "badge badge-muted";
  return "badge badge-accent";
}

export function HeroCarousel({ banners, dates }: { banners: Banner[]; dates: Record<number, string> }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0);
  const touch = useRef<number | null>(null);
  const n = banners.length;

  const go = useCallback((to: number) => {
    setI(((to % n) + n) % n);
    setTick(0);
  }, [n]);

  useEffect(() => {
    if (n < 2 || paused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const step = 100;
    const t = setInterval(() => {
      setTick((v) => {
        if (v + step >= INTERVAL) {
          setI((x) => (x + 1) % n);
          return 0;
        }
        return v + step;
      });
    }, step);
    return () => clearInterval(t);
  }, [n, paused]);

  if (n === 0) return null;
  const b = banners[i];
  const ext = /^https?:/.test(b.cta_url);

  return (
    <section
      className="hero"
      aria-roledescription="carousel"
      aria-label="Asosiy e’lonlar"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touch.current == null) return;
        const dx = e.changedTouches[0].clientX - touch.current;
        if (Math.abs(dx) > 50) go(i + (dx < 0 ? 1 : -1));
        touch.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(i + 1);
        if (e.key === "ArrowLeft") go(i - 1);
      }}
    >
      {banners.map((s, k) => (
        <div key={s.id} className={`hero-slide${k === i ? " active" : ""}`} aria-hidden={k !== i} role="group" aria-roledescription="slide" aria-label={`${k + 1} / ${n}`}>
          {s.image_desktop || s.image_mobile ? (
            <picture>
              {s.image_mobile && <source media="(max-width: 720px)" srcSet={s.image_mobile} />}
              <img src={s.image_desktop || s.image_mobile} alt={s.title} fetchPriority={k === 0 ? "high" : "auto"} loading={k === 0 ? "eager" : "lazy"} />
            </picture>
          ) : (
            <div className="hero-art">
              <div>
                <div className="kicker">UNITED MFL · {s.badge || "2026"}</div>
                <div className="title">{s.title}</div>
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="hero-shade" />

      <div className="hero-bar">
        <div className="hero-info" aria-live="polite">
          <h2>
            {b.badge && <span className={badgeClass(b.badge_type)}>{b.badge}</span>}
            <span>{b.title}</span>
          </h2>
          <div className="hero-meta">
            {b.event_date && <span><Calendar size={14} /> {dates[b.id]}</span>}
            {b.event_time && <span><Clock size={14} /> {b.event_time}</span>}
            {b.venue && <span><Pin size={14} /> {b.venue}</span>}
          </div>
        </div>
        {b.cta_url && (
          <a className="btn btn-primary" href={b.cta_url} {...(ext ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            {b.cta_label || "Batafsil"} <Ticket />
          </a>
        )}
        {n > 1 && (
          <>
            <span className="hero-divider" />
            <div className="hero-thumbs" role="tablist" aria-label="Slaydlar">
              {banners.map((s, k) => (
                <button key={s.id} role="tab" aria-selected={k === i} aria-label={s.title} className={`hero-thumb${k === i ? " active" : ""}`} onClick={() => go(k)}>
                  {s.image_desktop ? <img src={s.image_desktop} alt="" loading="lazy" /> : s.badge || s.title}
                  {k === i && <span className="progress" style={{ width: `${(tick / INTERVAL) * 100}%` }} />}
                </button>
              ))}
            </div>
            <div className="hero-arrows">
              <button className="icon-btn" aria-label="Oldingi" onClick={() => go(i - 1)}><ChevronLeft size={20} /></button>
              <button className="icon-btn" aria-label="Keyingi" onClick={() => go(i + 1)}><ChevronRight size={20} /></button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
