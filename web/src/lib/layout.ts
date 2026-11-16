// Homepage layout (built in the admin's «Bosh sahifa» builder) and the rules
// that decide which blocks are on right now. Keep in sync with
// admin/src/lib/layout.ts and backend/internal/api/homepage.go.

export type ModuleType =
  | "intro" | "hero" | "fmatch" | "live" | "upcoming" | "results" | "standings" | "scorers" | "stats"
  | "news" | "fnews" | "video" | "gallery" | "social" | "player" | "team" | "partners" | "banner" | "custom" | "shop";

export type Variant = "compact" | "standard" | "wide" | "featured";

export type Schedule = {
  mode: "always" | "range" | "weekly" | "match";
  start?: string; // Tashkent local "2026-11-30T23:59"
  end?: string;
  days?: number[]; // 0 = Monday … 6 = Sunday
  from?: string; // "18:00"
  to?: string;
  before?: number; // minutes before kick-off
  after?: number; // minutes after the final whistle
  onEnd?: "hide" | "replace";
};

export type Devices = { desktop: boolean; tablet: boolean; mobile: boolean };

export type Block = {
  id: string;
  type: ModuleType;
  variant: Variant;
  span: number;
  title?: string;
  hideTitle?: boolean;
  linkLabel?: string;
  linkHref?: string;
  bg?: "" | "subtle" | "dark";
  props?: Record<string, unknown>;
  devices?: Devices;
  mobileOrder?: number;
  schedule?: Schedule;
  alt?: Block;
  hidden?: boolean;
  locked?: boolean;
};

export type Row = {
  id: string;
  gap?: number;
  bg?: "" | "subtle" | "dark";
  pad?: "" | "S" | "M" | "L";
  equal?: boolean;
  hidden?: boolean;
  blocks: Block[];
};

export type Layout = { v: 1; rows: Row[] };

/** Same as the API's default: the homepage as it was before the builder. */
export const DEFAULT_LAYOUT: Layout = {
  v: 1,
  rows: [
    { id: "r_hero", blocks: [{ id: "b_hero", type: "hero", variant: "featured", span: 12 }] },
    { id: "r_intro", blocks: [{ id: "b_intro", type: "intro", variant: "featured", span: 12 }] },
    { id: "r_matches", blocks: [{ id: "b_matches", type: "upcoming", variant: "featured", span: 12, props: { count: 4, withLive: true, withResults: true } }] },
    { id: "r_table", bg: "subtle", blocks: [
      { id: "b_table", type: "standings", variant: "wide", span: 8, props: { group: "" } },
      { id: "b_stats", type: "stats", variant: "compact", span: 4, props: { scorers: 5 } },
    ] },
    { id: "r_news", blocks: [{ id: "b_news", type: "news", variant: "featured", span: 12, props: { count: 5 } }] },
    { id: "r_video", blocks: [{ id: "b_video", type: "video", variant: "featured", span: 12, props: { count: 3 } }] },
    { id: "r_shop", bg: "subtle", blocks: [{ id: "b_shop", type: "shop", variant: "featured", span: 12, props: { count: 4 } }] },
    { id: "r_partners", blocks: [{ id: "b_partners", type: "partners", variant: "featured", span: 12, title: "Final homiylari", linkLabel: "Hamkor bo‘lish", linkHref: "/biz-haqimizda#aloqa",
      props: { items: [{ name: "realme" }, { name: "Click" }, { name: "Wildberries" }], cta: true } }] },
  ],
};

// ---------- time ----------

/** Uzbekistan has no daylight saving time: Tashkent is always UTC+5. */
const TZ_OFFSET_MS = 5 * 3600_000;
const MATCH_LENGTH_MIN = 100; // kick-off to final whistle, incl. half-time

/** "2026-11-30T23:59" in Tashkent time → epoch ms. */
export const tashkentMs = (local: string) => Date.parse(`${local}:00+05:00`);

const clockMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export type MatchTime = { status: string; kickoff_at: string };

/** Whether a scheduled block is on at `now` (epoch ms). */
export function scheduleActive(s: Schedule | undefined, now: number, matches: MatchTime[] = []): boolean {
  if (!s || s.mode === "always") return true;
  if (s.mode === "range") {
    if (s.start && now < tashkentMs(s.start)) return false;
    if (s.end && now >= tashkentMs(s.end)) return false;
    return true;
  }
  if (s.mode === "weekly") {
    const local = new Date(now + TZ_OFFSET_MS);
    const day = (local.getUTCDay() + 6) % 7;
    const min = local.getUTCHours() * 60 + local.getUTCMinutes();
    const days = s.days || [];
    const from = clockMin(s.from || "00:00");
    const to = clockMin(s.to || "00:00");
    if (from < to) return days.includes(day) && min >= from && min < to;
    // overnight window, e.g. 22:00 → 02:00
    return (days.includes(day) && min >= from) || (days.includes((day + 6) % 7) && min < to);
  }
  if (s.mode === "match") {
    const before = (s.before ?? 60) * 60_000;
    const after = (s.after ?? 120) * 60_000;
    return matches.some((m) => {
      if (m.status === "live" || m.status === "halftime") return true;
      const k = Date.parse(m.kickoff_at);
      if (!Number.isFinite(k)) return false;
      if (m.status === "scheduled") return now >= k - before && now < k + MATCH_LENGTH_MIN * 60_000;
      if (m.status === "finished") return now >= k - before && now < k + MATCH_LENGTH_MIN * 60_000 + after;
      return false;
    });
  }
  return true;
}

/** The block to show in this slot right now: the block, its replacement, or nothing. */
export function resolveBlock(b: Block, now: number, matches: MatchTime[]): Block | null {
  if (b.hidden) return null;
  if (scheduleActive(b.schedule, now, matches)) return b;
  if (b.schedule?.onEnd === "replace" && b.alt && !b.alt.hidden) {
    return { ...b.alt, span: b.span, devices: b.devices, mobileOrder: b.mobileOrder };
  }
  return null;
}

export const usesMatchSchedule = (l: Layout) => l.rows.some((r) => r.blocks.some((b) => b.schedule?.mode === "match"));

/** Parses the `at` preview parameter ("2026-12-01T10:00", Tashkent time). */
export function parseAt(at?: string): number | null {
  if (!at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) return null;
  const t = tashkentMs(at);
  return Number.isFinite(t) ? t : null;
}

// ---------- props helpers ----------

export const num = (v: unknown, def: number, min = 1, max = 24) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
export const str = (v: unknown, def = "") => (typeof v === "string" ? v : def);
export const bool = (v: unknown, def = false) => (typeof v === "boolean" ? v : def);
