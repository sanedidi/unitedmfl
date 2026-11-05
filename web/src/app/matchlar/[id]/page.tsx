import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { apiOrNull } from "@/lib/api";
import { fmtDate, fmtTime, isLive } from "@/lib/format";
import { abs, breadcrumbLd, clip, idFromParam, matchPath, matchTitle, orgRef, pageMeta, teamPath } from "@/lib/seo";
import type { MatchDetail } from "@/lib/types";
import { MatchCentre } from "@/components/MatchCentre";
import { ChevronRight } from "@/components/Icons";
import { JsonLd } from "@/components/JsonLd";

type P = Promise<{ id: string }>;

// Live matches change every few seconds; finished ones are cached until the admin edits them.
const load = cache(async (param: string) => {
  const id = idFromParam(param);
  return id ? apiOrNull<MatchDetail>(`/matches/${id}`, { revalidate: 15 }) : null;
});

function describe(d: MatchDetail) {
  const m = d.match;
  const h = m.home?.name || "Aniqlanmagan", a = m.away?.name || "Aniqlanmagan";
  const when = `${fmtDate(m.kickoff_at)}, ${fmtTime(m.kickoff_at)}`;
  const where = m.venue ? `, ${m.venue}` : "";
  const stage = m.stage?.name ? `${m.stage.name}. ` : "";
  if (isLive(m)) return `${stage}${h} — ${a}: jonli hisob ${m.home_score ?? 0}:${m.away_score ?? 0}, voqealar va tarkiblar real vaqtda.`;
  if (m.status === "finished" && m.home_score != null) {
    const goals = d.events.filter((e) => ["goal", "penalty_goal", "own_goal"].includes(e.type)).map((e) => e.player_name).filter(Boolean);
    const scorers = goals.length ? ` Gollar: ${[...new Set(goals)].join(", ")}.` : "";
    return clip(`${stage}${h} ${m.home_score}:${m.away_score} ${a}${m.home_pen != null ? ` (pen. ${m.home_pen}:${m.away_pen})` : ""} — ${when}${where}.${scorers} Tarkiblar, voqealar va statistika.`);
  }
  return clip(`${stage}${h} — ${a}: ${when}${where}. Match taqvimi, chiptalar va tarkiblar — United MFL.`);
}

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const d = await load((await params).id);
  if (!d) return { title: "Match topilmadi", robots: { index: false } };
  return pageMeta({ title: matchTitle(d.match), description: describe(d), path: matchPath(d.match), image: `${matchPath(d.match)}/opengraph-image` });
}

export default async function MatchPage({ params }: { params: P }) {
  const param = (await params).id;
  const d = await load(param);
  if (!d) notFound();
  const m = d.match;
  const canonical = matchPath(m);
  if (`/matchlar/${param}` !== canonical) permanentRedirect(canonical);

  const statusMap: Record<string, string> = { postponed: "EventPostponed", cancelled: "EventCancelled" };
  const teamLd = (t: NonNullable<typeof m.home>) => ({ "@type": "SportsTeam", name: t.name, url: abs(teamPath(t)), ...(t.crest_url ? { logo: abs(t.crest_url) } : {}) });
  const eventLd = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    "@id": `${abs(canonical)}#event`,
    name: `${m.home?.name || "Aniqlanmagan"} — ${m.away?.name || "Aniqlanmagan"}`,
    description: describe(d),
    url: abs(canonical),
    startDate: m.kickoff_at,
    eventStatus: `https://schema.org/${statusMap[m.status] || "EventScheduled"}`,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    sport: "Football",
    image: abs(`${canonical}/opengraph-image`),
    organizer: orgRef,
    ...(m.venue ? { location: { "@type": "Place", name: m.venue.split(",")[0], address: m.venue } } : {}),
    ...(m.home ? { homeTeam: teamLd(m.home) } : {}),
    ...(m.away ? { awayTeam: teamLd(m.away) } : {}),
    ...(m.home && m.away ? { competitor: [teamLd(m.home), teamLd(m.away)] } : {}),
    ...(m.stage ? { superEvent: { "@type": "SportsEvent", name: `United MFL 2026 — ${m.stage.name}`, organizer: orgRef } } : {}),
  };
  const crumbs = [
    { name: "Bosh sahifa", path: "/" },
    { name: "Matchlar", path: "/matchlar" },
    ...(m.stage ? [{ name: m.stage.name, path: `/matchlar?bosqich=${m.stage.id}` }] : []),
    { name: eventLd.name, path: canonical },
  ];
  return (
    <div className="container" style={{ paddingBottom: 24 }}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/matchlar">Matchlar</Link><ChevronRight size={12} />
        {m.stage && <><Link href={`/matchlar?bosqich=${m.stage.id}`}>{m.stage.name}</Link><ChevronRight size={12} /></>}
        <b>{eventLd.name}</b>
      </nav>
      <MatchCentre initial={d} ticketFallback={process.env.TICKETS_URL} />
      <JsonLd data={eventLd} />
      <JsonLd data={breadcrumbLd(crumbs.filter((c) => !c.path.includes("?")))} />
    </div>
  );
}
