// Homepage layout model and schedule rules. The types, DEFAULT_LAYOUT and the
// schedule functions are a copy of web/src/lib/layout.ts (keep both in sync,
// and backend/internal/api/homepage.go); the builder helpers follow below.

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

// ======================= builder helpers (admin only) =======================

export type ModuleMeta = {
  type: ModuleType;
  name: string;
  desc: string;
  group: string;
  variant: Variant;
  span: number;
  spans: number[];
  props?: Record<string, unknown>;
};

const ALL = [3, 4, 6, 8, 9, 12];
export const MODULES: ModuleMeta[] = [
  { type: "hero", name: "Hero Section", desc: "Bosh e’lonlar, video-banner", group: "Asosiy", variant: "featured", span: 12, spans: [12] },
  { type: "intro", name: "Intro (H1)", desc: "Sahifa sarlavhasi va tavsif — SEO", group: "Asosiy", variant: "featured", span: 12, spans: [6, 8, 12] },
  { type: "fmatch", name: "Featured Match", desc: "Kun matchi, hisob va holat", group: "Matchlar", variant: "wide", span: 8, spans: [4, 6, 8, 12] },
  { type: "live", name: "Live Matches", desc: "Jonli matchlar", group: "Matchlar", variant: "wide", span: 8, spans: ALL, props: { count: 2 } },
  { type: "upcoming", name: "Upcoming Matches", desc: "Yaqin matchlar", group: "Matchlar", variant: "compact", span: 4, spans: ALL, props: { count: 3, withLive: true } },
  { type: "results", name: "Recent Results", desc: "So‘nggi natijalar", group: "Matchlar", variant: "compact", span: 4, spans: ALL, props: { count: 4 } },
  { type: "standings", name: "League Standings", desc: "Guruhlar jadvali", group: "Turnir", variant: "wide", span: 8, spans: ALL, props: { group: "" } },
  { type: "scorers", name: "Top Scorers", desc: "To‘purarlar", group: "Turnir", variant: "compact", span: 4, spans: ALL, props: { count: 5 } },
  { type: "stats", name: "Statistics", desc: "Raqamlar va ko‘rsatkichlar", group: "Turnir", variant: "compact", span: 4, spans: ALL, props: { scorers: 0 } },
  { type: "news", name: "Latest News", desc: "Yangiliklar lentasi", group: "Kontent", variant: "featured", span: 12, spans: ALL, props: { count: 5 } },
  { type: "fnews", name: "Featured News", desc: "Bitta katta yangilik", group: "Kontent", variant: "wide", span: 8, spans: [4, 6, 8, 12], props: { slug: "" } },
  { type: "video", name: "Video Highlights", desc: "Video obzorlar", group: "Kontent", variant: "wide", span: 8, spans: ALL, props: { count: 3 } },
  { type: "gallery", name: "Photo Gallery", desc: "Match fotoreportaji", group: "Kontent", variant: "wide", span: 8, spans: [4, 6, 8, 12], props: { count: 5 } },
  { type: "social", name: "Social Feed", desc: "Instagram va tarmoqlar", group: "Kontent", variant: "featured", span: 12, spans: ALL, props: { count: 6, links: true } },
  { type: "player", name: "Player Spotlight", desc: "O‘yinchi kartasi", group: "Kontent", variant: "standard", span: 6, spans: [4, 6, 8, 12], props: { playerId: 0 } },
  { type: "team", name: "Team Spotlight", desc: "Jamoa kartasi", group: "Kontent", variant: "standard", span: 6, spans: [4, 6, 8, 12], props: { slug: "" } },
  { type: "banner", name: "Custom Banner", desc: "Reklama yoki e’lon banneri", group: "Tijorat", variant: "featured", span: 12, spans: ALL, props: { title: "", eyebrow: "", text: "", image: "", imageMobile: "", ctaLabel: "", ctaUrl: "" } },
  { type: "partners", name: "Partners", desc: "Hamkorlar logotiplari", group: "Tijorat", variant: "featured", span: 12, spans: ALL, props: { items: [], cta: true } },
  { type: "shop", name: "Shop", desc: "Rasmiy do‘kon mahsulotlari", group: "Tijorat", variant: "featured", span: 12, spans: ALL, props: { count: 4 } },
  { type: "custom", name: "Custom Content", desc: "Matn, rasm va tugma", group: "Tijorat", variant: "standard", span: 6, spans: ALL, props: { text: "", image: "", ctaLabel: "", ctaUrl: "" } },
];
export const MODULE_GROUPS = ["Asosiy", "Matchlar", "Turnir", "Kontent", "Tijorat"];
export const meta = (t: ModuleType) => MODULES.find((m) => m.type === t) || MODULES[0];

