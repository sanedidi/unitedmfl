import Link from "next/link";
import type { ReactNode } from "react";
import { fmtDate, fmtPlainDate, fmtTime, fmtWeekday, isFinished, isLive } from "@/lib/format";
import { groupKeys, groupName, groupProvisional, type Banner, type InstagramFeed, type Leaders, type Match, type MatchDetail, type NewsItem, type PlayerDetail, type Product, type Season, type Standings, type Team, type TeamDetail, type TeamRef, type Video } from "@/lib/types";
import { bool, num, str, type Block } from "@/lib/layout";
import { matchPath, newsPath, playerPath, teamPath } from "@/lib/seo";
import { HeroCarousel } from "@/components/HeroCarousel";
import { MatchCard } from "@/components/Match";
import { SectionHead } from "@/components/SectionHead";
import { StandingsTable } from "@/components/Standings";
import { NewsCard, ProductCard, VideoCard } from "@/components/Cards";
import { Crest } from "@/components/Crest";
import { Img } from "@/components/Img";
import { ArrowRight, Instagram, Play, Telegram, Youtube } from "@/components/Icons";

/** Everything the homepage modules may need, fetched once per request. */
export type HomeData = {
  banners: Banner[];
  matches: Match[];
  standings: Standings | null;
  leaders: Leaders | null;
  news: NewsItem[];
  pinnedNews: Record<string, NewsItem>;
  videos: Video[];
  products: Product[];
  teams: Team[];
  seasons: Season[];
  instagram: InstagramFeed | null;
  players: Record<string, PlayerDetail>;
  teamDetails: Record<string, TeamDetail>;
  galleries: Record<string, MatchDetail>;
  /** slugs shown by Featured News blocks: the news list skips them */
  pinnedSlugs: Set<string>;
  now: number;
};

type Ctx = { b: Block; d: HomeData; season?: Season };

const DEFAULT_HEAD: Partial<Record<Block["type"], [string, string?, string?]>> = {
  fmatch: ["Asosiy match", "/matchlar", "Barcha matchlar"],
  live: ["Jonli", "/matchlar", "Barcha matchlar"],
  upcoming: ["Matchlar", "/matchlar", "Barcha matchlar"],
  results: ["So‘nggi natijalar", "/matchlar", "Barcha natijalar"],
  standings: ["Turnir jadvali", "/jadval", "To‘liq jadval"],
  scorers: ["To‘purarlar", "/statistika", "Statistika"],
  stats: ["Raqamlarda", "/statistika", "Statistika"],
  news: ["Yangiliklar", "/yangiliklar", "Barcha yangiliklar"],
  video: ["Video", "/media", "Media"],
  gallery: ["Foto", "/media", "Media"],
  social: ["Ijtimoiy tarmoqlar"],
  player: ["O‘yinchi", "/oyinchilar", "Barcha o‘yinchilar"],
  team: ["Jamoa", "/jamoalar", "Barcha jamoalar"],
  partners: ["Hamkorlar", "/biz-haqimizda#aloqa", "Hamkor bo‘lish"],
  shop: ["Rasmiy do‘kon", "/merch", "Barcha mahsulotlar"],
};

function Head({ b, title, href, label }: { b: Block; title?: string; href?: string; label?: string }) {
  if (b.hideTitle) return null;
  const def = DEFAULT_HEAD[b.type] || [""];
  const t = b.title || title || def[0];
  if (!t) return null;
  return <SectionHead title={t} href={b.linkHref || href || def[1]} linkLabel={b.linkLabel || label || def[2]} />;
}

/** Card columns for a block `span` columns wide (CSS narrows them further on small screens). */
const cols = (span: number, per: number, max = 4) => Math.max(1, Math.min(max, Math.floor(span / per)));

function Cards({ n, kind, children }: { n: number; kind?: string; children: ReactNode }) {
  return <div className={`hp-cards${kind ? ` hp-cards--${kind}` : ""}`} style={{ ["--cols" as string]: n }}>{children}</div>;
}

const seasonLabel = (s?: Season) => s?.name || "United MFL";

// ---------- matches ----------

