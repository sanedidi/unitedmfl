import type { Metadata } from "next";
import { api, safe } from "@/lib/api";
import type { Video } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { VideoCard } from "@/components/Cards";

export const metadata: Metadata = { title: "Media", description: "United MFL videolari: sharhlar, gollar va intervyular." };

const KIND: Record<string, string> = { highlight: "Sharhlar", interview: "Intervyular", announcement: "Anonslar", full: "To‘liq o‘yinlar" };

export default async function MediaPage() {
  const videos = await safe(api<Video[]>("/videos?limit=100"), []);
  const kinds = [...new Set(videos.map((v) => v.kind))];
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
    </>
  );
}