export const VARIANTS: { key: Variant; label: string }[] = [
  { key: "compact", label: "Compact" }, { key: "standard", label: "Standard" }, { key: "wide", label: "Wide" }, { key: "featured", label: "Featured" },
];
export const variantForSpan = (s: number): Variant => (s <= 4 ? "compact" : s <= 6 ? "standard" : s <= 9 ? "wide" : "featured");

export const uid = (p = "b") => `${p}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function newBlock(type: ModuleType, span?: number): Block {
  const m = meta(type);
  const s = span && m.spans.includes(span) ? span : m.span;
  return { id: uid("b"), type, variant: span ? variantForSpan(s) : m.variant, span: s, props: m.props ? clone(m.props) : undefined };
}

export const rowSum = (r: Pick<Row, "blocks">) => r.blocks.reduce((a, b) => a + b.span, 0);

export const PRESETS: { key: string; spans: number[] }[] = [
  { key: "12", spans: [12] }, { key: "8+4", spans: [8, 4] }, { key: "4+8", spans: [4, 8] }, { key: "6+6", spans: [6, 6] },
  { key: "9+3", spans: [9, 3] }, { key: "4+4+4", spans: [4, 4, 4] }, { key: "6+3+3", spans: [6, 3, 3] }, { key: "3+3+3+3", spans: [3, 3, 3, 3] },
];
const EVEN: Record<number, number[]> = { 1: [12], 2: [6, 6], 3: [4, 4, 4], 4: [3, 3, 3, 3] };

/** Makes a row fit 12 columns: if the blocks are too wide, split it evenly. Hero always gets its own full row. */
export function fitRow(row: Row): Row {
  if (rowSum(row) <= 12) return row;
  const spans = EVEN[row.blocks.length] || EVEN[4];
  return { ...row, blocks: row.blocks.map((b, i) => ({ ...b, span: spans[i], variant: variantForSpan(spans[i]) })) };
}

/** Applies a column preset; extra blocks move to a new row below. */
export function applyPreset(l: Layout, rowId: string, spans: number[]): Layout {
  const next = clone(l);
  const ri = next.rows.findIndex((r) => r.id === rowId);
  if (ri < 0) return l;
  const row = next.rows[ri];
  const keep = row.blocks.slice(0, spans.length);
  const rest = row.blocks.slice(spans.length);
  row.blocks = keep.map((b, i) => ({ ...b, span: spans[i], variant: variantForSpan(spans[i]) }));
  if (rest.length) next.rows.splice(ri + 1, 0, fitRow({ id: uid("r"), blocks: rest.map((b) => ({ ...b, span: 12, variant: variantForSpan(12) })) }));
  return next;
}

export type Found = { ri: number; bi: number; row: Row; block: Block; alt: boolean };
export function findBlock(l: Layout, id: string): Found | null {
  for (let ri = 0; ri < l.rows.length; ri++) {
    const row = l.rows[ri];
    for (let bi = 0; bi < row.blocks.length; bi++) {
      const b = row.blocks[bi];
      if (b.id === id) return { ri, bi, row, block: b, alt: false };
      if (b.alt?.id === id) return { ri, bi, row, block: b.alt, alt: true };
    }
  }
  return null;
}

/** Replaces a block (or an alternate block) by id. */
export function updateBlock(l: Layout, id: string, fn: (b: Block) => Block): Layout {
  return {
    ...l,
    rows: l.rows.map((r) => ({
      ...r,
      blocks: r.blocks.map((b) => (b.id === id ? fn(b) : b.alt?.id === id ? { ...b, alt: fn(b.alt) } : b)),
    })),
  };
}
export const updateRow = (l: Layout, id: string, fn: (r: Row) => Row): Layout => ({ ...l, rows: l.rows.map((r) => (r.id === id ? fn(r) : r)) });

/** Removes a block; empty rows go away. */
export function removeBlock(l: Layout, id: string): Layout {
  return { ...l, rows: l.rows.map((r) => ({ ...r, blocks: r.blocks.filter((b) => b.id !== id) })).filter((r) => r.blocks.length) };
}

export type DropTarget = { kind: "row"; index: number } | { kind: "block"; rowId: string; index: number };

/** Inserts `block` at a drop target (a new row at `index`, or into a row before `index`). */
export function insertAt(l: Layout, block: Block, t: DropTarget): { layout: Layout; ok: boolean } {
  const next = clone(l);
  if (t.kind === "row" || block.type === "hero") {
    // a new row keeps the block's width; hero is always full width
    const index = t.kind === "row" ? t.index : next.rows.findIndex((r) => r.id === t.rowId) + 1;
    const span = block.type === "hero" ? 12 : block.span;
    next.rows.splice(index, 0, { id: uid("r"), blocks: [{ ...block, span }] });
    return { layout: next, ok: true };
  }
  const row = next.rows.find((r) => r.id === t.rowId);
  if (!row) return { layout: l, ok: false };
  if (row.blocks.length >= 4 || row.blocks.some((b) => b.type === "hero")) return { layout: l, ok: false };
  row.blocks.splice(t.index, 0, block);
  Object.assign(row, fitRow(row));
  return { layout: next, ok: true };
}

/** Moves a block to a drop target. */
export function moveBlock(l: Layout, id: string, t: DropTarget): { layout: Layout; ok: boolean } {
  const f = findBlock(l, id);
  if (!f || f.alt) return { layout: l, ok: false };
  // dropping into its own row: just reorder
  if (t.kind === "block" && t.rowId === f.row.id) {
    const next = clone(l);
    const row = next.rows[f.ri];
    const [b] = row.blocks.splice(f.bi, 1);
    row.blocks.splice(t.index > f.bi ? t.index - 1 : t.index, 0, b);
    return { layout: next, ok: true };
  }
  const without = clone(l);
  without.rows[f.ri].blocks.splice(f.bi, 1);
  // keep the target index valid when the source row disappears
  let target = t;
  if (!without.rows[f.ri].blocks.length) {
    without.rows.splice(f.ri, 1);
    if (t.kind === "row" && t.index > f.ri) target = { kind: "row", index: t.index - 1 };
  }
  const moved: Block = { ...f.block };
  const r = insertAt(without, moved, target);
  return r.ok ? r : { layout: l, ok: false };
}

export function moveRow(l: Layout, id: string, toIndex: number): Layout {
  const next = clone(l);
  const from = next.rows.findIndex((r) => r.id === id);
  if (from < 0) return l;
  const [r] = next.rows.splice(from, 1);
  next.rows.splice(toIndex > from ? toIndex - 1 : toIndex, 0, r);
  return next;
}

/** Fresh ids for a copied block (and its alternate). */
export function copyBlock(b: Block): Block {
  const c = clone(b);
  c.id = uid("b");
  if (c.alt) c.alt.id = uid("b");
  return c;
}

export function blockLabel(b: Block) {
  return b.title || meta(b.type).name;
}

// ---------- time ----------

const MON = ["yan", "fev", "mar", "apr", "may", "iyun", "iyul", "avg", "sen", "okt", "noy", "dek"];
export const DAYS = ["Du", "Se", "Ch", "Pa", "Ju", "Sh", "Ya"];

/** epoch ms → Tashkent "2026-11-30T23:59" (for <input type=datetime-local>). */
export function toLocal(ms: number) {
  const d = new Date(ms + 5 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
/** "2026-11-30T23:59" → "30-noy 23:59" */
export function shortLocal(local: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(local);
  return m ? `${+m[3]}-${MON[+m[2] - 1]} ${m[4]}` : local;
}
export function fmtDur(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d) return h ? `${d} kun ${h} soat` : `${d} kun`;
  if (h) return m ? `${h} soat ${m} daq` : `${h} soat`;
  return `${m} daq`;
}

/** Short description of a schedule for badges. */
export function scheduleText(s?: Schedule): string {
  if (!s || s.mode === "always") return "Doim";
  if (s.mode === "range") {
    if (s.start && s.end) return `${shortLocal(s.start)} – ${shortLocal(s.end)}`;
    if (s.end) return `${shortLocal(s.end)} gacha`;
    return `${shortLocal(s.start || "")} dan`;
  }
  if (s.mode === "weekly") return `${(s.days || []).slice().sort().map((d) => DAYS[d]).join(", ")} · ${s.from}–${s.to}`;
  return "Match kunlari";
}

/** Whether the block is on at `now`, and for how long (range mode). */
export function scheduleState(s: Schedule | undefined, now: number, matches: MatchTime[]): { active: boolean; text: string } {
  const active = scheduleActive(s, now, matches);
  if (!s || s.mode === "always") return { active, text: "Doim ko‘rinadi" };
  if (s.mode === "range") {
    const st = s.start ? tashkentMs(s.start) : null, en = s.end ? tashkentMs(s.end) : null;
    if (st && now < st) return { active, text: `${fmtDur(st - now)}dan keyin boshlanadi` };
    if (en && now >= en) return { active, text: "Muddati tugagan" };
    if (en) return { active, text: `Faol · ${fmtDur(en - now)} qoldi` };
    return { active, text: "Faol" };
  }
  if (s.mode === "match") {
    if (active) return { active, text: "Faol · match vaqti" };
    const next = matches.filter((m) => m.status === "scheduled" && Date.parse(m.kickoff_at) > now).sort((a, b) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at))[0];
    if (!next) return { active, text: "Rejalashtirilgan match yo‘q" };
    const at = Date.parse(next.kickoff_at) - (s.before ?? 60) * 60_000;
    return { active, text: `Keyingi ko‘rinish: ${shortLocal(toLocal(at))}` };
  }
  return { active, text: active ? "Faol · hozir ko‘rinadi" : "Hozir yashirin" };
}

// ---------- change list for the publish dialog ----------

/** JSON with sorted keys: the API (Postgres jsonb) does not keep key order. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function diffLayouts(prev: Layout, next: Layout): string[] {
  const out: string[] = [];
  const pos = (l: Layout) => {
    const m = new Map<string, { row: string; bi: number; b: Block }>();
    l.rows.forEach((r) => r.blocks.forEach((b, bi) => m.set(b.id, { row: r.id, bi, b })));
    return m;
  };
  const a = pos(prev), b = pos(next);
  for (const [id, x] of b) {
    const old = a.get(id);
    const name = blockLabel(x.b);
    if (!old) { out.push(`${name} qo‘shildi`); continue; }
    if (old.row !== x.row) out.push(`${name} boshqa qatorga ko‘chirildi`);
    else if (old.bi !== x.bi) out.push(`${name}: ustun o‘zgardi`);
    const o = old.b, n = x.b;
    if (o.span !== n.span || o.variant !== n.variant) out.push(`${name}: ${o.span}/12 ${o.variant} → ${n.span}/12 ${n.variant}`);
    if (stable(o.schedule || null) !== stable(n.schedule || null) || stable(o.alt || null) !== stable(n.alt || null)) out.push(`${name}: vaqt jadvali — ${scheduleText(n.schedule)}`);
    if (stable(o.devices || null) !== stable(n.devices || null) || (o.mobileOrder || 0) !== (n.mobileOrder || 0)) {
      const d = n.devices;
      out.push(d && !d.mobile && (!o.devices || o.devices.mobile) ? `${name} mobilda yashirildi` : `${name}: qurilmalar`);
    }
    if (!!o.hidden !== !!n.hidden) out.push(`${name} ${n.hidden ? "yashirildi" : "ko‘rsatildi"}`);
    const rest = (z: Block) => stable({ ...z, span: 0, variant: "", schedule: 0, alt: 0, devices: 0, mobileOrder: 0, hidden: 0, locked: 0 });
    if (rest(o) !== rest(n)) out.push(`${name}: sozlamalar`);
  }
  for (const [id, x] of a) if (!b.has(id)) out.push(`${blockLabel(x.b)} o‘chirildi`);
  // rows that changed place among the rows both versions have
  const common = (l: Layout, other: Layout) => l.rows.filter((r) => other.rows.some((o) => o.id === r.id)).map((r) => r.id);
  const ca = common(prev, next), cb = common(next, prev);
  // the rows outside the longest run kept in order are the ones that moved
  const idx = cb.map((id) => ca.indexOf(id));
  const len = idx.map(() => 1), from = idx.map(() => -1);
  idx.forEach((v, i) => { for (let j = 0; j < i; j++) if (idx[j] < v && len[j] + 1 > len[i]) { len[i] = len[j] + 1; from[i] = j; } });
  const keep = new Set<number>();
  for (let i = len.indexOf(Math.max(0, ...len)); i >= 0; i = from[i]) keep.add(i);
  cb.forEach((id, i) => {
    if (keep.has(i)) return;
    const r = next.rows.find((z) => z.id === id)!;
    out.push(`${r.blocks.map(blockLabel).join(" + ")} qatori ${idx[i] > i ? "yuqoriga" : "pastga"} ko‘chirildi`);
  });
  const rowsA = new Map(prev.rows.map((r) => [r.id, r]));
  next.rows.forEach((r, i) => {
    const o = rowsA.get(r.id);
    if (!o) return;
    const shape = (z: Row) => stable({ gap: z.gap || 0, bg: z.bg || "", pad: z.pad || "", equal: !!z.equal, hidden: !!z.hidden });
    if (shape(o) !== shape(r)) out.push(`${i + 1}-qator: sozlamalar`);
  });
  return [...new Set(out)];
}