function MiniMatch({ m }: { m: Match }) {
  const played = m.home_score != null && m.away_score != null && m.status !== "scheduled";
  return (
    <Link href={matchPath(m)} className={`hp-mini${isLive(m) ? " is-live" : ""}`}>
      <span className="hp-mini-date">{isLive(m) ? <span className="badge badge-live">Jonli</span> : <>{fmtDate(m.kickoff_at, false)}<small>{played ? "Yakunlandi" : fmtTime(m.kickoff_at)}</small></>}</span>
      <span className="hp-mini-teams">
        <span><Crest team={m.home} size={20} /> <b>{m.home?.name || "Aniqlanmagan"}</b>{played && <em className="tnum">{m.home_score}</em>}</span>
        <span><Crest team={m.away} size={20} /> <b>{m.away?.name || "Aniqlanmagan"}</b>{played && <em className="tnum">{m.away_score}</em>}</span>
      </span>
    </Link>
  );
}

function MatchList({ b, list, season }: { b: Block; list: Match[]; season?: Season }) {
  if (b.variant === "compact" || b.span <= 4) {
    return <div className="card hp-mini-list">{list.map((m) => <MiniMatch key={m.id} m={m} />)}</div>;
  }
  return <Cards n={cols(b.span, 3, list.length || 1)}>{list.map((m) => <MatchCard key={m.id} match={m} season={seasonLabel(season)} />)}</Cards>;
}

const byKickoff = (a: Match, b: Match) => +new Date(a.kickoff_at) - +new Date(b.kickoff_at);

function Upcoming({ b, d, season }: Ctx) {
  const count = num(b.props?.count, 4, 1, 12);
  const live = bool(b.props?.withLive, true) ? d.matches.filter(isLive) : [];
  const next = d.matches.filter((m) => m.status === "scheduled").sort(byKickoff);
  let list = [...live, ...next];
  if (bool(b.props?.withResults, false)) list = [...list, ...d.matches.filter(isFinished).sort((x, y) => -byKickoff(x, y))];
  list = list.slice(0, count);
  if (!list.length) return null;
  return <><Head b={b} title={live.length ? "Jonli va yaqin matchlar" : undefined} /><MatchList b={b} list={list} season={season} /></>;
}

function Results({ b, d, season }: Ctx) {
  const list = d.matches.filter(isFinished).sort((x, y) => -byKickoff(x, y)).slice(0, num(b.props?.count, 4, 1, 12));
  if (!list.length) return null;
  return <><Head b={b} /><MatchList b={b} list={list} season={season} /></>;
}

function Live({ b, d, season }: Ctx) {
  const list = d.matches.filter(isLive).slice(0, num(b.props?.count, 2, 1, 8));
  if (!list.length) return null;
  return <><Head b={b} /><MatchList b={{ ...b, variant: b.variant === "compact" ? "compact" : "standard" }} list={list} season={season} /></>;
}

function pickFeatured(d: HomeData, id: number): Match | undefined {
  if (id) return d.matches.find((m) => m.id === id);
  return d.matches.find(isLive) || d.matches.filter((m) => m.status === "scheduled").sort(byKickoff)[0] || d.matches.filter(isFinished).sort((x, y) => -byKickoff(x, y))[0];
}

function FeaturedMatch({ b, d, season }: Ctx) {
  const m = pickFeatured(d, num(b.props?.matchId, 0, 0, 1e9));
  if (!m) return null;
  const played = m.home_score != null && m.away_score != null && m.status !== "scheduled";
  const stage = m.stage ? (m.stage.kind === "group" ? m.round || m.stage.name : m.stage.name) : seasonLabel(season);
  const side = (t: TeamRef | null) => (
    <div className="hp-fm-team">
      <Crest team={t} size={b.span >= 8 ? 72 : 52} />
      <b>{t?.name || "Aniqlanmagan"}</b>
    </div>
  );
  return (
    <>
      <Head b={b} />
      <article className={`card hp-fm${isLive(m) ? " is-live" : ""}`}>
        <div className="hp-fm-top">
          <span className="overline">{stage} · {seasonLabel(season)}</span>
          {isLive(m) ? <span className="badge badge-live">Jonli</span> : played ? <span className="badge badge-muted">Yakunlandi</span> : <span className="badge badge-upcoming">{fmtDate(m.kickoff_at, false)}</span>}
        </div>
        <div className="hp-fm-board">
          {side(m.home)}
          <div className="hp-fm-score tnum">{played || isLive(m) ? `${m.home_score ?? 0} : ${m.away_score ?? 0}` : fmtTime(m.kickoff_at)}{!played && !isLive(m) && <small>{fmtWeekday(m.kickoff_at)}</small>}</div>
          {side(m.away)}
        </div>
        <div className="hp-fm-foot">
          <span>{m.venue || fmtDate(m.kickoff_at)}</span>
          <span className="row" style={{ gap: 8 }}>
            {m.ticket_url && m.status === "scheduled" && <a className="btn btn-primary btn-sm" href={m.ticket_url} target="_blank" rel="noopener noreferrer">Chipta</a>}
            <Link className="btn btn-dark btn-sm" href={matchPath(m)}>Match markazi</Link>
          </span>
        </div>
      </article>
    </>
  );
}

