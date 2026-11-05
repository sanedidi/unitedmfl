import type { MetadataRoute } from "next";
import { api, safe } from "@/lib/api";
import type { Match, NewsItem, Team } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "https://unitedmfl.com").replace(/\/$/, "");
  const [teams, matches, news] = await Promise.all([
    safe(api<Team[]>("/teams"), []),
    safe(api<Match[]>("/matches?limit=200"), []),
    safe(api<NewsItem[]>("/news?limit=200"), []),
  ]);
  const pages = ["", "/matchlar", "/jadval", "/statistika", "/jamoalar", "/oyinchilar", "/yangiliklar", "/media", "/merch", "/biz-haqimizda"];
  return [
    ...pages.map((p) => ({ url: `${base}${p}`, changeFrequency: "daily" as const, priority: p === "" ? 1 : 0.8 })),
    ...teams.map((t) => ({ url: `${base}/jamoalar/${t.slug}`, priority: 0.6 })),
    ...matches.map((m) => ({ url: `${base}/matchlar/${m.id}`, priority: 0.6 })),
    ...news.map((n) => ({ url: `${base}/yangiliklar/${n.slug}`, lastModified: n.published_at, priority: 0.7 })),
  ];
}
