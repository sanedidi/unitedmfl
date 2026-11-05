import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiOrNull } from "@/lib/api";
import { fmtUZS } from "@/lib/format";
import type { Product } from "@/lib/types";
import { Prose } from "@/components/Prose";
import { ChevronRight } from "@/components/Icons";
import { JsonLd } from "@/components/JsonLd";
import { Img } from "@/components/Img";
import { cache } from "react";
import { abs, breadcrumbLd, clip, orgRef, pageMeta, productPath } from "@/lib/seo";

type Variant = { id: number; size: string; sku: string; stock: number | null; available: boolean };
type P = Promise<{ slug: string }>;
const load = cache(async (slug: string) => apiOrNull<{ product: Product; variants: Variant[] }>(`/products/${encodeURIComponent(slug)}`));

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const d = await load((await params).slug);
  if (!d) return { title: "Mahsulot topilmadi", robots: { index: false } };
  const p = d.product;
  const price = fmtUZS(p.sale_price_uzs ?? p.price_uzs);
  return pageMeta({
    title: `${p.name} — ${price}`,
    description: clip(`${p.name}${p.category ? ` (${p.category.toLowerCase()})` : ""} — United MFL rasmiy mahsuloti. Narxi: ${price}.${p.description ? ` ${p.description.replace(/[#*>\[\]()_-]/g, " ")}` : ""}`),
    path: productPath(p),
    image: p.images?.[0] || null,
  });
}

export default async function ProductPage({ params }: { params: P }) {
  const d = await load((await params).slug);
  if (!d) notFound();
  const { product: p, variants } = d;
  const sale = p.sale_price_uzs != null && p.sale_price_uzs < p.price_uzs;
  const buy = p.external_url || process.env.SHOP_URL || "";
  const availability = p.status === "out_of_stock" ? "OutOfStock" : p.status === "in_review" ? "PreOrder" : "InStock";
  const productLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    url: abs(productPath(p)),
    ...(p.images?.length ? { image: p.images.map(abs) } : {}),
    ...(p.category ? { category: p.category } : {}),
    ...(p.description ? { description: clip(p.description, 500) } : {}),
    brand: { "@type": "Brand", name: "United MFL" },
    offers: { "@type": "Offer", url: abs(productPath(p)), priceCurrency: "UZS", price: sale ? p.sale_price_uzs : p.price_uzs, availability: `https://schema.org/${availability}`, seller: orgRef },
  };
  return (
    <div className="container">
      <nav className="crumbs" aria-label="Breadcrumb"><Link href="/merch">Merch</Link><ChevronRight size={12} /><b>{p.name}</b></nav>
      <div className="grid grid-2" style={{ alignItems: "start", gap: 40 }}>
        <div className="stack">
          <div className="card product-img" style={{ borderRadius: 24 }}>
            {p.images?.[0] ? <Img src={p.images[0]} alt={p.name} sizes="(max-width: 720px) 100vw, 620px" priority /> : <div className="ph" style={{ fontSize: 64 }} aria-hidden>MFL</div>}
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
      <JsonLd data={productLd} />
      <JsonLd data={breadcrumbLd([{ name: "Bosh sahifa", path: "/" }, { name: "Merch", path: "/merch" }, { name: p.name, path: productPath(p) }])} />
    </div>
  );
}
