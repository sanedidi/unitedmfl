import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { apiOrNull } from "@/lib/api";
import { POSITION_LABEL } from "@/lib/format";
import { abs, breadcrumbLd, clip, fitTitle, idFromParam, orgRef, pageMeta, playerPath, teamPath } from "@/lib/seo";
import type { PlayerDetail } from "@/lib/types";
import { ChevronRight, Instagram } from "@/components/Icons";
import { JsonLd } from "@/components/JsonLd";
import { ResultRow } from "@/components/Match";

type P = Promise<{ id: string }>;
const load = cache(async (param: string) => {
  const id = idFromParam(param);
  return id ? apiOrNull<PlayerDetail>(`/players/${id}`) : null;
});

function describe(d: PlayerDetail) {
  const p = d.player;
  const role = POSITION_LABEL[p.position]?.toLowerCase() || "o‘yinchi";
  const num = p.number != null ? `, №${p.number}` : "";
  const s = d.stats;
  return clip(`${p.full_name} — ${d.team ? `${d.team.name} jamoasi ` : ""}${role}${num}. United MFL statistikasi: ${s.appearances} o‘yin, ${s.goals} gol, ${s.yellow} sariq va ${s.red} qizil kartochka.`);
}

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const d = await load((await params).id);
  if (!d) return { title: "O‘yinchi topilmadi", robots: { index: false } };
  const n = d.player.full_name, t = d.team ? ` (${d.team.name})` : "";
  const title = fitTitle(`${n}${t} — statistika va matchlar`, `${n}${t} — statistika`, `${n} — statistika`, n);
  return pageMeta({ title, description: describe(d), path: playerPath(d.player), image: d.player.photo_url || null, type: "profile" });
}

export default async function PlayerPage({ params }: { params: P }) {
  const param = (await params).id;
  const d = await load(param);
  if (!d) notFound();
  const { player: p, team, stats } = d;
  const canonical = playerPath(p);
  if (`/oyinchilar/${param}` !== canonical) permanentRedirect(canonical);
  const matches = d.matches || [];

  const personLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    "@id": `${abs(canonical)}#person`,
    name: p.full_name,
    url: abs(canonical),
    ...(p.photo_url ? { image: abs(p.photo_url) } : {}),
    ...(team ? { memberOf: { "@type": "SportsTeam", name: team.name, url: abs(teamPath(team)), memberOf: orgRef } } : {}),
    ...(p.instagram ? { sameAs: [p.instagram] } : {}),
  };
  return (
    <>
      <header className="page-title">
        <div className="container">
          <nav className="crumbs" style={{ paddingTop: 0 }} aria-label="Breadcrumb"><Link href="/oyinchilar">O‘yinchilar</Link><ChevronRight size={12} />{team && <><Link href={teamPath(team)}>{team.name}</Link><ChevronRight size={12} /></>}<b>{p.full_name}</b></nav>
          <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
            <span className="avatar" style={{ width: 140, height: 140, fontSize: 48 }}>{p.photo_url ? <img src={p.photo_url} alt={p.full_name} width={140} height={140} /> : p.full_name.slice(0, 1)}</span>
            <div className="grow">
              <div className="overline">{POSITION_LABEL[p.position] || "O‘yinchi"}{p.number != null ? ` · №${p.number}` : ""}</div>
              <h1 className="h1">{p.full_name}</h1>
              {team && <p className="lead" style={{ marginTop: 8 }}><Link href={teamPath(team)} className="accent">{team.name}</Link></p>}
              {p.instagram && <a className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} href={p.instagram} target="_blank" rel="noopener noreferrer"><Instagram /> Instagram</a>}
            </div>
          </div>
        </div>
      </header>
      <div className="container">
        <h2 className="sr-only">Mavsum statistikasi</h2>
        <div className="grid grid-4" style={{ marginTop: 32 }}>
          <div className="card card-pad"><div className="muted">O‘yinlar</div><div className="h2 tnum">{stats.appearances}</div></div>
          <div className="card card-pad"><div className="muted">Gollar</div><div className="h2 tnum accent">{stats.goals}</div></div>
          <div className="card card-pad"><div className="muted">Sariq</div><div className="h2 tnum">{stats.yellow}</div></div>
          <div className="card card-pad"><div className="muted">Qizil</div><div className="h2 tnum">{stats.red}</div></div>
        </div>
        {matches.length > 0 && (
          <section style={{ marginTop: 48 }}>
            <h2 className="h3" style={{ marginBottom: 16 }}>Matchlar</h2>
            <div className="card">{matches.map((m) => <ResultRow key={m.id} match={m} />)}</div>
          </section>
        )}
      </div>
      <JsonLd data={personLd} />
      <JsonLd data={breadcrumbLd([{ name: "Bosh sahifa", path: "/" }, { name: "O‘yinchilar", path: "/oyinchilar" }, ...(team ? [{ name: team.name, path: teamPath(team) }] : []), { name: p.full_name, path: canonical }])} />
    </>
  );
}
