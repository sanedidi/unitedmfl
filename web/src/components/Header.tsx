"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Brand } from "./Logo";
import { ChevronDown, Close, Globe, Menu, Search } from "./Icons";

export const NAV = [
  { href: "/", label: "Bosh sahifa" },
  { href: "/matchlar", label: "Matchlar" },
  { href: "/jadval", label: "Jadval" },
  { href: "/statistika", label: "Statistika" },
  { href: "/jamoalar", label: "Jamoalar" },
  { href: "/oyinchilar", label: "O‘yinchilar" },
  { href: "/yangiliklar", label: "Yangiliklar" },
  { href: "/media", label: "Media" },
  { href: "/merch", label: "Merch" },
];

// Only Uzbek is published today; RU/EN are shown as "coming soon" instead of dead links.
const LANGS = [
  { code: "UZ", label: "O‘zbekcha", live: true },
  { code: "RU", label: "Русский", live: false },
  { code: "EN", label: "English", live: false },
];

export function Header({ ticketUrl }: { ticketUrl: string }) {
  const path = usePathname() || "/";
  const [open, setOpen] = useState(false);
  const lang = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    setOpen(false);
    lang.current?.removeAttribute("open");
  }, [path]);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));
  const external = /^https?:/.test(ticketUrl);
  const ext = external ? { target: "_blank", rel: "noopener noreferrer" } : {};

  // Esc closes the menu
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // The mobile menu is rendered next to <header>, not inside it, so the fixed
  // panel is positioned against the viewport rather than the sticky header.
  return (
    <>
      <header className="header">
        <div className="container header-inner">
          <Brand />
          <nav className="nav" aria-label="Asosiy menyu">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="header-actions">
            <Link href="/qidiruv" className="icon-btn" aria-label="Qidiruv">
              <Search size={20} />
            </Link>
            <details className="lang" ref={lang}>
              <summary aria-label="Til tanlash"><Globe size={16} /> UZ <ChevronDown size={14} /></summary>
              <div className="lang-menu">
                {LANGS.map((l) => (l.live ? (
                  <a key={l.code} href="/" aria-current="true">{l.label} <small>{l.code}</small></a>
                ) : (
                  <span key={l.code}>{l.label} <small>tez orada</small></span>
                )))}
              </div>
            </details>
            <a className="btn btn-primary" href={ticketUrl} {...ext}>Chipta olish</a>
            <button className="icon-btn menu-btn" aria-label={open ? "Menyuni yopish" : "Menyuni ochish"} aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((v) => !v)}>
              {open ? <Close size={22} /> : <Menu size={22} />}
            </button>
          </div>
        </div>
      </header>
      <nav id="mobile-nav" className="mobile-nav" data-open={open} aria-label="Mobil menyu" hidden={!open}>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined}>
            {n.label}
          </Link>
        ))}
        <Link href="/biz-haqimizda" aria-current={active("/biz-haqimizda") ? "page" : undefined}>Liga haqida</Link>
        <div className="seg" aria-label="Til">
          {LANGS.map((l) => (l.live ? <a key={l.code} href="/" aria-current="true">{l.code}</a> : <span key={l.code} title="Tez orada">{l.code}</span>))}
        </div>
        <a className="btn btn-primary btn-lg btn-block" style={{ marginTop: 16 }} href={ticketUrl} {...ext}>
          Chipta olish
        </a>
      </nav>
    </>
  );
}
