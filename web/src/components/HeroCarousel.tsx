"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { getImageProps } from "next/image";
import Link from "next/link";
import { Calendar, Clock, Pin } from "./Icons";
import { HERO_LAYOUTS, type Banner, type HeroLayout } from "@/lib/types";

import { useT } from "@/lib/i18n";
const INTERVAL = 6000;

/**
 * Full-bleed slide photo. Desktop image fills the whole hero; an optional
 * portrait image replaces it on phones. The first slide is the LCP image.
 */
function HeroPicture({ desktop, mobile, alt, first, onRatio }: { desktop: string; mobile: string; alt: string; first: boolean; onRatio?: (r: number) => void }) {
  const main = desktop || mobile;
  const local = (u: string) => u.startsWith("/uploads/");
  const common = { alt, fill: true, sizes: "100vw", priority: first, quality: 80 } as const;
  // the natural proportions of the picture actually shown (desktop or mobile source):
  // the panel layout sizes its photo block to them, so a poster is never cut off
  const loaded = (e: SyntheticEvent<HTMLImageElement>) => {
    const im = e.currentTarget;
    if (im.naturalWidth && im.naturalHeight) onRatio?.(im.naturalWidth / im.naturalHeight);
  };
  const ref = (im: HTMLImageElement | null) => {
    if (im?.complete && im.naturalWidth) onRatio?.(im.naturalWidth / im.naturalHeight);
  };
  const img = local(main)
    ? (() => { const { props } = getImageProps({ ...common, src: main }); return <img {...props} ref={ref} onLoad={loaded} alt={alt} className="hero-img" />; })()
    // eslint-disable-next-line @next/next/no-img-element
    : <img src={main} ref={ref} onLoad={loaded} alt={alt} className="hero-img" fetchPriority={first ? "high" : "auto"} loading={first ? "eager" : "lazy"} decoding="async" />;
  if (!mobile || mobile === main) return img;
  const srcSet = local(mobile) ? getImageProps({ ...common, src: mobile }).props.srcSet : mobile;
  return (
    <picture>
      <source media="(max-width: 720px)" srcSet={srcSet} sizes="100vw" />
      {img}
    </picture>
  );
}

/**
 * Home hero. Each banner picks how its copy sits over the photo (`layout`):
 * shade, panel, glass, split or poster — every one puts a solid or dark
 * translucent surface under the text, so it stays readable on any photo.
 * `layout` overrides the banner's own choice (used by /internal/hero).
 */
export function HeroCarousel({ banners, dates, season = "United MFL 2026", layout: force, label: labelProp }: {
  banners: Banner[]; dates: Record<number, string>; season?: string; layout?: HeroLayout; label?: string;
}) {
  const tx = useT();
  const label = labelProp ?? tx("Asosiy e’lonlar");
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
  const [ratios, setRatios] = useState<Record<number, number>>({});
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
  const want = force || b.layout;
  const layout: HeroLayout = want && HERO_LAYOUTS.includes(want) ? want : "shade";

  return (
    <section
      className={`hero hero-full hero--${layout} on-dark`}
      aria-roledescription="carousel"
      aria-label={label}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(i + 1);
        if (e.key === "ArrowLeft") go(i - 1);
      }}
    >
      <div
        className="hero-bg"
        style={ratios[b.id] ? ({ ["--ratio" as string]: String(ratios[b.id]) } as CSSProperties) : undefined}
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
            {s.image_desktop || s.image_mobile
              ? <HeroPicture desktop={s.image_desktop} mobile={s.image_mobile} alt={s.title} first={k === 0}
                  onRatio={(r) => setRatios((m) => (Math.abs((m[s.id] || 0) - r) < 0.001 ? m : { ...m, [s.id]: r }))} />
              : <div className="hero-art" />}
          </div>
        ))}
        <div className="hero-shade" aria-hidden />
      </div>

      <div className="hero-stage">
        <div className="container hero-inner">
          <div className="hero-copy" aria-live="polite">
            <div className="hero-text">
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
                  {b.cta_label || tx("Batafsil")}
                </a>
              )}
              <Link className="btn btn-ghost btn-lg" href="/matchlar">{tx("Matchlar taqvimi")}</Link>
            </div>
          </div>

          {n > 1 && (
            <>
              <div className="hero-tabs" role="tablist" aria-label={tx("Slaydlar")} style={{ ["--n" as string]: Math.min(n, 4) }}>
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
      </div>
    </section>
  );
}
