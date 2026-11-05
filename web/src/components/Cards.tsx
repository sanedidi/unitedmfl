import Link from "next/link";
import { Play } from "./Icons";
import { fmtDate, fmtUZS, youtubeId } from "@/lib/format";
import { Img } from "./Img";
import { newsPath, productPath } from "@/lib/seo";
import type { NewsItem, Product, Video } from "@/lib/types";

export function NewsCard({ item, feature = false }: { item: NewsItem; feature?: boolean }) {
  return (
    <Link href={newsPath(item)} className={`card card-hover news-card${feature ? " news-feature" : ""}`}>
      <div className="news-cover">
        {item.cover_url ? <Img src={item.cover_url} alt="" sizes={feature ? "(max-width: 720px) 100vw, 620px" : "(max-width: 720px) 100vw, (max-width: 1024px) 50vw, 300px"} /> : <div className="ph" aria-hidden>UNITED MFL</div>}
      </div>
      <div className="news-body">
        {item.category && <span className="overline" style={{ fontSize: 10 }}>{item.category}</span>}
        <h3>{item.title}</h3>
        {item.excerpt && (feature || item.excerpt.length < 160) && <p>{item.excerpt}</p>}
        <span className="news-date">{fmtDate(item.published_at)}</span>
      </div>
    </Link>
  );
}

export function ProductCard({ p }: { p: Product }) {
  const sale = p.sale_price_uzs != null && p.sale_price_uzs < p.price_uzs;
  return (
    <Link href={productPath(p)} className="card card-hover product-card">
      <div className="product-img">
        {p.images?.[0] ? <Img src={p.images[0]} alt={p.name} sizes="(max-width: 720px) 50vw, 300px" /> : <div className="ph" aria-hidden>MFL</div>}
        {p.status === "out_of_stock" && <span className="badge badge-muted" style={{ position: "absolute", top: 12, left: 12 }}>Tugagan</span>}
        {sale && <span className="badge badge-live" style={{ position: "absolute", top: 12, right: 12 }}>Chegirma</span>}
      </div>
      <div className="product-body">
        <span className="muted" style={{ fontSize: 12 }}>{p.category}</span>
        <b>{p.name}</b>
        <span className="price">
          {fmtUZS(sale ? p.sale_price_uzs! : p.price_uzs)}
          {sale && <s>{fmtUZS(p.price_uzs)}</s>}
        </span>
      </div>
    </Link>
  );
}

export function VideoCard({ v }: { v: Video }) {
  const yt = youtubeId(v.url, v.youtube_id);
  const thumb = v.thumbnail_url || (yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : "");
  return (
    <a href={v.url} target="_blank" rel="noopener noreferrer" className="card card-hover video-card">
      <div className="video-thumb">
        {thumb && <img src={thumb} alt="" loading="lazy" decoding="async" width={480} height={360} />}
        <span className="play"><Play size={22} /></span>
      </div>
      <div className="news-body">
        <h3 style={{ fontSize: 16 }}>{v.title}</h3>
        {v.published_at && <span className="news-date">{fmtDate(v.published_at)}</span>}
      </div>
    </a>
  );
}
