import { apiOrNull } from "@/lib/api";
import { ogImage, OG_SIZE, OG_TYPE } from "@/lib/og";
import { groupName, type TeamDetail } from "@/lib/types";

export const alt = "United MFL jamoasi";
export const size = OG_SIZE;
export const contentType = OG_TYPE;

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const d = await apiOrNull<TeamDetail>(`/teams/${encodeURIComponent((await params).slug)}`);
  if (!d) return ogImage({ kicker: "Jamoa", title: "United MFL" });
  const t = d.team;
  return ogImage({ kicker: t.group_label ? groupName(t.group_label, t.group_name) : "Jamoa", title: t.name, subtitle: `${d.players.length ? `${d.players.length} o‘yinchi · ` : ""}${d.matches.length} match · United MFL 2026` });
}
