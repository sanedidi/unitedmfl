import Link from "next/link";
import { api, safe } from "@/lib/api";
import { fmtPlainDate, isFinished, isLive } from "@/lib/format";
import type { Banner, Leaders, Match, NewsItem, Product, Season, Standings, Team, Video } from "@/lib/types";
import { HeroCarousel } from "@/components/HeroCarousel";
import { MatchCard } from "@/components/Match";
import { SectionHead } from "@/components/SectionHead";
import { StandingsTable } from "@/components/Standings";
import { NewsCard, ProductCard, VideoCard } from "@/components/Cards";
import { pageMeta, playerPath } from "@/lib/seo";

const PARTNERS = ["realme", "Click", "Wildberries"]; // final sponsors announced on unitedmfl.com

export const metadata = pageMeta({
  title: "United MFL — media futbol ligasi: matchlar va natijalar",
  absoluteTitle: true,
  description: "United MFL — blogerlar, sportchilar va san’at yulduzlari jamoalari ligasi: matchlar taqvimi, jonli hisob, natijalar, turnir jadvali va yangiliklar.",
  path: "/",
});

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
  const teamMap = new Map(teams.map((t) => [t.id, t]));
  const leagueTeams = teams.filter((t) => t.group_label);
  const firstGroup = standings ? Object.keys(standings.groups).sort()[0] : undefined;
  const scorers = (leaders?.scorers || []).slice(0, 5);
  const teamGoals = (leaders?.team_goals || []).filter((t) => t.group_label).slice(0, 8);
  const dates = Object.fromEntries(banners.map((b) => [b.id, fmtPlainDate(b.event_date)]));

  const results = matches.filter(isFinished).sort((a, b) => +new Date(b.kickoff_at) - +new Date(a.kickoff_at));
  const strip = [...featured, ...results].slice(0, 4);
  const topTeam = teamGoals[0];

  return (
    <>
      <HeroCarousel banners={banners} dates={dates} season={season?.name} />

      <section className="intro" aria-labelledby="intro-title">
        <div className="container intro-inner">
          <h1 id="intro-title">United MFL — media futbol ligasi</h1>
          <p className="lead">
            United MFL{season ? ` ${season.name.replace("United MFL ", "")} mavsumida` : ""} {season?.teams_planned ?? leagueTeams.length} ta jamoa: blogerlar, sportchilar va san’at yulduzlari.
            Bu yerda <Link href="/matchlar">matchlar taqvimi va natijalar</Link>, <Link href="/jadval">turnir jadvali</Link>,{" "}
            <Link href="/jamoalar">jamoalar</Link>, <Link href="/oyinchilar">o‘yinchilar</Link> va <Link href="/yangiliklar">liga yangiliklari</Link>.
          </p>
        </div>
      </section>

      {strip.length > 0 && (
        <section className="section">
          <div className="container">
            <SectionHead title={live.length ? "Jonli va yaqin matchlar" : "Matchlar"} href="/matchlar" linkLabel="Barcha matchlar" />
            <div className="grid grid-4">
              {strip.map((m) => <MatchCard key={m.id} match={m} season={season?.name} />)}
            </div>
          </div>
        </section>
      )}

      {standings && firstGroup && (
        <section className="section alt">
          <div className="container">
            <div className="grid" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", alignItems: "start" }} data-split>
              <div>
                <SectionHead title="Turnir jadvali" href="/jadval" linkLabel="To‘liq jadval" />
                <StandingsTable group={firstGroup} rows={standings.groups[firstGroup]} provisional={standings.groups_provisional} teams={teamMap} />
              </div>
              <div>
                <SectionHead title="Raqamlarda" href="/statistika" linkLabel="Statistika" />
                <section className="card numbers" aria-label="Liga raqamlarda">
                  <div className="number-row"><b className="tnum">{leaders?.summary.goals ?? 0}</b><span>gol<small>{leaders?.summary.matches ?? 0} ta e’lon qilingan matchda</small></span></div>
                  <div className="number-row"><b className="tnum">{(leaders?.summary.goals_per_match ?? 0).toString().replace(".", ",")}</b><span>gol / match<small>Mavsum bo‘yicha o‘rtacha</small></span></div>
                  {topTeam ? (
                    <Link href={`/jamoalar/${topTeam.slug}`} className="number-row"><b className="tnum">{topTeam.goals}</b><span>gol — {topTeam.name}<small>Eng hujumkor jamoa</small></span></Link>
                  ) : (
                    <div className="number-row"><b className="tnum">{season?.teams_planned ?? leagueTeams.length}</b><span>jamoa<small>Mavsum ishtirokchilari</small></span></div>
                  )}
                </section>
                {scorers.length > 0 && (
                  <section className="card card-pad" style={{ marginTop: 24, paddingTop: 8, paddingBottom: 8 }}>
                    {scorers.map((sc, i) => (
                      <Link key={`${sc.player_id}-${i}`} href={sc.player_id ? playerPath({ id: sc.player_id, name: sc.name }) : "/statistika"} className={`leader${i === 0 ? " first" : ""}`}>
                        <span className="rank">{i + 1}</span>
                        <span className="avatar">{sc.name.slice(0, 1)}</span>
                        <span className="grow"><b style={{ display: "block", fontSize: 14 }}>{sc.name}</b><small className="muted">{sc.team}</small></span>
                        <span className="val">{sc.goals}</span>
                      </Link>
                    ))}
                  </section>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {news.length > 0 && (
        <section className="section">
          <div className="container">
            <SectionHead title="Yangiliklar" href="/yangiliklar" linkLabel="Barcha yangiliklar" />
            <div className="news-editorial">
              <NewsCard item={news[0]} feature />
              {news.length > 1 && <div>{news.slice(1, 5).map((n) => <NewsCard key={n.slug} item={n} compact />)}</div>}
            </div>
          </div>
        </section>
      )}

      {videos.length > 0 && (
        <section className="section">
          <div className="container">
            <SectionHead title="Video" href="/media" linkLabel="Media" />
            <div className="grid grid-3">{videos.map((v) => <VideoCard key={v.id} v={v} />)}</div>
          </div>
        </section>
      )}

      {products.length > 0 && (
        <section className="section alt">
          <div className="container">
            <SectionHead title="Rasmiy do‘kon" href="/merch" linkLabel="Barcha mahsulotlar" />
            <div className="grid grid-4">{products.slice(0, 4).map((p) => <ProductCard key={p.id} p={p} />)}</div>
          </div>
        </section>
      )}

      <section className="section">
        <div className="container">
          <SectionHead title="Final homiylari" href="/biz-haqimizda#aloqa" linkLabel="Hamkor bo‘lish" />
          <div className="partners">
            {PARTNERS.map((p) => <div key={p} className="partner">{p}</div>)}
            <Link href="/biz-haqimizda#aloqa" className="partner" style={{ fontSize: 14, fontFamily: "var(--font-ui)", fontWeight: 600, color: "var(--text-2)" }}>+ Sizning brendingiz</Link>
          </div>
        </div>
      </section>
    </>
  );
}
