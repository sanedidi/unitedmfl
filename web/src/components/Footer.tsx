import type React from "react";
import Link from "next/link";
import { Logo } from "./Logo";
import { Instagram, Telegram, Youtube } from "./Icons";

import { useT } from "@/lib/i18n";
export function Footer() {
  const tx = useT();
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
            <Link href="/" className="brand" aria-label={tx("United MFL — bosh sahifa")}><Logo size={52} /></Link>
            <p style={{ maxWidth: 360, margin: "16px 0 0" }}>{tx("Media-futbol ligasi: blogerlar, sportchilar va san’at yulduzlari jamoalari. Rasmiy natijalar, jadval va statistika.")}</p>
            {socials.length > 0 && (
              <div className="socials">
                {socials.map((x) => (
                  <a key={x.label} href={x.href} target="_blank" rel="noopener noreferrer" aria-label={x.label}>{x.icon}</a>
                ))}
              </div>
            )}
          </div>
          <div>
            <h4>{tx("Turnir")}</h4>
            <ul>
              <li><Link href="/matchlar">{tx("Matchlar")}</Link></li>
              <li><Link href="/jadval">{tx("Turnir jadvali")}</Link></li>
              <li><Link href="/statistika">{tx("Statistika")}</Link></li>
              <li><Link href="/jamoalar">{tx("Jamoalar")}</Link></li>
              <li><Link href="/oyinchilar">{tx("O‘yinchilar")}</Link></li>
            </ul>
          </div>
          <div>
            <h4>{tx("Media")}</h4>
            <ul>
              <li><Link href="/yangiliklar">{tx("Yangiliklar")}</Link></li>
              <li><Link href="/media">{tx("Video")}</Link></li>
              <li><Link href="/merch">{tx("Merch")}</Link></li>
            </ul>
          </div>
          <div>
            <h4>{tx("Liga")}</h4>
            <ul>
              <li><Link href="/biz-haqimizda">{tx("Liga haqida")}</Link></li>
              <li><Link href="/hamkorlar">{tx("Hamkorlar")}</Link></li>
              <li><Link href="/biz-haqimizda#aloqa">{tx("Aloqa")}</Link></li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>{tx("© {0} United MFL. Barcha huquqlar himoyalangan.", year)}</span>
          <span>{tx("O‘zbekcha va Русский · English — tez orada")}</span>
        </div>
      </div>
    </footer>
  );
}
