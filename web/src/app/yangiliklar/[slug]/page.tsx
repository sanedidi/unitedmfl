import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { api, apiOrNull, safe } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import type { MatchDetail, NewsItem } from "@/lib/types";
import { Prose } from "@/components/Prose";
import { NewsCard } from "@/components/Cards";
import { ChevronRight } from "@/components/Icons";
import { JsonLd } from "@/components/JsonLd";
import { Img } from "@/components/Img";
import { ViewBeacon } from "@/components/ViewBeacon";
import { abs, breadcrumbLd, clip, fitTitle, DEFAULT_OG, matchPath, newsPath, ORG_ID, orgRef, pageMeta, SITE_URL } from "@/lib/seo";

type P = Promise<{ slug: string }>;
// cache() dedupes the request between generateMetadata and the page.
const load = cache(async (slug: string) => apiOrNull<NewsItem>(`/news/${encodeURIComponent(slug)}`));

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const n = await load((await params).slug);
  if (!n) return { title: "Yangilik topilmadi", robots: { index: false } };
  return pageMeta({
    title: fitTitle(n.title, clip(n.title, 57)),
    description: clip(n.seo_description || (n.excerpt && n.excerpt.length >= 80 ? n.excerpt : `${n.title}. ${n.excerpt || ""} United MFL yangiliklari.`)),
    path: newsPath(n),
    image: n.cover_url || null,
    type: "article",
    publishedTime: n.published_at,
    modifiedTime: n.updated_at,
  });
}

export default async function ArticlePage({ params }: { params: P }) {
  const n = await load((await params).slug);
  if (!n) notFound();
  const [latest, match] = await Promise.all([
    safe(api<NewsItem[]>("/news?limit=4"), []),
    n.match_id ? apiOrNull<MatchDetail>(`/matches/${n.match_id}`) : Promise.resolve(null),
  ]);
  const more = latest.filter((x) => x.slug !== n.slug).slice(0, 3);
  const url = abs(newsPath(n));
  const modified = n.updated_at && new Date(n.updated_at) > new Date(n.published_at) ? n.updated_at : undefined;
  const articleLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "@id": `${url}#article`,
    mainEntityOfPage: url,
    headline: n.title.slice(0, 110),
    description: n.seo_description || n.excerpt || undefined,
    image: [abs(n.cover_url || DEFAULT_OG)],
    datePublished: n.published_at,
    dateModified: modified || n.published_at,
    inLanguage: "uz",
    author: n.author ? { "@type": "Person", name: n.author } : { "@type": "Organization", "@id": ORG_ID, name: "United MFL", url: SITE_URL },
    publisher: { ...orgRef, logo: { "@type": "ImageObject", url: `${SITE_URL}/icon.png` } },
    ...(n.category ? { articleSection: n.category } : {}),
    ...(n.tags?.length ? { keywords: n.tags.join(", ") } : {}),
    ...(match ? { about: { "@type": "SportsEvent", name: `${match.match.home?.name || "?"} — ${match.match.away?.name || "?"}`, url: abs(matchPath(match.match)) } } : {}),
  };
  return (
    <>
      <article className="container">
        <div className="article">
          <nav className="crumbs" aria-label="Breadcrumb"><Link href="/yangiliklar">Yangiliklar</Link><ChevronRight size={12} /><b>{n.category || "Maqola"}</b></nav>
          {n.category && <div className="overline">{n.category}</div>}
          <h1 className="h1">{n.title}</h1>
          <div className="row muted" style={{ fontSize: 14, margin: "16px 0 28px", flexWrap: "wrap" }}>
            <time dateTime={n.published_at}>{fmtDate(n.published_at)}</time>
            {modified && <span>· yangilandi <time dateTime={modified}>{fmtDate(modified)}</time></span>}
            {n.author && <span>· {n.author}</span>}
            {match && <><span>·</span><Link href={matchPath(match.match)} className="accent">{match.match.home?.name} — {match.match.away?.name}: match markazi</Link></>}
          </div>
          {n.cover_url && (
            <div style={{ position: "relative", aspectRatio: "16 / 9", borderRadius: 16, overflow: "hidden", marginBottom: 32, background: "var(--ink-850)" }}>
              <Img src={n.cover_url} alt={n.title} sizes="(max-width: 800px) 100vw, 760px" priority />
            </div>
          )}
          {n.excerpt && <p className="lead" style={{ marginBottom: 24, color: "var(--text)" }}>{n.excerpt}</p>}
          {n.body ? <Prose text={n.body} /> : null}
          {n.tags?.length > 0 && <div className="chips" style={{ marginTop: 32 }}>{n.tags.map((t) => <span key={t} className="chip">#{t}</span>)}</div>}
        </div>
      </article>
      {more.length > 0 && (
        <section className="section">
          <div className="container">
            <h2 className="h3" style={{ marginBottom: 20 }}>Boshqa yangiliklar</h2>
            <div className="grid grid-3">{more.map((x) => <NewsCard key={x.slug} item={x} />)}</div>
          </div>
        </section>
      )}
      <ViewBeacon slug={n.slug} />
      <JsonLd data={articleLd} />
      <JsonLd data={breadcrumbLd([{ name: "Bosh sahifa", path: "/" }, { name: "Yangiliklar", path: "/yangiliklar" }, { name: n.title, path: newsPath(n) }])} />
    </>
  );
}
