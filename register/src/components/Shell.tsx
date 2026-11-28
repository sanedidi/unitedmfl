import type { ReactNode } from "react";
import { I } from "./Icons";
import type { LinkState, PublicLink } from "@/lib/api";
import { fmtDeadline } from "@/lib/format";

import { tx } from "@/lib/i18n";
import { LangSwitch } from "./LangSwitch";
export const SITE_URL = (import.meta.env.VITE_SITE_URL as string | undefined) || "https://unitedmfl.com";
export const HELP_URL = (import.meta.env.VITE_HELP_URL as string | undefined) || "https://t.me/united_mfl";
const HELP_LABEL = HELP_URL.replace(/^https?:\/\/(t\.me\/)?/, "@").replace(/\/$/, "");

export function Header({ tag = tx("Jamoa arizasi") }: { tag?: string }) {
  return (
    <header className="hdr">
      <a className="brand" href={SITE_URL}><img src="/logo.svg" alt="" />{tx("United MFL")}</a>
      <span className="hdr-tag">{tag}</span>
      <div className="grow" />
      <LangSwitch />
      <a className="hdr-help" href={HELP_URL} target="_blank" rel="noopener noreferrer"><I.telegram size={16} /><span>{tx("Yordam:")}{" "}{HELP_LABEL}</span></a>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="ftr">
      <span>© {new Date().getFullYear()}{" "}{tx("United MFL")}</span>
      <div className="grow" />
      <a href={SITE_URL}>{tx("Liga sayti")}</a>
    </footer>
  );
}

export function Page({ children, tag }: { children: ReactNode; tag?: string }) {
  return (
    <>
      <Header tag={tag} />
      <main className="page">{children}</main>
      <Footer />
    </>
  );
}

function overline(l: PublicLink | null) {
  return [l?.season, tx("Arizalar qabuli")].filter(Boolean).join(" · ");
}

function metaPills(l: PublicLink | null, short = false) {
  if (!l) return null;
  const items: [ReactNode, string][] = [];
  if (l.closes_at) items.push([<I.clock size={16} />, short ? tx("{0} gacha", fmtDeadline(l.closes_at)) : tx("Qabul {0} gacha", fmtDeadline(l.closes_at))]);
  if (l.max_teams) items.push([<I.users size={16} />, tx("Bo‘sh joy: {0} / {1}", l.slots_left ?? 0, l.max_teams)]);
  if (l.stage && !short) items.push([<I.trophy size={16} />, l.stage]);
  if (!items.length) return null;
  return <div className="hero-meta">{items.map(([ic, t], i) => <span key={i} className="hero-pill">{ic}{t}</span>)}</div>;
}

export function Hero({ link }: { link: PublicLink | null }) {
  return (
    <section className="hero">
      <div className="over">{overline(link)}</div>
      <h1>{link?.heading || tx("Jamoangizni United MFL’ga ro‘yxatdan o‘tkazing")}</h1>
      <p>{link?.description || tx("Ariza 4 qadamda to‘ldiriladi, taxminan 10 daqiqa. Liga ma’muriyati arizani ko‘rib chiqadi va natijani sizga yetkazadi.")}</p>
      {metaPills(link)}
    </section>
  );
}

export function CompactHero({ link, title }: { link: PublicLink | null; title: string }) {
  return (
    <section className="hero compact">
      <div className="grow">
        <div className="over">{overline(link)}</div>
        <h1>{title}</h1>
      </div>
      {metaPills(link, true)}
    </section>
  );
}

export const STATE_TEXT: Record<Exclude<LinkState, "open"> | "none" | "missing", { icon: ReactNode; title: string; text: string }> = {
  none: { icon: <I.lock size={22} />, title: tx("Ro‘yxatdan o‘tish hozircha yopiq"), text: tx("Jamoalarni ro‘yxatga olish liga tomonidan ochiladi. Qabul boshlanganda havola liga kanallarida e’lon qilinadi.") },
  paused: { icon: <I.lock size={22} />, title: tx("Ro‘yxatdan o‘tish hozircha yopiq"), text: tx("Arizalar qabuli vaqtincha to‘xtatilgan. Qabul qayta ochilganda shu havola yana ishlaydi.") },
  soon: { icon: <I.clock size={22} />, title: tx("Arizalar qabuli hali boshlanmagan"), text: tx("Qabul boshlanishi bilan shu sahifada ariza to‘ldirish mumkin bo‘ladi.") },
  closed: { icon: <I.clock size={22} />, title: tx("Arizalar qabuli yakunlangan"), text: tx("Bu mavsum uchun qabul muddati tugadi. Keyingi qabul haqida liga kanallarida e’lon qilinadi.") },
  full: { icon: <I.users size={22} />, title: tx("Barcha joylar band"), text: tx("Yangi ariza qabul qilinmaydi. Joy bo‘shasa, liga qabulni qayta ochadi.") },
  used: { icon: <I.lock size={22} />, title: tx("Bu havola allaqachon ishlatilgan"), text: tx("Havola bitta jamoa uchun berilgan va ariza yuborilgan. Savol bo‘lsa, liga menejeriga yozing.") },
  missing: { icon: <I.alert size={22} />, title: tx("Havola ishlamaydi"), text: tx("Havola noto‘g‘ri yoki liga uni yangilagan. To‘g‘ri havolani liga menejeridan so‘rang.") },
};

export function StateCard({ state, link, children }: { state: keyof typeof STATE_TEXT; link?: PublicLink | null; children?: ReactNode }) {
  const s = STATE_TEXT[state];
  return (
    <div className="state-card">
      <div className="state-ic">{s.icon}</div>
      <h1>{s.title}</h1>
      <p className="sec">{s.text}</p>
      {state === "soon" && link?.opens_at && <p><b>{tx("Qabul boshlanadi:")}{" "}{fmtDeadline(link.opens_at)}</b></p>}
      {children}
      <div className="row wrapx" style={{ marginTop: 8 }}>
        <a className="btn" href={HELP_URL} target="_blank" rel="noopener noreferrer"><I.telegram size={16} />{" "}{tx("Liga menejeriga yozish")}</a>
        <a className="btn btn-ghost" href={SITE_URL}>{tx("Liga sayti")}</a>
      </div>
    </div>
  );
}
