import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { I } from "./Icons";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { ROLE_LABEL, initials } from "@/lib/format";
import { Logo } from "./Logo";

type Item = { to: string; label: string; icon: ReactNode; perm: string; count?: "protocols" | "requests" };
const NAV: { group?: string; items: Item[] }[] = [
  { items: [{ to: "/", label: "Dashboard", icon: <I.grid />, perm: "dashboard" }] },
  { group: "Turnir", items: [
    { to: "/matches", label: "Matchlar", icon: <I.calendar />, perm: "matches:read" },
    { to: "/protocols", label: "Protokollar", icon: <I.doc />, perm: "protocols", count: "protocols" },
    { to: "/live", label: "Live-pult", icon: <I.radio />, perm: "live" },
    { to: "/teams", label: "Jamoalar", icon: <I.shirt />, perm: "teams" },
    { to: "/players", label: "O‘yinchilar", icon: <I.user />, perm: "teams" },
    { to: "/standings", label: "Turnir jadvali", icon: <I.table />, perm: "standings" },
    { to: "/seasons", label: "Mavsumlar", icon: <I.trophy />, perm: "seasons" },
  ] },
  { group: "Kontent", items: [
    { to: "/news", label: "Yangiliklar", icon: <I.news />, perm: "news" },
    { to: "/banners", label: "Hero-bannerlar", icon: <I.image />, perm: "banners" },
    { to: "/videos", label: "Videolar", icon: <I.play />, perm: "videos" },
  ] },
  { group: "Do‘kon va aloqa", items: [
    { to: "/products", label: "Merch", icon: <I.bag />, perm: "merch" },
    { to: "/requests", label: "Murojaatlar", icon: <I.inbox />, perm: "requests", count: "requests" },
  ] },
  { group: "Tizim", items: [
    { to: "/users", label: "Foydalanuvchilar", icon: <I.users />, perm: "users" },
    { to: "/roles", label: "Rollar va huquqlar", icon: <I.lock />, perm: "users" },
    { to: "/audit", label: "Audit jurnali", icon: <I.log />, perm: "users" },
  ] },
];

export const SITE_URL = (import.meta.env.VITE_SITE_URL as string | undefined) || "https://unitedmfl.com";

export function Layout() {
  const { user, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<{ protocols: number; requests: number }>({ protocols: 0, requests: 0 });
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!can("dashboard")) return;
    const load = () => api.get<{ kpi: { protocols_review: number; requests_new: number } }>("/admin/dashboard")
      .then((d) => setCounts({ protocols: d.kpi.protocols_review, requests: d.kpi.requests_new }))
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
          <Logo compact />
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
          <div className="grow"><b>{user?.name}</b><small>{ROLE_LABEL[user?.role || ""] || user?.role}</small></div>
          <button className="btn btn-ghost btn-icon" title="Chiqish" aria-label="Chiqish" onClick={logout}><I.logout /></button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost btn-icon menu-toggle" aria-label="Menyu" onClick={() => setOpen(true)}><I.menu /></button>
          <Logo compact size={18} className="mobile-brand" />
          <div className="grow" />
          <span className="env hide-mobile">Mavsum 2026</span>
          <a className="btn btn-sm" href={SITE_URL} target="_blank" rel="noopener noreferrer"><I.globe size={16} /> <span className="hide-mobile">Saytni ochish</span></a>
        </header>
        <div className="content"><Outlet /></div>
      </div>
    </div>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}
