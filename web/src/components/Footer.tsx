import type React from "react";
import Link from "next/link";
import { LogoMark } from "./Logo";
import { Instagram, Telegram, Youtube } from "./Icons";

export function Footer() {
  const year = new Date().getFullYear();
  // Social links are configured per deployment (no guessed handles in code).
  const socials = [
    { label: "Instagram", href: process.env.SOCIAL_INSTAGRAM, icon: <Instagram /> },
    { label: "Telegram", href: process.env.SOCIAL_TELEGRAM, icon: <Telegram /> },
    { label: "YouTube", href: process.env.SOCIAL_YOUTUBE, icon: <Youtube /> },
  ].filter((x): x is { label: string; href: string; icon: React.ReactElement } => !!x.href);
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div>
            <div className="row">
              <LogoMark size={40} />
              <b style={{ color: "#fff", fontFamily: "var(--font-display)", fontSize: 18 }}>UNITED MFL</b>
            </div>
            <p style={{ maxWidth: 320, marginTop: 16 }}>Media futbol ligasi: blogerlar, sportchilar va san’at yulduzlari jamoalari bir maydonda.</p>
            {socials.length > 0 && (
              <div className="socials">
                {socials.map((x) => (
                  <a key={x.label} href={x.href} target="_blank" rel="noopener noreferrer" aria-label={x.label}>{x.icon}</a>
                ))}
              </div>
            )}
          </div>
          <div>
            <h4>Turnir</h4>
            <ul>
              <li><Link href="/matchlar">Matchlar</Link></li>
              <li><Link href="/jadval">Turnir jadvali</Link></li>
              <li><Link href="/statistika">Statistika</Link></li>
              <li><Link href="/jamoalar">Jamoalar</Link></li>
              <li><Link href="/oyinchilar">O‘yinchilar</Link></li>
            </ul>
          </div>
          <div>
            <h4>Media</h4>
            <ul>
              <li><Link href="/yangiliklar">Yangiliklar</Link></li>
              <li><Link href="/media">Video</Link></li>
              <li><Link href="/merch">Merch</Link></li>
            </ul>
          </div>
          <div>
            <h4>Liga</h4>
            <ul>
              <li><Link href="/biz-haqimizda">Liga haqida</Link></li>
              <li><Link href="/biz-haqimizda#aloqa">Hamkorlik</Link></li>
              <li><Link href="/biz-haqimizda#aloqa">Aloqa</Link></li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© {year} United MFL. Barcha huquqlar himoyalangan.</span>
          <span>unitedmfl.com</span>
        </div>
      </div>
    </footer>
  );
}
