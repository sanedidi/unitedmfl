import { ApiError, api } from "@/lib/api";
import { fmtDate, fmtTime } from "@/lib/format";
import { parseAt, type Layout } from "@/lib/layout";
import { pageMeta } from "@/lib/seo";
import { HomeLayout } from "@/components/home/HomeLayout";

// Draft preview for the admin's homepage builder: /preview?token=…&at=2026-12-01T10:00
// The token comes from the admin (valid 2 hours); `at` shows the page as it will
// look at that moment (Tashkent time) — scheduled blocks are resolved for it.

export const metadata = pageMeta({ title: "Bosh sahifa — qoralama", description: "Qoralama ko‘rinishi", path: "/preview", noindex: true });
export const dynamic = "force-dynamic";

export default async function Preview({ searchParams }: { searchParams: Promise<{ token?: string; at?: string }> }) {
  const { token = "", at } = await searchParams;
  let layout: Layout | null = null;
  let error = "";
  try {
    layout = (await api<{ config: Layout }>(`/homepage/preview?token=${encodeURIComponent(token)}`, { revalidate: 0 })).config;
  } catch (e) {
    error = e instanceof ApiError && e.status === 403 ? "Ko‘rish havolasi eskirgan. Admin paneldan qayta oching." : "Qoralamani yuklab bo‘lmadi.";
  }
  const when = parseAt(at);
  const now = when ?? Date.now();
  const iso = new Date(now).toISOString();
  return (
    <>
      <div className="preview-bar" role="status">
        <b>Qoralama</b>
        <span>{when ? `${fmtDate(iso)}, ${fmtTime(iso)} holatida` : "hozirgi vaqtda"} · saytda hali ko‘rinmaydi</span>
      </div>
      {layout ? <HomeLayout layout={layout} now={now} fresh /> : <div className="container" style={{ padding: "80px 0" }}><p className="lead">{error}</p></div>}
    </>
  );
}
