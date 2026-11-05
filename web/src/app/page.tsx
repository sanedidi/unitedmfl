import Link from "next/link";
import { api, safe } from "@/lib/api";
import { fmtPlainDate, isFinished, isLive } from "@/lib/format";
import type { Banner, Leaders, Match, NewsItem, Product, Season, Standings, Team, Video } from "@/lib/types";
import { HeroCarousel } from "@/components/HeroCarousel";
import { MatchCard, ResultRow } from "@/components/Match";
import { SectionHead } from "@/components/SectionHead";
import { StandingsTable } from "@/components/Standings";
import { NewsCard, ProductCard, VideoCard } from "@/components/Cards";
import { Crest } from "@/components/Crest";
import { ChevronRight } from "@/components/Icons";

const PARTNERS = ["realme", "Click", "Wildberries"]; // final sponsors announced on unitedmfl.com

export default async function Home() {
  const [banners, matches, standings, leaders, news, products, videos, teams, seasons] = await Promise.all([
    safe(api<Banner[]>("/banners"), []),
    safe(api<Match[]>("/matches?limit=200"), []),
    safe(api<Standings | null>("/standings"), null),
    safe(api<Leaders | null>("/stats/leaders"), null),
    safe(api<NewsItem[]>("/news?limit=5"), []),
    safe(api<Product[]>("/products?featured=true"), []),
    safe(api<Video[]>("/videos?limit=3"), []),
    safe(api<Team[]>("/teams"), []),
    safe(api<Season[]>("/seasons"), []),
  ]);

  const season = seasons.find((s) => s.is_active) || seasons[0];
  const live = matches.filter(isLive);
  const upcoming = matches.filter((m) => m.status === "scheduled").sort((a, b) => +new Date(a.kickoff_at) - +new Date(b.kickoff_at));
  const featured = [...live, ...upcoming].slice(0, 3);
  const results = matches.filter(isFinished).sort((a, b) => +new Date(b.kickoff_at) - +new Date(a.kickoff_at)).slice(0, 6);
  const teamMap = new Map(teams.map((t) => [t.id, t]));
  const leagueTeams = teams.filter((t) => t.group_label);
  const firstGroup = standings ? Object.keys(standings.groups).sort()[0] : undefined;
  const scorers = (leaders?.scorers || []).slice(0, 5);
  const teamGoals = (leaders?.team_goals || []).filter((t) => t.group_label).slice(0, 8);
  const maxGoals = Math.max(1, ...teamGoals.map((t) => t.goals));
  const dates = Object.fromEntries(banners.map((b) => [b.id, fmtPlainDate(b.event_date)]));

  return (
    <>
      <HeroCarousel banners={banners} dates={dates} />

      <section className="facts" aria-label="Liga raqamlarda">
        <div className="container facts-inner">
          <div className="fact"><b>{season?.teams_planned ?? leagueTeams.length}</b><span>jamoa</span></div>
          <div className="fact"><b>{season?.matches_planned ?? matches.length}</b><span>match mavsumda</span></div>
          <div className="fact"><b>{leaders?.summary.goals ?? 0}</b><span>gol urildi</span></div>
          <div className="fact"><b>{(leaders?.summary.goals_per_match ?? 0).toString().replace(".", ",")}</b><span>gol har matchda</span></div>
        </div>
      </section>

      {featured.length > 0 && (
        <section className="section">
          <div className="container">
            <SectionHead overline="Matchlar" title={live.length ? "Jonli va yaqin matchlar" : "Yaqin matchlar"} href="/matchlar" />
            <div className="grid grid-3">
              {featured.map((m) => <MatchCard key={m.id} match={m} season={season?.name} />)}
            </div>
          </div>
        </section>
      )}

      {results.length > 0 && (
        <section className="section">
          <div className="container">
            <SectionHead overline="Natijalar" title="So‘nggi natijalar" href="/matchlar?holat=yakunlangan" />
            <div className="card">{results.map((m) => <ResultRow key={m.id} match={m} />)}</div>
          </div>
        </section>
      )}

      {standings && firstGroup && (
        <section className="section">
          <div className="container">
            <SectionHead overline="Guruh bosqichi" title="Turnir jadvali" href="/jadval" />
            <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.7fr) minmax(0, 1fr)", alignItems: "start" }} data-split>
              <StandingsTable group={firstGroup} rows={standings.groups[firstGroup]} provisional={standings.groups_provisional} teams={teamMap} />
              <section className="card card-pad">
                <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                  <h3 className="h4">Bombardirlar</h3>
                  <Link href="/statistika" className="link-more" style={{ fontSize: 12, color: "var(--text-2)" }}>Barchasi <ChevronRight size={14} /></Link>
                </div>
                {scorers.length === 0 ? (
                  <p className="muted" style={{ fontSize: 14 }}>O‘yinchilar statistikasi hali e’lon qilinmagan.</p>
                ) : (
                  scorers.map((s, i) => (
                    <Link key={`${s.player_id}-${i}`} href={s.player_id ? `/oyinchilar/${s.player_id}` : "/statistika"} className={`leader${i === 0 ? " first" : ""}`}>
                      <span className="rank">{i + 1}</span>
                      <span className="avatar">{s.name.slice(0, 1)}</span>
                      <span className="grow"><b style={{ display: "block" }}>{s.name}</b><small className="muted">{s.team}</small></span>
                      <span className="val">{s.goals}</span>
                    </Link>
                  ))
                )}
              </section>
            </div>
          </div>
        </section>
      )}

      {teamGoals.length > 0 && (
        <section className="section">
          <div className="container">
            <SectionHead overline="Statistika" title="Eng ko‘p gol urgan jamoalar" href="/statistika" />
            <div className="card card-pad stack" style={{ gap: 18 }}>
              {teamGoals.map((t) => (
                <Link key={t.id} href={`/jamoalar/${t.slug}`} className="row" style={{ gap: 16 }}>
                  <Crest team={teamMap.get(t.id) || { id: t.id, name: t.name }} size={32} />
                  <b className="tg-name">{t.name}</b>
                  <div className="bar grow"><i style={{ width: `${(t.goals / maxGoals) * 100}%` }} /></div>
                  <span className="tnum" style={{ width: 90, textAlign: "right", fontFamily: "var(--font-display)", fontWeight: 800 }}>{t.goals}<small className="muted" style={{ fontFamily: "var(--font-ui)", fontWeight: 500 }}> / {t.played} o‘yin</small></span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {leagueTeams.length > 0 && (
        <section className="section">
          <div className="container">
            <SectionHead overline="Ishtirokchilar" title={`${leagueTeams.length} jamoa`} href="/jamoalar" />
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
              {leagueTeams.map((t) => (
                <Link key={t.id} href={`/jamoalar/${t.slug}`} className="card card-hover team-tile" style={{ padding: 18 }}>
                  <Crest team={t} size={56} />
                  <b style={{ fontSize: 14 }}>{t.name}</b>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {videos.length > 0 && (
        <section className="section">
          <div className="container">
            <SectionHead overline="Media" title="Video" href="/media" />
            <div className="grid grid-3">{videos.map((v) => <VideoCard key={v.id} v={v} />)}</div>
          </div>
        </section>
      )}

      {news.length > 0 && (
        <section className="section">
          <div className="container">
            <SectionHead overline="Yangiliklar" title="So‘nggi yangiliklar" href="/yangiliklar" />
            <div className="grid grid-4">
              {news.map((n, i) => <NewsCard key={n.slug} item={n} feature={i === 0} />)}
            </div>
          </div>
        </section>
      )}

      {products.length > 0 && (
        <section className="section">
          <div className="container">
            <SectionHead overline="Do‘kon" title="Rasmiy merch" href="/merch" />
            <div className="grid grid-4">{products.slice(0, 4).map((p) => <ProductCard key={p.id} p={p} />)}</div>
          </div>
        </section>
      )}

      <section className="section">
        <div className="container">
          <SectionHead overline="Hamkorlar" title="Final homiylari" href="/biz-haqimizda#aloqa" linkLabel="Hamkor bo‘lish" />
          <div className="partners">
            {PARTNERS.map((p) => <div key={p} className="partner">{p}</div>)}
            <Link href="/biz-haqimizda#aloqa" className="partner" style={{ fontSize: 14, fontFamily: "var(--font-ui)", color: "var(--accent)" }}>+ Sizning brendingiz</Link>
          </div>
        </div>
      </section>
    </>
  );
}