// ---------- tournament ----------

function StandingsBlock({ b, d }: Ctx) {
  const st = d.standings;
  if (!st) return null;
  const keys = groupKeys(st);
  const want = str(b.props?.group);
  const groups = want === "all" ? keys : [want && st.groups[want] ? want : keys[0]].filter(Boolean) as string[];
  if (!groups.length) return null;
  const teamMap = new Map<number, TeamRef>(d.teams.map((t) => [t.id, t]));
  const compact = b.variant === "compact" || b.span <= 4;
  return (
    <>
      <Head b={b} />
      <div className={groups.length > 1 && b.span >= 12 ? "hp-cards" : "stack"} style={{ ["--cols" as string]: 2, display: "grid", gap: 24 }}>
        {groups.map((g) => <StandingsTable key={g} group={g} title={groupName(g, st.group_info?.[g]?.name)} rows={st.groups[g]} provisional={groupProvisional(st, g)} teams={teamMap} compact={compact} />)}
      </div>
    </>
  );
}

function ScorerList({ list }: { list: NonNullable<Leaders["scorers"]> }) {
  return (
    <section className="card card-pad" style={{ paddingTop: 8, paddingBottom: 8 }}>
      {list.map((sc, i) => (
        <Link key={`${sc.player_id}-${i}`} href={sc.player_id ? playerPath({ id: sc.player_id, name: sc.name }) : "/statistika"} className={`leader${i === 0 ? " first" : ""}`}>
          <span className="rank">{i + 1}</span>
          <span className="avatar">{sc.name.slice(0, 1)}</span>
          <span className="grow"><b style={{ display: "block", fontSize: 14 }}>{sc.name}</b><small className="muted">{sc.team}</small></span>
          <span className="val">{sc.goals}</span>
        </Link>
      ))}
    </section>
  );
}

function Scorers({ b, d }: Ctx) {
  const list = (d.leaders?.scorers || []).slice(0, num(b.props?.count, 5, 1, 20));
  if (!list.length) return null;
  return <><Head b={b} /><ScorerList list={list} /></>;
}

function Stats({ b, d, season }: Ctx) {
  const L = d.leaders;
  const leagueTeams = d.teams.filter((t) => t.group_label);
  const top = (L?.team_goals || []).filter((t) => t.group_label)[0];
  const scorers = (L?.scorers || []).slice(0, num(b.props?.scorers, 0, 0, 10));
  return (
    <>
      <Head b={b} />
      <section className={`card numbers${b.span >= 8 ? " hp-numbers-wide" : ""}`} aria-label="Liga raqamlarda">
        <div className="number-row"><b className="tnum">{L?.summary.goals ?? 0}</b><span>gol<small>{L?.summary.matches ?? 0} ta e’lon qilingan matchda</small></span></div>
        <div className="number-row"><b className="tnum">{(L?.summary.goals_per_match ?? 0).toString().replace(".", ",")}</b><span>gol / match<small>Mavsum bo‘yicha o‘rtacha</small></span></div>
        {top ? (
          <Link href={`/jamoalar/${top.slug}`} className="number-row"><b className="tnum">{top.goals}</b><span>gol — {top.name}<small>Eng hujumkor jamoa</small></span></Link>
        ) : (
          <div className="number-row"><b className="tnum">{season?.teams_planned ?? leagueTeams.length}</b><span>jamoa<small>Mavsum ishtirokchilari</small></span></div>
        )}
      </section>
      {scorers.length > 0 && <div style={{ marginTop: 24 }}><ScorerList list={scorers} /></div>}
    </>
  );
}

// ---------- content ----------

