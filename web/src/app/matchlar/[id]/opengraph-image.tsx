import { apiOrNull } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { idFromParam } from "@/lib/seo";
import { ogImage, OG_SIZE, OG_TYPE } from "@/lib/og";
import type { MatchDetail } from "@/lib/types";

export const alt = "United MFL match";
export const size = OG_SIZE;
export const contentType = OG_TYPE;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const id = idFromParam((await params).id);
  const d = id ? await apiOrNull<MatchDetail>(`/matches/${id}`, { revalidate: 15 }) : null;
  if (!d) return ogImage({ kicker: "Match", title: "United MFL" });
  const m = d.match;
  const played = m.home_score != null && m.away_score != null && m.status !== "scheduled";
  const live = m.status === "live" || m.status === "halftime";
  return ogImage({
    kicker: live ? "Jonli" : m.stage?.name || "Match",
    title: "",
    home: m.home,
    away: m.away,
    center: played || live ? `${m.home_score ?? 0}:${m.away_score ?? 0}` : "VS",
    subtitle: `${fmtDate(m.kickoff_at)}${m.venue ? ` · ${m.venue}` : ""}${m.home_pen != null ? ` · pen. ${m.home_pen}:${m.away_pen}` : ""}`,
  });
}
