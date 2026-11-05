"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Brand } from "./Logo";
import { Close, Menu, Search, Ticket } from "./Icons";

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

export function Header({ ticketUrl }: { ticketUrl: string }) {
  const path = usePathname() || "/";
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));
  const external = /^https?:/.test(ticketUrl);

  // Esc closes the menu
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // The mobile menu is rendered next to <header>, not inside it: the header's
  // backdrop-filter creates a containing block, which squeezed the fixed menu
  // into the header's own 64px box.
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
            <Search size={18} />
          </Link>
          <a className="btn btn-primary" href={ticketUrl} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            Chipta <Ticket />
          </a>
          <button className="icon-btn menu-btn" aria-label={open ? "Menyuni yopish" : "Menyuni ochish"} aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((v) => !v)}>
            {open ? <Close size={20} /> : <Menu size={20} />}
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
        <a className="btn btn-primary" style={{ marginTop: 20 }} href={ticketUrl} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
          Chipta sotib olish <Ticket />
        </a>
      </nav>
    </>
  );
}