function News({ b, d }: Ctx) {
  const cat = str(b.props?.category);
  const list = d.news.filter((n) => !d.pinnedSlugs.has(n.slug) && (!cat || n.category === cat)).slice(0, num(b.props?.count, 5, 1, 12));
  if (!list.length) return null;
  let body: ReactNode;
  if (b.variant === "compact" || b.span <= 4) {
    body = <div>{list.map((n) => <NewsCard key={n.slug} item={n} compact />)}</div>;
  } else if (b.variant === "featured" && b.span >= 8) {
    body = (
      <div className="news-editorial">
        <NewsCard item={list[0]} feature />
        {list.length > 1 && <div>{list.slice(1).map((n) => <NewsCard key={n.slug} item={n} compact />)}</div>}
      </div>
    );
  } else {
    body = <Cards n={cols(b.span, 3, list.length)}>{list.map((n) => <NewsCard key={n.slug} item={n} />)}</Cards>;
  }
  return <><Head b={b} />{body}</>;
}

function FeaturedNews({ b, d }: Ctx) {
  const slug = str(b.props?.slug);
  const n = slug ? d.pinnedNews[slug] : d.news[0];
  if (!n) return null;
  const wide = b.span >= 8;
  return (
    <>
      {b.title && !b.hideTitle && <Head b={b} />}
      <Link href={newsPath(n)} className={`hp-fnews${wide ? " wide" : ""}${b.variant === "featured" && b.span === 12 ? " poster" : ""}`}>
        <div className="news-cover">{n.cover_url ? <Img src={n.cover_url} alt="" sizes={wide ? "(max-width: 1024px) 100vw, 760px" : "(max-width: 1024px) 100vw, 420px"} /> : <div className="ph" aria-hidden>UNITED MFL</div>}</div>
        <div className="hp-fnews-body">
          <div className="news-meta">{n.category && <span className="overline">{n.category}</span>}<span className="news-date">{fmtDate(n.published_at)}</span></div>
          <h3>{n.title}</h3>
          {n.excerpt && <p>{n.excerpt}</p>}
          <span className="hp-more">O‘qish <ArrowRight size={16} /></span>
        </div>
      </Link>
    </>
  );
}

function Videos({ b, d }: Ctx) {
  const list = d.videos.slice(0, num(b.props?.count, 3, 1, 12));
  if (!list.length) return null;
  return <><Head b={b} /><Cards n={cols(b.span, 4, list.length)}>{list.map((v) => <VideoCard key={v.id} v={v} />)}</Cards></>;
}

function Gallery({ b, d }: Ctx) {
  const g = d.galleries[b.id];
  if (!g?.photos?.length) return null;
  const photos = g.photos.slice(0, num(b.props?.count, 5, 1, 12));
  const href = matchPath(g.match);
  const title = `${g.match.home?.name || "?"} — ${g.match.away?.name || "?"}`;
  return (
    <>
      <Head b={b} href={href} label="Fotoreportaj" />
      <div className={`hp-gallery${b.span >= 8 ? " wide" : ""}`}>
        {photos.map((p, i) => (
          <Link key={p.id} href={href} className={`ph-tile${i === 0 ? " big" : ""}`} aria-label={i === 0 ? `${title}: fotoreportaj` : undefined}>
            <Img src={p.thumb_url || p.url} alt={p.caption || ""} sizes={i === 0 ? "(max-width: 720px) 100vw, 640px" : "(max-width: 720px) 50vw, 240px"} />
          </Link>
        ))}
      </div>
    </>
  );
}

const SOCIALS = () => [
  { label: "Instagram", href: process.env.SOCIAL_INSTAGRAM, icon: <Instagram size={18} /> },
  { label: "Telegram", href: process.env.SOCIAL_TELEGRAM, icon: <Telegram size={18} /> },
  { label: "YouTube", href: process.env.SOCIAL_YOUTUBE, icon: <Youtube size={18} /> },
].filter((s) => s.href);

