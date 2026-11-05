import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiOrNull } from "@/lib/api";
import { POSITION_LABEL } from "@/lib/format";
import type { PlayerDetail } from "@/lib/types";
import { ChevronRight, Instagram } from "@/components/Icons";

type P = Promise<{ id: string }>;
const load = async (id: string) => (/^\d+$/.test(id) ? apiOrNull<PlayerDetail>(`/players/${id}`) : null);

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const d = await load((await params).id);
  return d ? { title: d.player.full_name, description: `${d.player.full_name}${d.team ? ` — ${d.team.name}` : ""}. United MFL o‘yinchisi.` } : { title: "O‘yinchi topilmadi" };
}

export default async function PlayerPage({ params }: { params: P }) {
  const d = await load((await params).id);
  if (!d) notFound();
  const { player: p, team, stats } = d;
  return (
    <>
      <header className="page-title">
        <div className="container">
          <nav className="crumbs" style={{ paddingTop: 0 }}><Link href="/oyinchilar">O‘yinchilar</Link><ChevronRight size={12} /><b>{p.full_name}</b></nav>
          <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
            <span className="avatar" style={{ width: 140, height: 140, fontSize: 48 }}>{p.photo_url ? <img src={p.photo_url} alt={p.full_name} /> : p.full_name.slice(0, 1)}</span>
            <div className="grow">
              <div className="overline">{POSITION_LABEL[p.position] || "O‘yinchi"}{p.number != null ? ` · №${p.number}` : ""}</div>
              <h1 className="h1">{p.full_name}</h1>
              {team && <p className="lead" style={{ marginTop: 8 }}><Link href={`/jamoalar/${team.slug}`} className="accent">{team.name}</Link></p>}
              {p.instagram && <a className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} href={p.instagram} target="_blank" rel="noopener noreferrer"><Instagram /> Instagram</a>}
            </div>
          </div>
        </div>
      </header>
      <div className="container">
        <div className="grid grid-4" style={{ marginTop: 32 }}>
          <div className="card card-pad"><div className="muted">O‘yinlar</div><div className="h2 tnum">{stats.appearances}</div></div>
          <div className="card card-pad"><div className="muted">Gollar</div><div className="h2 tnum accent">{stats.goals}</div></div>
          <div className="card card-pad"><div className="muted">Sariq</div><div className="h2 tnum">{stats.yellow}</div></div>
          <div className="card card-pad"><div className="muted">Qizil</div><div className="h2 tnum">{stats.red}</div></div>
        </div>
      </div>
    </>
  );
}
