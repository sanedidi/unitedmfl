import type { Metadata } from "next";
import Link from "next/link";
import { api, safe } from "@/lib/api";
import type { Product } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { ProductCard } from "@/components/Cards";
import { pageMeta } from "@/lib/seo";

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const sp = await searchParams;
  return pageMeta({ title: "Rasmiy merch — kiyim va aksessuarlar", description: "United MFL rasmiy mahsulotlari: futbolkalar, sharflar, kepkalar, aksessuarlar va suvenirlar narxlari bilan.", path: "/merch", noindex: !!sp.turkum });
}

type SP = Promise<{ turkum?: string }>;

export default async function MerchPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const all = await safe(api<Product[]>("/products"), []);
  const cats = [...new Set(all.map((p) => p.category).filter(Boolean))];
  const items = sp.turkum ? all.filter((p) => p.category === sp.turkum) : all;
  return (
    <>
      <PageTitle overline="Rasmiy do‘kon" title="Merch" lead="Liga va jamoalar uchun rasmiy kiyim va aksessuarlar." />
      <div className="container">
        {cats.length > 1 && (
          <div className="filters"><div className="chips">
            <Link className="chip" href="/merch" aria-current={!sp.turkum ? "page" : undefined}>Hammasi</Link>
            {cats.map((c) => <Link key={c} className="chip" href={`/merch?turkum=${encodeURIComponent(c)}`} aria-current={sp.turkum === c ? "page" : undefined}>{c}</Link>)}
          </div></div>
        )}
        {items.length === 0 ? <div className="empty" style={{ marginTop: 32 }}>Mahsulotlar yo‘q.</div> : (
          <div className="grid grid-4" style={{ marginTop: 32 }}>{items.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        )}
      </div>
    </>
  );
}
