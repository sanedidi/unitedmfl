import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiOrNull } from "@/lib/api";
import { POSITION_LABEL, isFinished } from "@/lib/format";
import type { TeamDetail } from "@/lib/types";
import { Crest } from "@/components/Crest";
import { ResultRow } from "@/components/Match";
import { ChevronRight, Instagram, Telegram } from "@/components/Icons";

type P = Promise<{ slug: string }>;
const load = async (slug: string) => apiOrNull<TeamDetail>(`/teams/${encodeURIComponent(slug)}`);

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const d = await load((await params).slug);
  return d ? { title: d.team.name, description: `${d.team.name} — United MFL jamoasi: tarkib, matchlar va natijalar.` } : { title: "Jamoa topilmadi" };
}

export default async function TeamPage({ params }: { params: P }) {
  const d = await load((await params).slug);
  if (!d) notFound();
  const { team, players, matches } = d;
  const fin = matches.filter(isFinished);
  let w = 0, dr = 0, l = 0, gf = 0, ga = 0;
  for (const m of fin) {
    const home = m.home?.id === team.id;
    const f = (home ? m.home_score : m.away_score) ?? 0, a = (home ? m.away_score : m.home_score) ?? 0;
    gf += f; ga += a;
    if (f > a) w++; else if (f === a) dr++; else l++;
  }
  const byPos = ["GK", "DF", "MF", "FW"].map((p) => ({ p, items: players.filter((x) => x.position === p) })).filter((g) => g.items.length);
  const noPos = players.filter((x) => !["GK", "DF", "MF", "FW"].includes(x.position));

  return (
    <>
      <header className="page-title">
        <div className="container">
          <nav className="crumbs" style={{ paddingTop: 0 }}><Link href="/jamoalar">Jamoalar</Link><ChevronRight size={12} /><b>{team.name}</b></nav>
          <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
            <Crest team={team} size={120} />
            <div className="grow">
              {team.group_label && <div className="overline">Guruh {team.group_label}{team.group_is_provisional ? " · taxminiy" : ""}</div>}
              <h1 className="h1">{team.name}</h1>
              {team.leader && <p className="lead" style={{ marginTop: 8 }}>Jamoa sardori: {team.leader}</p>}
              <div className="row" style={{ marginTop: 12 }}>
                {team.instagram && <a className="btn btn-ghost btn-sm" href={team.instagram} target="_blank" rel="noopener noreferrer"><Instagram /> Instagram</a>}
                {team.telegram && <a className="btn btn-ghost btn-sm" href={team.telegram} target="_blank" rel="noopener noreferrer"><Telegram /> Telegram</a>}
              </div>
            </div>
          </div>
        </div>
      </header>
      <div className="container">
        <div className="grid grid-4" style={{ marginTop: 32 }}>
          <div className="card card-pad"><div className="muted">O‘yinlar</div><div className="h2 tnum">{fin.length}</div></div>
          <div className="card card-pad"><div className="muted">G / D / M</div><div className="h2 tnum">{w}/{dr}/{l}</div></div>
          <div className="card card-pad"><div className="muted">Gollar</div><div className="h2 tnum">{gf}:{ga}</div></div>
          <div className="card card-pad"><div className="muted">Farq</div><div className="h2 tnum accent">{gf - ga > 0 ? `+${gf - ga}` : gf - ga}</div></div>
        </div>

        <section style={{ marginTop: 48 }}>
          <h2 className="h3" style={{ marginBottom: 16 }}>Matchlar</h2>
          {matches.length ? <div className="card">{matches.map((m) => <ResultRow key={m.id} match={m} />)}</div> : <div className="empty">Matchlar yo‘q.</div>}
        </section>

        <section style={{ marginTop: 48 }}>
          <h2 className="h3" style={{ marginBottom: 16 }}>Tarkib</h2>
          {players.length === 0 ? <div className="empty">Tarkib hali e’lon qilinmagan.</div> : (
            [...byPos, ...(noPos.length ? [{ p: "", items: noPos }] : [])].map((g) => (
              <div key={g.p || "other"} style={{ marginBottom: 28 }}>
                <div className="overline" style={{ color: "var(--text-muted)", marginBottom: 12 }}>{POSITION_LABEL[g.p] || "Boshqa"}</div>
                <div className="grid grid-4" style={{ gap: 12 }}>
                  {g.items.map((p) => (
                    <Link key={p.id} href={`/oyinchilar/${p.id}`} className="card card-hover player-tile">
                      <span className="player-num">{p.number ?? "–"}</span>
                      <span className="avatar">{p.photo_url ? <img src={p.photo_url} alt="" /> : p.full_name.slice(0, 1)}</span>
                      <b style={{ fontSize: 14 }}>{p.full_name}</b>
                    </Link>
                  ))}
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </>
  );
}
