import type { Metadata } from "next";
import Link from "next/link";
import { api, safe } from "@/lib/api";
import type { NewsItem, Player, Team } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { Crest } from "@/components/Crest";
import { Search } from "@/components/Icons";

export const metadata: Metadata = { title: "Qidiruv", robots: { index: false } };

type SP = Promise<{ q?: string }>;
const norm = (s: string) => s.toLocaleLowerCase("uz").replace(/[‘’ʻʼ`']/g, "'");

export default async function SearchPage({ searchParams }: { searchParams: SP }) {
  const q = ((await searchParams).q || "").trim().slice(0, 80);
  const [teams, players, news] = q.length >= 2
    ? await Promise.all([
        safe(api<Team[]>("/teams"), []),
        safe(api<Player[]>(`/players?limit=24&q=${encodeURIComponent(q)}`), []),
        safe(api<NewsItem[]>("/news?limit=200"), []),
      ])
    : [[], [], []];
  const nq = norm(q);
  const t = teams.filter((x) => norm(x.name).includes(nq));
  const n = news.filter((x) => norm(x.title).includes(nq) || norm(x.excerpt).includes(nq)).slice(0, 12);
  const none = q.length >= 2 && !t.length && !players.length && !n.length;
  return (
    <>
      <PageTitle title="Qidiruv">
        <form className="search-form" action="/qidiruv" role="search" style={{ marginTop: 24 }}>
          <input className="input" name="q" defaultValue={q} placeholder="Jamoa, o‘yinchi yoki yangilik" aria-label="Qidiruv so‘rovi" autoFocus />
          <button className="btn btn-primary" aria-label="Qidirish"><Search /></button>
        </form>
      </PageTitle>
      <div className="container">
        {q.length > 0 && q.length < 2 && <div className="empty" style={{ marginTop: 32 }}>Kamida 2 ta belgi kiriting.</div>}
        {none && <div className="empty" style={{ marginTop: 32 }}>«{q}» bo‘yicha hech narsa topilmadi.</div>}
        {t.length > 0 && (
          <section style={{ marginTop: 32 }}>
            <h2 className="h4" style={{ marginBottom: 12 }}>Jamoalar</h2>
            <div className="grid grid-4" style={{ gap: 12 }}>{t.map((x) => <Link key={x.id} href={`/jamoalar/${x.slug}`} className="card card-hover player-tile"><Crest team={x} size={40} /><b>{x.name}</b></Link>)}</div>
          </section>
        )}
        {players.length > 0 && (
          <section style={{ marginTop: 32 }}>
            <h2 className="h4" style={{ marginBottom: 12 }}>O‘yinchilar</h2>
            <div className="grid grid-4" style={{ gap: 12 }}>{players.map((p) => <Link key={p.id} href={`/oyinchilar/${p.id}`} className="card card-hover player-tile"><span className="avatar">{p.full_name[0]}</span><span><b style={{ display: "block", fontSize: 14 }}>{p.full_name}</b><small className="muted">{p.team?.name}</small></span></Link>)}</div>
          </section>
        )}
        {n.length > 0 && (
          <section style={{ marginTop: 32 }}>
            <h2 className="h4" style={{ marginBottom: 12 }}>Yangiliklar</h2>
            <div className="card">{n.map((x) => <Link key={x.slug} href={`/yangiliklar/${x.slug}`} className="result-row" style={{ gridTemplateColumns: "1fr" }}><b>{x.title}</b></Link>)}</div>
          </section>
        )}
      </div>
    </>
  );
}
