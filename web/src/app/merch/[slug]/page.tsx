import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiOrNull } from "@/lib/api";
import { fmtUZS } from "@/lib/format";
import type { Product } from "@/lib/types";
import { Prose } from "@/components/Prose";
import { ChevronRight } from "@/components/Icons";

type Variant = { id: number; size: string; sku: string; stock: number | null; available: boolean };
type P = Promise<{ slug: string }>;
const load = async (slug: string) => apiOrNull<{ product: Product; variants: Variant[] }>(`/products/${encodeURIComponent(slug)}`);

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const d = await load((await params).slug);
  return d ? { title: d.product.name, description: `${d.product.name} — ${fmtUZS(d.product.sale_price_uzs ?? d.product.price_uzs)}` } : { title: "Mahsulot topilmadi" };
}

export default async function ProductPage({ params }: { params: P }) {
  const d = await load((await params).slug);
  if (!d) notFound();
  const { product: p, variants } = d;
  const sale = p.sale_price_uzs != null && p.sale_price_uzs < p.price_uzs;
  const buy = p.external_url || process.env.SHOP_URL || "";
  return (
    <div className="container">
      <nav className="crumbs"><Link href="/merch">Merch</Link><ChevronRight size={12} /><b>{p.name}</b></nav>
      <div className="grid grid-2" style={{ alignItems: "start", gap: 40 }}>
        <div className="stack">
          <div className="card product-img" style={{ borderRadius: 24 }}>
            {p.images?.[0] ? <img src={p.images[0]} alt={p.name} /> : <div className="ph" style={{ fontSize: 64 }}>MFL</div>}
          </div>
          {p.images?.length > 1 && (
            <div className="grid grid-4" style={{ gap: 10 }}>{p.images.slice(1, 5).map((src) => <img key={src} src={src} alt="" style={{ borderRadius: 12, aspectRatio: "1", objectFit: "cover" }} />)}</div>
          )}
        </div>
        <div className="stack" style={{ gap: 20 }}>
          <span className="overline">{p.category}</span>
          <h1 className="h1" style={{ textTransform: "none", fontFamily: "var(--font-ui)" }}>{p.name}</h1>
          <div className="price" style={{ fontSize: 28 }}>{fmtUZS(sale ? p.sale_price_uzs! : p.price_uzs)}{sale && <s>{fmtUZS(p.price_uzs)}</s>}</div>
          {variants.length > 0 && (
            <div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>O‘lcham</div>
              <div className="chips">{variants.map((v) => <span key={v.id} className="chip" style={!v.available || v.stock === 0 ? { opacity: .4, textDecoration: "line-through" } : undefined}>{v.size}</span>)}</div>
            </div>
          )}
          {p.status === "out_of_stock" ? <span className="badge badge-muted">Vaqtincha tugagan</span> : buy ? (
            <a className="btn btn-primary" href={buy} target="_blank" rel="noopener noreferrer" style={{ alignSelf: "flex-start" }}>Sotib olish</a>
          ) : (
            <Link className="btn btn-primary" href="/biz-haqimizda#aloqa" style={{ alignSelf: "flex-start" }}>Buyurtma berish</Link>
          )}
          {p.description && <Prose text={p.description} />}
        </div>
      </div>
    </div>
  );
}
