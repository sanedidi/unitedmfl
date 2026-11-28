import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { apiOrNull } from "@/lib/api";
import { POSITION_LABEL, isFinished } from "@/lib/format";
import { groupName, type TeamDetail } from "@/lib/types";
import { Crest } from "@/components/Crest";
import { ResultRow } from "@/components/Match";
import { ChevronRight, Instagram, Telegram } from "@/components/Icons";
import { JsonLd } from "@/components/JsonLd";
import { abs, breadcrumbLd, clip, orgRef, pageMeta, playerPath, teamPath } from "@/lib/seo";
import { sized } from "@/lib/img";

import { getT } from "@/lib/i18n/server";
type P = Promise<{ slug: string }>;
const load = cache(async (slug: string) => apiOrNull<TeamDetail>(`/teams/${encodeURIComponent(slug)}`));

function record(d: TeamDetail) {
  let w = 0, dr = 0, l = 0, gf = 0, ga = 0;
  for (const m of d.matches.filter(isFinished)) {
    const home = m.home?.id === d.team.id;
    const f = (home ? m.home_score : m.away_score) ?? 0, a = (home ? m.away_score : m.home_score) ?? 0;
    gf += f; ga += a;
    if (f > a) w++; else if (f === a) dr++; else l++;
  }
  return { played: w + dr + l, w, dr, l, gf, ga };
}

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const tx = await getT();
  const d = await load((await params).slug);
  if (!d) return { title: tx("Jamoa topilmadi"), robots: { index: false } };
  const r = record(d);
  const group = d.team.group_label ? ` ${groupName(d.team.group_label, d.team.group_name)}${d.team.group_is_provisional ? tx(" (taxminiy)") : ""}.` : "";
  const desc = clip(tx("{0} — United MFL 2026 ishtirokchisi.{1} {2} o‘yin: {3} g‘alaba, {4} durang, {5} mag‘lubiyat, gollar {6}:{7}. Tarkib, matchlar taqvimi va natijalar.", d.team.name, group, r.played, r.w, r.dr, r.l, r.gf, r.ga));
  return pageMeta({ title: tx("{0} — tarkib, matchlar va natijalar", d.team.name), description: desc, path: teamPath(d.team), image: `${teamPath(d.team)}/opengraph-image` });
}

export default async function TeamPage({ params }: { params: P }) {
  const tx = await getT();
  const d = await load((await params).slug);
  if (!d) notFound();
  const { team, players, matches } = d;
  const { played, w, dr, l, gf, ga } = record(d);
  const url = abs(teamPath(team));
  const teamLd = {
    "@context": "https://schema.org",
    "@type": "SportsTeam",
    "@id": `${url}#team`,
    name: team.name,
    url,
    sport: "Football",
    memberOf: orgRef,
    ...(team.crest_url ? { logo: abs(team.crest_url) } : {}),
    ...([team.instagram, team.telegram].filter(Boolean).length ? { sameAs: [team.instagram, team.telegram].filter(Boolean) } : {}),
    ...(players.length ? { athlete: players.map((p) => ({ "@type": "Person", name: p.full_name, url: abs(playerPath(p)) })) } : {}),
  };
  const byPos = ["GK", "DF", "MF", "FW"].map((p) => ({ p, items: players.filter((x) => x.position === p) })).filter((g) => g.items.length);
  const noPos = players.filter((x) => !["GK", "DF", "MF", "FW"].includes(x.position));

  return (
    <>
      <header className="page-title">
        <div className="container">
          <nav className="crumbs" style={{ paddingTop: 0 }} aria-label="Breadcrumb"><Link href="/jamoalar">{tx("Jamoalar")}</Link><ChevronRight size={12} /><b>{team.name}</b></nav>
          <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
            <Crest team={team} size={120} />
            <div className="grow">
              {team.group_label && <div className="overline">{groupName(team.group_label, team.group_name)}{team.group_is_provisional ? tx(" · taxminiy") : ""}</div>}
              <h1 className="h1">{team.name}</h1>
              {team.leader && <p className="lead" style={{ marginTop: 8 }}>{tx("Jamoa sardori:")}{" "}{team.leader}</p>}
              <div className="row" style={{ marginTop: 12 }}>
                {team.instagram && <a className="btn btn-ghost btn-sm" href={team.instagram} target="_blank" rel="noopener noreferrer"><Instagram />{" "}{tx("Instagram")}</a>}
                {team.telegram && <a className="btn btn-ghost btn-sm" href={team.telegram} target="_blank" rel="noopener noreferrer"><Telegram />{" "}{tx("Telegram")}</a>}
              </div>
            </div>
          </div>
        </div>
      </header>
      <div className="container">
        <div className="grid grid-4" style={{ marginTop: 32 }}>
          <div className="card card-pad"><div className="muted">{tx("O‘yinlar")}</div><div className="h2 tnum">{played}</div></div>
          <div className="card card-pad"><div className="muted">{tx("G / D / M")}</div><div className="h2 tnum">{w}/{dr}/{l}</div></div>
          <div className="card card-pad"><div className="muted">{tx("Gollar")}</div><div className="h2 tnum">{gf}:{ga}</div></div>
          <div className="card card-pad"><div className="muted">{tx("Farq")}</div><div className="h2 tnum accent">{gf - ga > 0 ? `+${gf - ga}` : gf - ga}</div></div>
        </div>

        <section style={{ marginTop: 48 }}>
          <h2 className="h3" style={{ marginBottom: 16 }}>{tx("Matchlar")}</h2>
          {matches.length ? <div className="card">{matches.map((m) => <ResultRow key={m.id} match={m} />)}</div> : <div className="empty">{tx("Matchlar yo‘q.")}</div>}
        </section>

        <section style={{ marginTop: 48 }}>
          <h2 className="h3" style={{ marginBottom: 16 }}>{tx("Tarkib")}</h2>
          {players.length === 0 ? <div className="empty">{tx("Tarkib hali e’lon qilinmagan.")}</div> : (
            [...byPos, ...(noPos.length ? [{ p: "", items: noPos }] : [])].map((g) => (
              <div key={g.p || "other"} style={{ marginBottom: 28 }}>
                <div className="overline" style={{ color: "var(--text-muted)", marginBottom: 12 }}>{POSITION_LABEL[g.p] || tx("Boshqa")}</div>
                <div className="grid grid-4" style={{ gap: 12 }}>
                  {g.items.map((p) => (
                    <Link key={p.id} href={playerPath(p)} className="card card-hover player-tile">
                      <span className="player-num">{p.number ?? "–"}</span>
                      <span className="avatar">{p.photo_url ? <img {...sized(p.photo_url, 64)} alt="" loading="lazy" decoding="async" /> : p.full_name.slice(0, 1)}</span>
                      <b style={{ fontSize: 14 }}>{p.full_name}</b>
                    </Link>
                  ))}
                </div>
              </div>
            ))
          )}
        </section>
      </div>
      <JsonLd data={teamLd} />
      <JsonLd data={breadcrumbLd([{ name: "Bosh sahifa", path: "/" }, { name: "Jamoalar", path: "/jamoalar" }, { name: team.name, path: teamPath(team) }])} />
    </>
  );
}
