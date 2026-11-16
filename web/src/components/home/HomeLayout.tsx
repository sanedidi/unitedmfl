import type { CSSProperties, ReactNode } from "react";
import { api, safe } from "@/lib/api";
import { num, resolveBlock, str, usesMatchSchedule, type Block, type Layout, type Row } from "@/lib/layout";
import type { Banner, InstagramFeed, Leaders, Match, MatchDetail, NewsItem, PlayerDetail, Product, Season, Standings, Team, TeamDetail, Video } from "@/lib/types";
import { renderModule, type HomeData } from "./modules";

const NEEDS: Record<string, Block["type"][]> = {
  banners: ["hero"],
  matches: ["fmatch", "live", "upcoming", "results", "gallery"],
  standings: ["standings"],
  leaders: ["scorers", "stats", "player"],
  news: ["news", "fnews"],
  videos: ["video"],
  products: ["shop"],
  instagram: ["social"],
};

/**
 * Resolves the layout for `now` (schedules, replacements), fetches only the
 * data the visible blocks need and renders the rows.
 */
export async function HomeLayout({ layout, now, fresh = false }: { layout: Layout; now: number; fresh?: boolean }) {
  const o = fresh ? { revalidate: 0 } : {};
  const needMatchesForSchedule = usesMatchSchedule(layout);
  const firstMatches = needMatchesForSchedule ? await safe(api<Match[]>("/matches?limit=200", o), []) : null;

  // 1. which block fills each slot right now
  const rows: { row: Row; blocks: Block[] }[] = [];
  for (const row of layout.rows) {
    if (row.hidden) continue;
    const blocks = row.blocks.map((b) => resolveBlock(b, now, firstMatches || [])).filter((b): b is Block => !!b);
    if (blocks.length) rows.push({ row, blocks });
  }
  const all = rows.flatMap((r) => r.blocks);
  const has = (key: string) => all.some((b) => NEEDS[key].includes(b.type));
  const any = (...t: Block["type"][]) => all.some((b) => t.includes(b.type));

  // 2. data — only what is on the page
  const newsLimit = Math.max(5, ...all.filter((b) => b.type === "news").map((b) => num(b.props?.count, 5, 1, 12) + 4));
  const videoLimit = Math.max(3, ...all.filter((b) => b.type === "video").map((b) => num(b.props?.count, 3, 1, 12)));
  const [banners, matches, standings, leaders, news, videos, products, teams, seasons, instagram] = await Promise.all([
    has("banners") ? safe(api<Banner[]>("/banners", o), []) : [],
    firstMatches ?? (has("matches") ? safe(api<Match[]>("/matches?limit=200", o), []) : []),
    has("standings") ? safe(api<Standings | null>("/standings", o), null) : null,
    has("leaders") ? safe(api<Leaders | null>("/stats/leaders", o), null) : null,
    has("news") ? safe(api<NewsItem[]>(`/news?limit=${newsLimit}`, o), []) : [],
    has("videos") ? safe(api<Video[]>(`/videos?limit=${videoLimit}`, o), []) : [],
    has("products") ? safe(api<Product[]>("/products?featured=true", o), []) : [],
    any("standings", "stats", "intro", "team") ? safe(api<Team[]>("/teams", o), []) : [],
    safe(api<Season[]>("/seasons", o), []),
    has("instagram") ? safe(api<InstagramFeed>("/instagram", o), null) : null,
  ]);

  // per-block extras: pinned news, spotlight player/team, match photos
  const pinnedNews: Record<string, NewsItem> = {};
  const players: Record<string, PlayerDetail> = {};
  const teamDetails: Record<string, TeamDetail> = {};
  const galleries: Record<string, MatchDetail> = {};
  const pinnedSlugs = new Set<string>();
  await Promise.all(all.map(async (b) => {
    if (b.type === "fnews") {
      const slug = str(b.props?.slug) || news[0]?.slug;
      if (!slug) return;
      pinnedSlugs.add(slug);
      const n = news.find((x) => x.slug === slug) || await safe(api<NewsItem | null>(`/news/${encodeURIComponent(slug)}`, o), null);
      if (n) pinnedNews[slug] = n;
    } else if (b.type === "player") {
      let id = num(b.props?.playerId, 0, 0, 1e9);
      if (!id) id = leaders?.scorers?.[0]?.player_id || 0;
      if (id) {
        const p = await safe(api<PlayerDetail | null>(`/players/${id}`, o), null);
        if (p) players[b.id] = p;
      }
    } else if (b.type === "team") {
      const slug = str(b.props?.slug) || teams[0]?.slug;
      if (slug) {
        const t = await safe(api<TeamDetail | null>(`/teams/${encodeURIComponent(slug)}`, o), null);
        if (t) teamDetails[b.id] = t;
      }
    } else if (b.type === "gallery") {
      const id = num(b.props?.matchId, 0, 0, 1e9);
      const tries = id ? [id] : matches.filter((m) => m.status === "finished").sort((x, y) => +new Date(y.kickoff_at) - +new Date(x.kickoff_at)).slice(0, 4).map((m) => m.id);
      for (const mid of tries) {
        const md = await safe(api<MatchDetail | null>(`/matches/${mid}`, o), null);
        if (md?.photos?.length) {
          galleries[b.id] = md;
          return;
        }
      }
    }
  }));
  // a pinned story stays out of the news lists
  if (!any("fnews")) pinnedSlugs.clear();

  const data: HomeData = { banners, matches, standings, leaders, news, pinnedNews, videos, products, teams, seasons, instagram, players, teamDetails, galleries, pinnedSlugs, now };

  // 3. render; blocks with nothing to show drop out
  const rendered = rows.map(({ row, blocks }) => ({
    row,
    items: blocks.map((b) => ({ b, node: renderModule(b, data) })).filter((x) => x.node != null && x.node !== false),
  })).filter((r) => r.items.length);

  // phones: a block may get its own place in the single-column order
  const flat = rendered.flatMap((r) => r.items.map((x) => x.b));
  const custom = flat.some((b) => (b.mobileOrder || 0) > 0);
  const order = new Map<string, number>();
  if (custom) {
    const rest = flat.filter((b) => !b.mobileOrder);
    const fixed = flat.filter((b) => (b.mobileOrder || 0) > 0).sort((x, y) => x.mobileOrder! - y.mobileOrder!);
    for (const f of fixed) rest.splice(Math.min(f.mobileOrder! - 1, rest.length), 0, f);
    rest.forEach((b, i) => order.set(b.id, i));
  }

  const hasH1 = rendered.some((r) => r.items.some((x) => x.b.type === "intro"));
  return (
    <div className={`hp${custom ? " hp-mflat" : ""}`}>
      {!hasH1 && <h1 className="sr-only">United MFL — media futbol ligasi</h1>}
      {rendered.map(({ row, items }) => {
        const devs = (k: "desktop" | "tablet" | "mobile") => items.every((x) => x.b.devices && !x.b.devices[k]);
        const rowCls = [devs("desktop") && "hp-no-d", devs("tablet") && "hp-no-t", devs("mobile") && "hp-no-m"].filter(Boolean).join(" ");
        const single = items.length === 1 ? items[0] : null;
        // hero and intro bring their own full-width frame
        if (single && (single.b.type === "hero" || single.b.type === "intro")) {
          return <div key={row.id} className={`hp-bleed ${blockCls(single.b)}`} style={{ ["--mo" as string]: order.get(single.b.id) ?? 0 } as CSSProperties}>{single.node}</div>;
        }
        const style = { ["--hp-gap" as string]: row.gap ? `${row.gap}px` : undefined } as CSSProperties;
        return (
          <section key={row.id} className={`hp-row ${row.bg ? `bg-${row.bg}` : "plain"} pad-${row.pad || "M"} ${rowCls}`} style={style}>
            <div className="container">
              <div className={`hp-grid${row.equal ? " equal" : ""}`}>
                {items.map(({ b, node }) => (
                  <Slot key={b.id} b={b} rowBg={row.bg} mo={order.get(b.id)} half={items.every((x) => x.b.span <= 6)}>{node}</Slot>
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function blockCls(b: Block) {
  const d = b.devices;
  return [d && !d.desktop && "hp-no-d", d && !d.tablet && "hp-no-t", d && !d.mobile && "hp-no-m"].filter(Boolean).join(" ");
}

/** `half`: on tablets the block takes half the width (its row has only narrow blocks). */
function Slot({ b, rowBg, mo, half, children }: { b: Block; rowBg?: string; mo?: number; half: boolean; children: ReactNode }) {
  const cls = ["hp-blk", `v-${b.variant}`, half && "t-6", blockCls(b), b.bg && `bbg-${b.bg}`, rowBg && `rbg-${rowBg}`].filter(Boolean).join(" ");
  return <div className={cls} data-block={b.id} data-type={b.type} style={{ ["--span" as string]: b.span || 12, ["--mo" as string]: mo ?? 0 } as CSSProperties}>{children}</div>;
}
