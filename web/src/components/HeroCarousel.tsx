"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getImageProps } from "next/image";
import Link from "next/link";
import { Calendar, Clock, Pin } from "./Icons";
import type { Banner } from "@/lib/types";

const INTERVAL = 6000;

/** Approved poster in its native ~2:1 frame; the first slide is the LCP image. */
function HeroPicture({ src, alt, first }: { src: string; alt: string; first: boolean }) {
  if (!src.startsWith("/uploads/")) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} fetchPriority={first ? "high" : "auto"} loading={first ? "eager" : "lazy"} decoding="async" />;
  }
  const { props } = getImageProps({ src, alt, fill: true, sizes: "(max-width: 1024px) 100vw, 760px", priority: first, quality: 82 });
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} alt={alt} style={{ ...props.style, objectFit: "cover" }} />;
}

export function HeroCarousel({ banners, dates, season = "United MFL 2026" }: { banners: Banner[]; dates: Record<number, string>; season?: string }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  // Autoplay starts after the visitor's first interaction: rotating slides before
  // that would keep repainting the largest element and push back LCP.
  const [engaged, setEngaged] = useState(false);
  useEffect(() => {
    const go = () => setEngaged(true);
    const evs = ["scroll", "pointermove", "pointerdown", "keydown", "touchstart"] as const;
    evs.forEach((e) => window.addEventListener(e, go, { once: true, passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, go));
  }, []);
  const [tick, setTick] = useState(0);
  const touch = useRef<number | null>(null);
  const n = banners.length;

  const go = useCallback((to: number) => {
    setI(((to % n) + n) % n);
    setTick(0);
  }, [n]);

  useEffect(() => {
    if (n < 2 || paused || !engaged) return;
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
  }, [n, paused, engaged]);

  if (n === 0) return null;
  const b = banners[i];
  const ext = /^https?:/.test(b.cta_url);

  return (
    <section
      className="hero on-dark"
      aria-roledescription="carousel"
      aria-label="Asosiy e’lonlar"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(i + 1);
        if (e.key === "ArrowLeft") go(i - 1);
      }}
    >
      <div className="container">
        <div className="hero-grid">
          <div className="hero-copy" aria-live="polite">
            <div>
              <div className="hero-kicker">{season}{b.badge ? ` · ${b.badge}` : ""}</div>
              <div className="display" role="heading" aria-level={2}>{b.title}</div>
              <div className="hero-meta">
                {b.event_date && <span><Calendar size={16} /> {dates[b.id]}</span>}
                {b.event_time && <span><Clock size={16} /> {b.event_time}</span>}
                {b.venue && <span><Pin size={16} /> {b.venue}</span>}
              </div>
            </div>
            <div className="hero-ctas">
              {b.cta_url && (
                <a className="btn btn-primary btn-lg" href={b.cta_url} {...(ext ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                  {b.cta_label || "Batafsil"}
                </a>
              )}
              <Link className="btn btn-ghost btn-lg" href="/matchlar">Matchlar taqvimi</Link>
            </div>
          </div>

          <div
            className="hero-media"
            onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
            onTouchEnd={(e) => {
              if (touch.current == null) return;
              const dx = e.changedTouches[0].clientX - touch.current;
              if (Math.abs(dx) > 50) go(i + (dx < 0 ? 1 : -1));
              touch.current = null;
            }}
          >
            {banners.map((s, k) => (
              <div key={s.id} className={`hero-slide${k === i ? " active" : ""}`} aria-hidden={k !== i} role="group" aria-roledescription="slide" aria-label={`${k + 1} / ${n}`}>
                {s.image_desktop || s.image_mobile ? (
                  <HeroPicture src={s.image_desktop || s.image_mobile} alt={s.title} first={k === 0} />
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
          </div>
        </div>

        {n > 1 && (
          <>
            <div className="hero-tabs" role="tablist" aria-label="Slaydlar" style={{ ["--n" as string]: Math.min(n, 4) }}>
              {banners.slice(0, 4).map((s, k) => (
                <button key={s.id} role="tab" aria-selected={k === i} className={`hero-tab${k === i ? " active" : ""}`} onClick={() => go(k)}>
                  {k === i && <span className="progress" style={{ width: engaged && !paused ? `${(tick / INTERVAL) * 100}%` : "100%" }} />}
                  <b><small>{String(k + 1).padStart(2, "0")}</small>{s.title}</b>
                  <span>{[dates[s.id], s.event_time].filter(Boolean).join(" · ") || s.badge}</span>
                </button>
              ))}
            </div>
            <div className="hero-dots" aria-hidden>
              {banners.map((s, k) => <button key={s.id} tabIndex={-1} className={k === i ? "active" : ""} onClick={() => go(k)} />)}
              <span>{String(i + 1).padStart(2, "0")} / {String(n).padStart(2, "0")}</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
