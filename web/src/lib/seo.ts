import type { Metadata } from "next";
import type { Match } from "./types";
import { fmtDate, TZ } from "./format";

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://unitedmfl.com").replace(/\/$/, "");
export const SITE_NAME = "United MFL";
export const ORG_ID = `${SITE_URL}/#organization`;
export const DEFAULT_OG = "/opengraph-image";

export const abs = (path: string) => (/^https?:\/\//.test(path) ? path : `${SITE_URL}${path.startsWith("/") ? "" : "/"}${path}`);

/** Latin slug; Uzbek apostrophes (o‘, g‘, ʼ) are dropped rather than turned into dashes. */
export function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[‘’ʻʼ'`]/g, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isoDay(iso: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

type MatchLike = Pick<Match, "id" | "kickoff_at"> & { home: { name: string } | null; away: { name: string } | null; stage?: { name: string } | null };

/** /matchlar/12-a1-blacstone-2026-06-19 — stable across upcoming/live/finished. */
export function matchPath(m: MatchLike) {
  const teams = m.home && m.away ? `${slugify(m.home.name)}-${slugify(m.away.name)}` : slugify(m.stage?.name || "match");
  const day = m.kickoff_at ? `-${isoDay(m.kickoff_at)}` : "";
  return `/matchlar/${m.id}-${teams}${day}`;
}
export const playerPath = (p: { id: number; full_name?: string; name?: string }) => `/oyinchilar/${p.id}-${slugify(p.full_name || p.name || "oyinchi")}`;
export const teamPath = (t: { slug: string }) => `/jamoalar/${t.slug}`;
export const newsPath = (n: { slug: string }) => `/yangiliklar/${n.slug}`;
export const productPath = (p: { slug: string }) => `/merch/${p.slug}`;

/** Extracts the numeric id from "12-a1-blacstone-2026-06-19" (or a bare "12"). */
export function idFromParam(param: string): number | null {
  const m = /^(\d+)(?:-[a-z0-9-]*)?$/.exec(decodeURIComponent(param));
  return m ? Number(m[1]) : null;
}

export function clip(s: string, n = 158) {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 20)).replace(/[,.;:\s—-]+$/, "") + "…";
}

type PageMeta = {
  title: string;
  description: string;
  path: string;
  image?: string | null;
  type?: "website" | "article" | "profile";
  noindex?: boolean;
  /** canonical differs from path (e.g. filtered list → base list) */
  canonical?: string;
  publishedTime?: string;
  modifiedTime?: string;
  absoluteTitle?: boolean;
};

/** Metadata with canonical, Open Graph and Twitter cards for one page. */
export function pageMeta(p: PageMeta): Metadata {
  const url = abs(p.canonical ?? p.path);
  const images = [{ url: abs(p.image || DEFAULT_OG), width: 1200, height: 630, alt: p.title }];
  return {
    title: p.absoluteTitle ? { absolute: p.title } : p.title,
    description: p.description,
    alternates: { canonical: url },
    robots: p.noindex ? { index: false, follow: true } : undefined,
    openGraph: {
      type: p.type || "website",
      url,
      title: p.title,
      description: p.description,
      siteName: SITE_NAME,
      locale: "uz_UZ",
      images,
      ...(p.type === "article" ? { publishedTime: p.publishedTime, modifiedTime: p.modifiedTime } : {}),
    },
    twitter: { card: "summary_large_image", title: p.title, description: p.description, images: images.map((i) => i.url) },
  };
}

/* ---------- JSON-LD builders (only real data, no invented properties) ---------- */

export function breadcrumbLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: abs(it.path) })),
  };
}

export const orgRef = { "@type": "SportsOrganization", "@id": ORG_ID, name: SITE_NAME, url: SITE_URL };

/** First candidate that fits a search-result title (the " | United MFL" suffix is added by the layout). */
export function fitTitle(...candidates: string[]) {
  return candidates.find((c) => c.length <= 57) || candidates[candidates.length - 1];
}

export function matchTitle(m: Match) {
  const h = m.home?.name || "Aniqlanmagan", a = m.away?.name || "Aniqlanmagan";
  const played = m.home_score != null && m.away_score != null && m.status !== "scheduled";
  if (m.status === "live" || m.status === "halftime") return fitTitle(`JONLI: ${h} ${m.home_score ?? 0}:${m.away_score ?? 0} ${a} — ${m.stage?.name || "match"}`, `JONLI: ${h} ${m.home_score ?? 0}:${m.away_score ?? 0} ${a}`);
  if (played) return fitTitle(`${h} ${m.home_score}:${m.away_score} ${a} — natija, tarkiblar va voqealar`, `${h} ${m.home_score}:${m.away_score} ${a} — natija va tarkiblar`, `${h} ${m.home_score}:${m.away_score} ${a} — natija`);
  if (!m.home && !m.away) return fitTitle(`${m.stage?.name || "Match"} — ${fmtDate(m.kickoff_at)}${m.venue ? `, ${m.venue.split(",")[0]}` : ""}`, `${m.stage?.name || "Match"} — ${fmtDate(m.kickoff_at)}`);
  return fitTitle(`${h} — ${a}, ${fmtDate(m.kickoff_at)}: ${m.stage?.name || "match"}`, `${h} — ${a}, ${fmtDate(m.kickoff_at)}`);
}
