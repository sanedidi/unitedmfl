import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { I } from "./Icons";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { ROLE_LABEL, initials } from "@/lib/format";
import { Logo } from "./Logo";
import { OnlinePill } from "./SiteVisits";

export type Item = { to: string; label: string; icon: ReactNode; perm: string; count?: "protocols" | "requests" | "applications" };
export const NAV: { group?: string; items: Item[] }[] = [
  { items: [{ to: "/", label: "Dashboard", icon: <I.grid />, perm: "dashboard" }] },
  { group: "Turnir", items: [
    { to: "/matches", label: "Matchlar", icon: <I.calendar />, perm: "matches" },
    { to: "/protocols", label: "Protokollar", icon: <I.doc />, perm: "protocols", count: "protocols" },
    { to: "/live", label: "Live-pult", icon: <I.radio />, perm: "live" },
    { to: "/teams", label: "Jamoalar", icon: <I.shirt />, perm: "teams" },
    { to: "/applications", label: "Arizalar", icon: <I.link />, perm: "applications", count: "applications" },
    { to: "/groups", label: "Guruhlar", icon: <I.grid />, perm: "groups" },
    { to: "/players", label: "O‘yinchilar", icon: <I.user />, perm: "players" },
    { to: "/standings", label: "Turnir jadvali", icon: <I.table />, perm: "standings" },
    { to: "/seasons", label: "Mavsumlar", icon: <I.trophy />, perm: "seasons" },
  ] },
  { group: "Kontent", items: [
    { to: "/homepage", label: "Bosh sahifa", icon: <I.globe />, perm: "homepage" },
    { to: "/news", label: "Yangiliklar", icon: <I.news />, perm: "news" },
    { to: "/banners", label: "Hero-bannerlar", icon: <I.image />, perm: "banners" },
    { to: "/videos", label: "Videolar", icon: <I.play />, perm: "videos" },
    { to: "/partners", label: "Hamkorlar", icon: <I.link />, perm: "partners" },
    { to: "/instagram", label: "Instagram", icon: <I.camera />, perm: "instagram" },
  ] },
  { group: "Do‘kon va aloqa", items: [
    { to: "/tickets", label: "Chiptalar", icon: <I.ticket />, perm: "tickets" },
    { to: "/stadiums", label: "Stadionlar", icon: <I.stadium />, perm: "stadiums" },
    { to: "/scan", label: "Kirish nazorati", icon: <I.qr />, perm: "scan" },
    { to: "/products", label: "Merch", icon: <I.bag />, perm: "merch" },
    { to: "/requests", label: "Murojaatlar", icon: <I.inbox />, perm: "requests", count: "requests" },
  ] },
  { group: "Tizim", items: [
    { to: "/ai", label: "AI-servis", icon: <I.sparkles />, perm: "ai" },
    { to: "/telegram-stickers", label: "Telegram stikerlar", icon: <I.telegram />, perm: "stickers" },
    { to: "/wildberries", label: "Wildberries", icon: <I.swap />, perm: "wildberries" },
    { to: "/users", label: "Foydalanuvchilar", icon: <I.users />, perm: "users" },
    { to: "/roles", label: "Rollar va huquqlar", icon: <I.lock />, perm: "roles" },
    { to: "/audit", label: "Audit jurnali", icon: <I.log />, perm: "audit" },
  ] },
];

/** The first menu page the user may open: where they land after signing in. */
export function firstPage(can: (perm: string) => boolean): Item | undefined {
  for (const g of NAV) for (const it of g.items) if (can(it.perm)) return it;
  return undefined;
}

export const SITE_URL = (import.meta.env.VITE_SITE_URL as string | undefined) || "https://unitedmfl.com";

export function Layout() {
  const { user, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<{ protocols: number; requests: number; applications: number }>({ protocols: 0, requests: 0, applications: 0 });
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!can("dashboard")) return;
    const load = () => api.get<{ kpi: { protocols_review: number; requests_new: number; applications_new?: number } }>("/admin/dashboard")
      .then((d) => setCounts({ protocols: d.kpi.protocols_review, requests: d.kpi.requests_new, applications: d.kpi.applications_new || 0 }))
      .catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [can]);

  return (
    <div className="shell">
      {open && <div className="sb-scrim" onClick={() => setOpen(false)} />}
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="sb-brand">
          <Logo size={36} />
          <span className="tagline">Admin</span>
        </div>
        {NAV.map((g, i) => {
          const items = g.items.filter((it) => can(it.perm));
          if (!items.length) return null;
          return (
            <div key={i}>
              {g.group && <div className="sb-group">{g.group}</div>}
              {items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.to === "/"} className={({ isActive }) => `sb-link${isActive ? " active" : ""}`}>
                  {it.icon}<span>{it.label}</span>
                  {it.count && counts[it.count] > 0 && <span className="count">{counts[it.count]}</span>}
                </NavLink>
              ))}
            </div>
          );
        })}
        <div className="sb-user">
          <span className="avatar">{initials(user?.name || "?")}</span>
          <div className="grow"><b>{user?.name}</b><small>{user?.role_name || ROLE_LABEL[user?.role || ""] || user?.role}</small></div>
          <button className="btn btn-ghost btn-icon" title="Chiqish" aria-label="Chiqish" onClick={logout}><I.logout /></button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost btn-icon menu-toggle" aria-label="Menyu" onClick={() => setOpen(true)}><I.menu /></button>
          <Logo size={30} className="mobile-brand" />
          <div className="grow" />
          {can("dashboard") && <OnlinePill />}
          <span className="env hide-mobile">Mavsum 2026</span>
          <a className="btn btn-sm" href={SITE_URL} target="_blank" rel="noopener noreferrer"><I.globe size={16} /> <span className="hide-mobile">Saytni ochish</span></a>
        </header>
        <div className="content"><Outlet /></div>
      </div>
    </div>
  );
}

export function PageHead({ title, sub, actions, pre }: { title: string; sub?: ReactNode; actions?: ReactNode; pre?: ReactNode }) {
  return (
    <div className="page-head">
      <div>{pre && <div className="page-pre">{pre}</div>}<h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}