function Social({ b, d }: Ctx) {
  const feed = d.instagram;
  const posts = feed?.username ? feed.posts.slice(0, num(b.props?.count, 6, 0, 12)) : [];
  const links = bool(b.props?.links, true) ? SOCIALS() : [];
  if (!posts.length && !links.length) return null;
  return (
    <>
      <Head b={b} href={feed?.username ? `https://www.instagram.com/${feed.username}/` : undefined} label={feed?.username ? `@${feed.username}` : undefined} />
      {posts.length > 0 && (
        <ul className="ig-grid hp-ig" style={{ ["--cols" as string]: cols(b.span, 2, 6) }}>
          {posts.map((p) => (
            <li key={p.id}>
              <a className="ig-tile" href={p.permalink} target="_blank" rel="noopener noreferrer" aria-label={p.caption.slice(0, 80) || "Instagram"}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.image_url} alt="" loading="lazy" decoding="async" />
                {(p.media_type === "VIDEO" || p.is_reel) && <span className="ig-mark"><Play size={14} /></span>}
              </a>
            </li>
          ))}
        </ul>
      )}
      {links.length > 0 && (
        <div className="hp-socials">
          {links.map((s) => <a key={s.label} href={s.href} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">{s.icon} {s.label}</a>)}
        </div>
      )}
    </>
  );
}

function PlayerSpot({ b, d }: Ctx) {
  const p = d.players[b.id];
  if (!p) return null;
  const s = p.stats;
  return (
    <>
      <Head b={b} title={str(b.props?.label) || undefined} />
      <Link href={playerPath(p.player)} className={`card hp-player${b.span >= 8 ? " wide" : ""}`}>
        <div className="hp-player-photo">{p.player.photo_url ? <Img src={p.player.photo_url} alt={p.player.full_name} sizes="(max-width: 720px) 100vw, 420px" /> : <span aria-hidden>{p.player.number ?? p.player.full_name.slice(0, 1)}</span>}</div>
        <div className="hp-player-body">
          <span className="overline">{p.team?.name || "United MFL"}{p.player.number != null ? ` · #${p.player.number}` : ""}</span>
          <h3>{p.player.full_name}</h3>
          <div className="hp-player-stats">
            <div><b className="tnum">{s.goals}</b><span>gol</span></div>
            <div><b className="tnum">{s.appearances}</b><span>match</span></div>
            <div><b className="tnum">{s.yellow}</b><span>sariq</span></div>
          </div>
        </div>
      </Link>
    </>
  );
}

function TeamSpot({ b, d }: Ctx) {
  const t = d.teamDetails[b.id];
  if (!t) return null;
  const next = t.matches.filter((m) => m.status === "scheduled").sort(byKickoff)[0];
  return (
    <>
      <Head b={b} />
      <Link href={teamPath(t.team)} className="card hp-team">
        <Crest team={t.team} size={72} />
        <div className="grow">
          <span className="overline">{t.team.group_label ? groupName(t.team.group_label, t.team.group_name) : "United MFL"}</span>
          <h3>{t.team.name}</h3>
          <p className="muted">{t.players.length} ta o‘yinchi{t.team.leader ? ` · Sardor: ${t.team.leader}` : ""}</p>
          {next && <p className="hp-team-next">Keyingi match: <b>{next.home?.id === t.team.id ? next.away?.name : next.home?.name}</b> · {fmtDate(next.kickoff_at, false)}, {fmtTime(next.kickoff_at)}</p>}
        </div>
      </Link>
    </>
  );
}

type PartnerItem = { name?: string; logo?: string; url?: string };

function Partners({ b }: Ctx) {
  const items = (Array.isArray(b.props?.items) ? (b.props!.items as PartnerItem[]) : []).filter((p) => p && (p.name || p.logo));
  const cta = bool(b.props?.cta, true);
  if (!items.length && !cta) return null;
  return (
    <>
      <Head b={b} />
      <div className="partners hp-partners" style={{ ["--cols" as string]: cols(b.span, 3, 4) }}>
        {items.map((p, i) => {
          const inner = p.logo ? <img src={p.logo} alt={p.name || ""} loading="lazy" decoding="async" /> : p.name;
          return p.url ? <a key={i} href={p.url} target="_blank" rel="noopener noreferrer sponsored" className="partner">{inner}</a> : <div key={i} className="partner">{inner}</div>;
        })}
        {cta && <Link href="/biz-haqimizda#aloqa" className="partner" style={{ fontSize: 14, fontFamily: "var(--font-ui)", fontWeight: 600, color: "var(--text-2)" }}>+ Sizning brendingiz</Link>}
      </div>
    </>
  );
}

function PromoBanner({ b }: Ctx) {
  const p = b.props || {};
  const image = str(p.image), imageM = str(p.imageMobile), title = str(p.title);
  if (!image && !title) return null;
  const cta = str(p.ctaLabel), url = str(p.ctaUrl);
  const external = /^https?:\/\//.test(url);
  return (
    <div className={`hp-banner${image ? "" : " plain"}${b.variant === "compact" ? " compact" : ""}`}>
      {image && (
        <picture className="hp-banner-bg">
          {imageM && <source media="(max-width: 720px)" srcSet={imageM} />}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} alt="" loading="lazy" decoding="async" />
        </picture>
      )}
      <div className="hp-banner-copy">
        {str(p.eyebrow) && <span className="overline">{str(p.eyebrow)}</span>}
        {title && <h2>{title}</h2>}
        {str(p.text) && <p>{str(p.text)}</p>}
      </div>
      {cta && url && (external
        ? <a className="btn btn-primary" href={url} target="_blank" rel="noopener noreferrer">{cta}</a>
        : <Link className="btn btn-primary" href={url}>{cta}</Link>)}
    </div>
  );
}

