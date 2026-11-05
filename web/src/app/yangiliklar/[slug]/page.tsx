import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { api, apiOrNull, safe } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import type { NewsItem } from "@/lib/types";
import { Prose } from "@/components/Prose";
import { NewsCard } from "@/components/Cards";
import { ChevronRight } from "@/components/Icons";

type P = Promise<{ slug: string }>;
// cache() dedupes the request between generateMetadata and the page (one view counted).
const load = cache(async (slug: string) => apiOrNull<NewsItem>(`/news/${encodeURIComponent(slug)}`));

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const n = await load((await params).slug);
  if (!n) return { title: "Yangilik topilmadi" };
  return {
    title: n.title,
    description: n.seo_description || n.excerpt,
    openGraph: { type: "article", title: n.title, description: n.seo_description || n.excerpt, images: n.cover_url ? [n.cover_url] : undefined, publishedTime: n.published_at },
  };
}

export default async function ArticlePage({ params }: { params: P }) {
  const n = await load((await params).slug);
  if (!n) notFound();
  const more = (await safe(api<NewsItem[]>("/news?limit=4"), [])).filter((x) => x.slug !== n.slug).slice(0, 3);
  return (
    <>
      <article className="container">
        <div className="article">
          <nav className="crumbs"><Link href="/yangiliklar">Yangiliklar</Link><ChevronRight size={12} /><b>{n.category || "Maqola"}</b></nav>
          {n.category && <div className="overline">{n.category}</div>}
          <h1 className="h1">{n.title}</h1>
          <div className="row muted" style={{ fontSize: 14, margin: "16px 0 28px" }}>
            <time dateTime={n.published_at}>{fmtDate(n.published_at)}</time>
            {n.match_id && <><span>·</span><Link href={`/matchlar/${n.match_id}`} className="accent">Match markazi</Link></>}
          </div>
          {n.cover_url && <img src={n.cover_url} alt="" style={{ borderRadius: 16, width: "100%", marginBottom: 32 }} />}
          {n.excerpt && <p className="lead" style={{ marginBottom: 24, color: "#fff" }}>{n.excerpt}</p>}
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
    </>
  );
}
