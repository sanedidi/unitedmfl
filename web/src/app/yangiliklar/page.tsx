import type { Metadata } from "next";
import Link from "next/link";
import { api, safe } from "@/lib/api";
import type { NewsItem } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { NewsCard } from "@/components/Cards";
import { pageMeta } from "@/lib/seo";

import { getT } from "@/lib/i18n/server";
export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const tx = await getT();
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.sahifa || "1", 10) || 1);
  return pageMeta({
    title: page > 1 ? tx("Yangiliklar — {0}-sahifa", page) : tx("Yangiliklar — anonslar, natijalar va sharhlar"),
    description: tx("United MFL yangiliklari: match anonslari va natijalari, liga e’lonlari, homiylar va chiptalar haqida."),
    path: page > 1 && !sp.turkum ? `/yangiliklar?sahifa=${page}` : "/yangiliklar",
    noindex: !!sp.turkum,
  });
}

type SP = Promise<{ turkum?: string; sahifa?: string }>;
const LIMIT = 12;

export default async function NewsPage({ searchParams }: { searchParams: SP }) {
  const tx = await getT();
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.sahifa || "1", 10) || 1);
  const qs = new URLSearchParams({ limit: String(LIMIT), page: String(page) });
  if (sp.turkum) qs.set("category", sp.turkum);
  const [items, all] = await Promise.all([safe(api<NewsItem[]>(`/news?${qs}`), []), safe(api<NewsItem[]>("/news?limit=200"), [])]);
  const cats = [...new Set(all.map((n) => n.category).filter(Boolean))].sort();
  const link = (p: { turkum?: string; sahifa?: number }) => {
    const q = new URLSearchParams();
    const t = "turkum" in p ? p.turkum : sp.turkum;
    if (t) q.set("turkum", t);
    if (p.sahifa && p.sahifa > 1) q.set("sahifa", String(p.sahifa));
    const s = q.toString();
    return s ? `/yangiliklar?${s}` : "/yangiliklar";
  };
  return (
    <>
      <PageTitle overline="United MFL" title={tx("Yangiliklar")} />
      <div className="container">
        {cats.length > 1 && (
          <div className="filters">
            <div className="chips">
              <Link className="chip" href={link({ turkum: undefined })} aria-current={!sp.turkum ? "page" : undefined}>{tx("Hammasi")}</Link>
              {cats.map((c) => <Link key={c} className="chip" href={link({ turkum: c })} aria-current={sp.turkum?.toUpperCase() === c ? "page" : undefined}>{c}</Link>)}
            </div>
          </div>
        )}
        {items.length === 0 ? <div className="empty" style={{ marginTop: 32 }}>{tx("Yangiliklar yo‘q.")}</div> : (
          <div className="grid grid-3" style={{ marginTop: 32 }}>{items.map((n) => <NewsCard key={n.slug} item={n} />)}</div>
        )}
        <div className="pagination">
          {page > 1 && <Link className="btn btn-ghost btn-sm" href={link({ sahifa: page - 1 })}>{tx("← Oldingi")}</Link>}
          {items.length === LIMIT && <Link className="btn btn-ghost btn-sm" href={link({ sahifa: page + 1 })}>{tx("Keyingi →")}</Link>}
        </div>
      </div>
    </>
  );
}