function Custom({ b }: Ctx) {
  const p = b.props || {};
  const text = str(p.text), image = str(p.image), cta = str(p.ctaLabel), url = str(p.ctaUrl);
  if (!text && !image && !b.title) return null;
  return (
    <div className={`hp-custom${image && b.span >= 8 ? " wide" : ""}`}>
      {image && <div className="hp-custom-img"><Img src={image} alt="" sizes="(max-width: 720px) 100vw, 640px" /></div>}
      <div className="hp-custom-body">
        {b.title && !b.hideTitle && <h2 className="h2">{b.title}</h2>}
        {text.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
        {cta && url && <Link className="btn btn-dark" href={url}>{cta}</Link>}
      </div>
    </div>
  );
}

function Shop({ b, d }: Ctx) {
  const list = d.products.slice(0, num(b.props?.count, 4, 1, 12));
  if (!list.length) return null;
  return <><Head b={b} /><Cards n={cols(b.span, 3, list.length)} kind="shop">{list.map((p) => <ProductCard key={p.id} p={p} />)}</Cards></>;
}

function Intro({ b, d, season }: Ctx) {
  const leagueTeams = d.teams.filter((t) => t.group_label);
  const title = str(b.props?.title) || "United MFL — media futbol ligasi";
  const text = str(b.props?.text);
  return (
    <section className="intro" aria-labelledby="intro-title">
      <div className="container intro-inner">
        <h1 id="intro-title">{title}</h1>
        {text ? <p className="lead">{text}</p> : (
          <p className="lead">
            United MFL{season ? ` ${season.name.replace("United MFL ", "")} mavsumida` : ""} {season?.teams_planned ?? leagueTeams.length} ta jamoa: blogerlar, sportchilar va san’at yulduzlari.
            Bu yerda <Link href="/matchlar">matchlar taqvimi va natijalar</Link>, <Link href="/jadval">turnir jadvali</Link>,{" "}
            <Link href="/jamoalar">jamoalar</Link>, <Link href="/oyinchilar">o‘yinchilar</Link> va <Link href="/yangiliklar">liga yangiliklari</Link>.
          </p>
        )}
      </div>
    </section>
  );
}

function Hero({ d, season }: Ctx) {
  if (!d.banners.length) return null;
  const dates = Object.fromEntries(d.banners.map((x) => [x.id, fmtPlainDate(x.event_date)]));
  return <HeroCarousel banners={d.banners} dates={dates} season={season?.name} />;
}

const MODULES: Record<Block["type"], (c: Ctx) => ReactNode> = {
  intro: Intro, hero: Hero, fmatch: FeaturedMatch, live: Live, upcoming: Upcoming, results: Results,
  standings: StandingsBlock, scorers: Scorers, stats: Stats, news: News, fnews: FeaturedNews, video: Videos,
  gallery: Gallery, social: Social, player: PlayerSpot, team: TeamSpot, partners: Partners, banner: PromoBanner,
  custom: Custom, shop: Shop,
};

/** Renders one block's content, or null when it has nothing to show (the slot is then left out). */
export function renderModule(b: Block, d: HomeData): ReactNode {
  const season = d.seasons.find((s) => s.is_active) || d.seasons[0];
  const fn = MODULES[b.type];
  return fn ? fn({ b, d, season }) : null;
}
