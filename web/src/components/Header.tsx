"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Brand } from "./Logo";
import { ChevronDown, Close, Globe, Menu, Search } from "./Icons";
import { LANG_COOKIE, useLang, type Lang } from "@/lib/i18n";

import { useT } from "@/lib/i18n";
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

// UZ and RU are published; EN is shown as "coming soon" instead of a dead link.
const LANGS: { code: string; lang?: Lang; label: string }[] = [
  { code: "UZ", lang: "uz", label: "O‘zbekcha" },
  { code: "RU", lang: "ru", label: "Русский" },
  { code: "EN", label: "English" },
];

/** Remember the choice for a year and re-render the page in the new language. */
function switchLang(l: Lang) {
  document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
  window.location.reload();
}

export function Header({ ticketUrl }: { ticketUrl: string }) {
  const tx = useT();
  const cur = useLang();
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
          <nav className="nav" aria-label={tx("Asosiy menyu")}>
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined}>
                {tx(n.label)}
              </Link>
            ))}
          </nav>
          <div className="header-actions">
            <Link href="/qidiruv" className="icon-btn" aria-label={tx("Qidiruv")}>
              <Search size={20} />
            </Link>
            <details className="lang" ref={lang}>
              <summary aria-label={tx("Til tanlash")}><Globe size={16} /> {cur.toUpperCase()} <ChevronDown size={14} /></summary>
              <div className="lang-menu">
                {LANGS.map((l) => (l.lang ? (
                  <button key={l.code} type="button" lang={l.lang} aria-current={l.lang === cur ? "true" : undefined} onClick={() => l.lang !== cur && switchLang(l.lang!)}>{l.label} <small>{l.code}</small></button>
                ) : (
                  <span key={l.code}>{l.label} <small>{tx("tez orada")}</small></span>
                )))}
              </div>
            </details>
            <a className="btn btn-primary" href={ticketUrl} {...ext}>{tx("Chipta olish")}</a>
            <button className="icon-btn menu-btn" aria-label={open ? tx("Menyuni yopish") : tx("Menyuni ochish")} aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((v) => !v)}>
              {open ? <Close size={22} /> : <Menu size={22} />}
            </button>
          </div>
        </div>
      </header>
      <nav id="mobile-nav" className="mobile-nav" data-open={open} aria-label={tx("Mobil menyu")} hidden={!open}>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined}>
            {tx(n.label)}
          </Link>
        ))}
        <Link href="/biz-haqimizda" aria-current={active("/biz-haqimizda") ? "page" : undefined}>{tx("Liga haqida")}</Link>
        <div className="seg" aria-label={tx("Til")}>
          {LANGS.map((l) => (l.lang ? <button key={l.code} type="button" lang={l.lang} aria-current={l.lang === cur ? "true" : undefined} onClick={() => l.lang !== cur && switchLang(l.lang!)}>{l.code}</button> : <span key={l.code} title={tx("Tez orada")}>{l.code}</span>))}
        </div>
        <a className="btn btn-primary btn-lg btn-block" style={{ marginTop: 16 }} href={ticketUrl} {...ext}>{tx("Chipta olish")}</a>
      </nav>
    </>
  );
}
