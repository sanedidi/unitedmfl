import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiOrNull } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import type { MatchDetail } from "@/lib/types";
import { MatchCentre } from "@/components/MatchCentre";
import { ChevronRight } from "@/components/Icons";

type P = Promise<{ id: string }>;

async function load(id: string) {
  if (!/^\d+$/.test(id)) return null;
  return apiOrNull<MatchDetail>(`/matches/${id}`);
}

const title = (d: MatchDetail) => `${d.match.home?.name || "Aniqlanmagan"} — ${d.match.away?.name || "Aniqlanmagan"}`;

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const d = await load((await params).id);
  if (!d) return { title: "Match topilmadi" };
  const m = d.match;
  const score = m.home_score != null && m.status !== "scheduled" ? ` ${m.home_score}:${m.away_score}` : "";
  return { title: `${title(d)}${score}`, description: `${m.stage?.name || "Match"}, ${fmtDate(m.kickoff_at)}. ${m.venue || ""}`.trim() };
}

export default async function MatchPage({ params }: { params: P }) {
  const d = await load((await params).id);
  if (!d) notFound();
  return (
    <div className="container" style={{ paddingBottom: 24 }}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/matchlar">Matchlar</Link><ChevronRight size={12} />
        {d.match.stage && <><Link href={`/matchlar?bosqich=${d.match.stage.id}`}>{d.match.stage.name}</Link><ChevronRight size={12} /></>}
        <b>{title(d)}</b>
      </nav>
      <MatchCentre initial={d} ticketFallback={process.env.TICKETS_URL} />
    </div>
  );
}
