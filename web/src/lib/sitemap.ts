import { api } from "./api";
import { abs, SITE_URL, matchPath, newsPath, playerPath, productPath, teamPath } from "./seo";

type Src = {
  matches: { id: number; kickoff_at: string | null; updated_at: string; home: string | null; away: string | null; stage: string | null }[];
  teams: { slug: string; updated_at: string }[];
  players: { id: number; full_name: string; updated_at: string }[];
  news: { slug: string; published_at: string; updated_at: string }[];
  products: { slug: string; updated_at: string }[];
  videos_updated_at: string | null;
};
export type Url = { loc: string; lastmod?: string };

// Google's per-file limit is 50 000 URLs; stay well below it.
export const CHUNK = 10000;
export const SECTIONS = ["pages", "matches", "teams", "players", "news", "merch"] as const;
export type Section = (typeof SECTIONS)[number];

const max = (xs: (string | null | undefined)[]) => xs.filter(Boolean).sort().at(-1) || undefined;
const iso = (s?: string) => (s ? new Date(s).toISOString() : undefined);

export async function sitemapSource() {
  return api<Src>("/sitemap", { revalidate: 300 });
}

/** All canonical, indexable URLs with their real last-modified dates. */
export async function sectionUrls(section: Section): Promise<Url[]> {
  const s = await sitemapSource();
  switch (section) {
    case "pages": {
      const lastMatch = max(s.matches.map((m) => m.updated_at));
      const pages: Url[] = [
        { loc: SITE_URL, lastmod: iso(max([lastMatch, max(s.news.map((n) => n.updated_at))])) },
        { loc: abs("/matchlar"), lastmod: iso(lastMatch) },
        { loc: abs("/jadval"), lastmod: iso(lastMatch) },
        { loc: abs("/statistika"), lastmod: iso(lastMatch) },
        { loc: abs("/jamoalar"), lastmod: iso(max(s.teams.map((t) => t.updated_at))) },
        { loc: abs("/oyinchilar"), lastmod: iso(max(s.players.map((p) => p.updated_at))) },
        { loc: abs("/yangiliklar"), lastmod: iso(max(s.news.map((n) => n.updated_at))) },
        { loc: abs("/merch"), lastmod: iso(max(s.products.map((p) => p.updated_at))) },
        { loc: abs("/biz-haqimizda") },
      ];
      // /media is noindex while it has no videos
      if (s.videos_updated_at) pages.push({ loc: abs("/media"), lastmod: iso(s.videos_updated_at) });
      return pages;
    }
    case "matches":
      return s.matches.map((m) => ({
        loc: abs(matchPath({ id: m.id, kickoff_at: m.kickoff_at || "", home: m.home ? { name: m.home } : null, away: m.away ? { name: m.away } : null, stage: m.stage ? { name: m.stage } : null })),
        lastmod: iso(m.updated_at),
      }));
    case "teams":
      return s.teams.map((t) => ({ loc: abs(teamPath(t)), lastmod: iso(t.updated_at) }));
    case "players":
      return s.players.map((p) => ({ loc: abs(playerPath(p)), lastmod: iso(p.updated_at) }));
    case "news":
      return s.news.map((n) => ({ loc: abs(newsPath(n)), lastmod: iso(max([n.updated_at, n.published_at])) }));
    case "merch":
      return s.products.map((p) => ({ loc: abs(productPath(p)), lastmod: iso(p.updated_at) }));
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function urlsetXml(urls: Url[]) {
  const body = urls.map((u) => `<url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
export function indexXml(items: Url[]) {
  const body = items.map((u) => `<sitemap><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}
export const xmlResponse = (xml: string) => new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" } });
