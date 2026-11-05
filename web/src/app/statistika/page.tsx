import type { Metadata } from "next";
import { pageMeta } from "@/lib/seo";
import Link from "next/link";
import { api, safe } from "@/lib/api";
import type { Leaders, Team } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { Crest } from "@/components/Crest";
import { playerPath } from "@/lib/seo";

export const metadata: Metadata = pageMeta({ title: "Statistika — gollar, bombardirlar va kartochkalar", description: "United MFL 2026 statistikasi: jami gollar, o‘yin boshiga gollar, eng ko‘p gol urgan jamoalar, bombardirlar va intizom.", path: "/statistika" });

export default async function StatsPage() {
  const [l, teams] = await Promise.all([safe(api<Leaders | null>("/stats/leaders"), null), safe(api<Team[]>("/teams"), [])]);
  const teamMap = new Map(teams.map((t) => [t.id, t]));
  const tg = l?.team_goals || [];
  const max = Math.max(1, ...tg.map((t) => t.goals));
  return (
    <>
      <PageTitle overline="United MFL 2026" title="Statistika" lead="Faqat yakunlangan va e’lon qilingan matchlar hisobga olinadi." />
      <div className="container">
        <div className="grid grid-3" style={{ marginTop: 32 }}>
          <div className="card card-pad"><div className="muted">Matchlar</div><div className="h2 tnum">{l?.summary.matches ?? 0}</div></div>
          <div className="card card-pad"><div className="muted">Gollar</div><div className="h2 tnum">{l?.summary.goals ?? 0}</div></div>
          <div className="card card-pad"><div className="muted">Gol / match</div><div className="h2 tnum">{String(l?.summary.goals_per_match ?? 0).replace(".", ",")}</div></div>
        </div>

        <div className="grid grid-2" style={{ marginTop: 20, alignItems: "start" }}>
          <section className="card">
            <h2 className="h4" style={{ padding: "20px 20px 4px" }}>Bombardirlar</h2>
            {(l?.scorers || []).length === 0 ? <p className="muted" style={{ padding: "0 20px 20px" }}>O‘yinchilar statistikasi hali e’lon qilinmagan.</p> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>#</th><th className="l">O‘yinchi</th><th className="l">Jamoa</th><th>Gollar</th></tr></thead>
                <tbody>{l!.scorers!.map((s, i) => (
                  <tr key={`${s.player_id}-${i}`}><td>{i + 1}</td><td className="l">{s.player_id ? <Link href={playerPath({ id: s.player_id, name: s.name })}><b>{s.name}</b></Link> : s.name}</td><td className="l muted">{s.team}</td><td className="strong">{s.goals}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
          <section className="card">
            <h2 className="h4" style={{ padding: "20px 20px 4px" }}>Intizom</h2>
            {(l?.cards || []).length === 0 ? <p className="muted" style={{ padding: "0 20px 20px" }}>Kartochkalar haqida ma’lumot yo‘q.</p> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>#</th><th className="l">O‘yinchi</th><th className="l">Jamoa</th><th><span className="card-y" /></th><th><span className="card-r" /></th></tr></thead>
                <tbody>{l!.cards!.map((c, i) => (
                  <tr key={`${c.player_id}-${i}`}><td>{i + 1}</td><td className="l">{c.player_id ? <Link href={playerPath({ id: c.player_id, name: c.name })}><b>{c.name}</b></Link> : c.name}</td><td className="l muted">{c.team}</td><td>{c.yellow}</td><td>{c.red}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
        </div>

        <section className="card card-pad stack" style={{ marginTop: 20, gap: 16 }}>
          <h2 className="h4">Jamoalar gollari</h2>
          {tg.map((t) => (
            <Link key={t.id} href={`/jamoalar/${t.slug}`} className="row" style={{ gap: 14 }}>
              <Crest team={teamMap.get(t.id) || { id: t.id, name: t.name }} size={28} />
              <b className="tg-name" style={{ fontSize: 14 }}>{t.name}</b>
              <div className="bar grow"><i style={{ width: `${(t.goals / max) * 100}%` }} /></div>
              <span className="tnum" style={{ width: 120, textAlign: "right" }}><b>{t.goals}</b> <span className="muted">· {(t.goals / Math.max(1, t.played)).toFixed(1).replace(".", ",")} / o‘yin</span></span>
            </Link>
          ))}
        </section>
      </div>
    </>
  );
}
