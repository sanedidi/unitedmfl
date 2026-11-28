import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { apiOrNull, safe } from "@/lib/api";
import { fmtDate, fmtTime, isLive } from "@/lib/format";
import { abs, breadcrumbLd, clip, idFromParam, matchPath, matchTitle, orgRef, pageMeta, teamPath } from "@/lib/seo";
import type { MatchDetail } from "@/lib/types";
import { MatchCentre } from "@/components/MatchCentre";
import { ChevronRight } from "@/components/Icons";
import { JsonLd } from "@/components/JsonLd";

import type { T } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";
type P = Promise<{ id: string }>;

// Live matches change every few seconds; finished ones are cached until the admin edits them.
const load = cache(async (param: string) => {
  const id = idFromParam(param);
  return id ? apiOrNull<MatchDetail>(`/matches/${id}`, { revalidate: 15 }) : null;
});

function describe(d: MatchDetail, tx: T) {
  const m = d.match;
  const h = m.home?.name || tx("Aniqlanmagan"), a = m.away?.name || tx("Aniqlanmagan");
  const when = `${fmtDate(m.kickoff_at)}, ${fmtTime(m.kickoff_at)}`;
  const where = m.venue ? `, ${m.venue}` : "";
  const stage = m.stage?.name ? `${m.stage.name}. ` : "";
  if (isLive(m)) return tx("{0}{1} — {2}: jonli hisob {3}:{4}, voqealar va tarkiblar real vaqtda.", stage, h, a, m.home_score ?? 0, m.away_score ?? 0);
  if (m.status === "finished" && m.home_score != null) {
    const goals = d.events.filter((e) => ["goal", "penalty_goal", "own_goal"].includes(e.type)).map((e) => e.player_name).filter(Boolean);
    const scorers = goals.length ? tx(" Gollar: {0}.", [...new Set(goals)].join(", ")) : "";
    return clip(tx("{0}{1} {2}:{3} {4}{5} — {6}{7}.{8} Tarkiblar, voqealar va statistika.", stage, h, m.home_score, m.away_score, a, m.home_pen != null ? ` (pen. ${m.home_pen}:${m.away_pen})` : "", when, where, scorers));
  }
  return clip(tx("{0}{1} — {2}: {3}{4}. Match taqvimi, chiptalar va tarkiblar — United MFL.", stage, h, a, when, where));
}

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const tx = await getT();
  const d = await load((await params).id);
  if (!d) return { title: tx("Match topilmadi"), robots: { index: false } };
  return pageMeta({ title: matchTitle(d.match), description: describe(d, tx), path: matchPath(d.match), image: `${matchPath(d.match)}/opengraph-image` });
}

export default async function MatchPage({ params }: { params: P }) {
  const tx = await getT();
  const param = (await params).id;
  const d = await load(param);
  if (!d) notFound();
  const m = d.match;
  const canonical = matchPath(m);
  if (`/matchlar/${param}` !== canonical) permanentRedirect(canonical);
  // our own ticket sale (constructor + Payme/Click) wins over an external ticket link
  const sale = m.status === "scheduled" ? await safe(apiOrNull<{ status: string }>(`/matches/${m.id}/tickets`, { revalidate: 30 }), null) : null;
  const ownTickets = sale && ["open", "soon", "sold_out"].includes(sale.status) ? `${canonical}/chipta` : undefined;

  const statusMap: Record<string, string> = { postponed: "EventPostponed", cancelled: "EventCancelled" };
  const teamLd = (t: NonNullable<typeof m.home>) => ({ "@type": "SportsTeam", name: t.name, url: abs(teamPath(t)), ...(t.crest_url ? { logo: abs(t.crest_url) } : {}) });
  const eventLd = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    "@id": `${abs(canonical)}#event`,
    name: `${m.home?.name || "Aniqlanmagan"} — ${m.away?.name || "Aniqlanmagan"}`,
    description: describe(d, tx),
    url: abs(canonical),
    startDate: m.kickoff_at,
    eventStatus: `https://schema.org/${statusMap[m.status] || "EventScheduled"}`,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    sport: "Football",
    image: [abs(`${canonical}/opengraph-image`), ...(d.photos ?? []).slice(0, 10).map((p) => abs(p.url))],
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
    <div className="container">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/matchlar">{tx("Matchlar")}</Link><ChevronRight size={12} />
        {m.stage && <><Link href={`/matchlar?bosqich=${m.stage.id}`}>{m.stage.name}</Link><ChevronRight size={12} /></>}
        <b>{eventLd.name}</b>
      </nav>
      <MatchCentre initial={d} ticketFallback={process.env.TICKETS_URL} ticketOwn={ownTickets} />
      <JsonLd data={eventLd} />
      <JsonLd data={breadcrumbLd(crumbs.filter((c) => !c.path.includes("?")))} />
    </div>
  );
}
