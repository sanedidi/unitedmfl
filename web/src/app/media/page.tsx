import type { Metadata } from "next";
import { api, safe } from "@/lib/api";
import type { Video } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { VideoCard } from "@/components/Cards";
import { JsonLd } from "@/components/JsonLd";
import { abs, pageMeta } from "@/lib/seo";
import { youtubeId } from "@/lib/format";

export async function generateMetadata(): Promise<Metadata> {
  const videos = await safe(api<Video[]>("/videos?limit=100"), []);
  return pageMeta({ title: "Media — match sharhlari va videolar", description: "United MFL videolari: match sharhlari, intervyular, anonslar va to‘liq o‘yinlar.", path: "/media", noindex: videos.length === 0 });
}

const KIND: Record<string, string> = { highlight: "Sharhlar", interview: "Intervyular", announcement: "Anonslar", full: "To‘liq o‘yinlar" };

export default async function MediaPage() {
  const videos = await safe(api<Video[]>("/videos?limit=100"), []);
  const kinds = [...new Set(videos.map((v) => v.kind))];
  // VideoObject only for videos with a real upload date and thumbnail
  const videoLd = videos.filter((v) => v.published_at).map((v) => {
    const yt = youtubeId(v.url, v.youtube_id);
    const thumb = v.thumbnail_url ? abs(v.thumbnail_url) : yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : null;
    return thumb ? {
      "@context": "https://schema.org", "@type": "VideoObject", name: v.title, description: v.title, thumbnailUrl: thumb, uploadDate: v.published_at,
      ...(yt ? { embedUrl: `https://www.youtube.com/embed/${yt}` } : { contentUrl: v.url }),
      ...(v.duration_sec ? { duration: `PT${Math.floor(v.duration_sec / 60)}M${v.duration_sec % 60}S` } : {}),
    } : null;
  }).filter(Boolean);
  return (
    <>
      <PageTitle overline="United MFL" title="Media" lead="Match sharhlari, gollar va kadrlar ortidagi videolar." />
      <div className="container">
        {videos.length === 0 && <div className="empty" style={{ marginTop: 32 }}>Videolar tez orada qo‘shiladi.</div>}
        {kinds.map((k) => (
          <section key={k} style={{ marginTop: 40 }}>
            <h2 className="h3" style={{ marginBottom: 16 }}>{KIND[k] || k}</h2>
            <div className="grid grid-3">{videos.filter((v) => v.kind === k).map((v) => <VideoCard key={v.id} v={v} />)}</div>
          </section>
        ))}
      </div>
      {videoLd.length > 0 && <JsonLd data={videoLd} />}
    </>
  );
}
