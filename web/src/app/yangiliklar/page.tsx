import type { Metadata } from "next";
import Link from "next/link";
import { api, safe } from "@/lib/api";
import type { NewsItem } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { NewsCard } from "@/components/Cards";

export const metadata: Metadata = { title: "Yangiliklar", description: "United MFL yangiliklari, anonslar va match sharhlari." };

type SP = Promise<{ turkum?: string; sahifa?: string }>;
const LIMIT = 12;

export default async function NewsPage({ searchParams }: { searchParams: SP }) {
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
      <PageTitle overline="United MFL" title="Yangiliklar" />
      <div className="container">
        {cats.length > 1 && (
          <div className="filters">
            <div className="chips">
              <Link className="chip" href={link({ turkum: undefined })} aria-current={!sp.turkum ? "page" : undefined}>Hammasi</Link>
              {cats.map((c) => <Link key={c} className="chip" href={link({ turkum: c })} aria-current={sp.turkum?.toUpperCase() === c ? "page" : undefined}>{c}</Link>)}
            </div>
          </div>
        )}
        {items.length === 0 ? <div className="empty" style={{ marginTop: 32 }}>Yangiliklar yo‘q.</div> : (
          <div className="grid grid-3" style={{ marginTop: 32 }}>{items.map((n) => <NewsCard key={n.slug} item={n} />)}</div>
        )}
        <div className="pagination">
          {page > 1 && <Link className="btn btn-ghost btn-sm" href={link({ sahifa: page - 1 })}>← Oldingi</Link>}
          {items.length === LIMIT && <Link className="btn btn-ghost btn-sm" href={link({ sahifa: page + 1 })}>Keyingi →</Link>}
        </div>
      </div>
    </>
  );
}
