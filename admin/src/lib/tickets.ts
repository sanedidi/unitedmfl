// Stadium layout model (constructor) and ticket types shared by the admin pages.

export type Zone = { key: string; name: string; kind: "oddiy" | "vip"; color: string };
export type Row = { label: string; seats: number; removed: number[]; blocked: number[] };
export type Section = {
  key: string; name: string; zone: string; gate: string;
  seat_mode: "free" | "numbered"; numbering: "ltr" | "rtl"; aisle_after: number[];
  x: number; y: number; rotation: number; rows: Row[];
};
export type Stand = {
  key: string; name: string; position: string; shape: "straight" | "arc" | "corner";
  x: number; y: number; rotation: number; template_id?: number | null; template_version?: number; sections: Section[];
};
export type Layout = { pitch: { x: number; y: number; w: number; h: number }; zones: Zone[]; stands: Stand[]; gates: { key: string; name: string; x: number; y: number }[] };
export type Stats = { seats: number; sellable: number; blocked: number; removed: number; sections: number; stands: number; by_zone: Record<string, number> };

export type LayoutVersion = { id: number; version: number; status: "draft" | "published" | "archived"; seats: number; note: string; created_at: string; updated_at: string; published_at: string | null; created_by: string; matches: number };
export type Venue = { id: number; name: string; city: string; archived: boolean; updated_at: string; published: LayoutVersion | null; draft: LayoutVersion | null; stats: Stats | null; preview: Layout | null; versions?: LayoutVersion[] };
export type LayoutView = { id: number; venue_id: number; venue_name: string; version: number; status: string; note: string; doc: Layout; stats: Stats; updated_at: string; warnings: string[]; sold_seats: string[]; sold_sections: string[] };
export type Template = { id: number; name: string; description: string; kind: "stand" | "section"; doc: Stand | Section; zones: Zone[]; seats: number; version: number; visibility: "private" | "all"; owner: string; mine: boolean; updated_at: string; linked_in: number };
export type LibraryStand = { venue_id: number; venue_name: string; layout_id: number; version: number; status: string; stand: Stand; zones: Zone[]; seats: number; name: string };

export const ZONE_COLORS = ["#9AA1AB", "#7AC70C", "#1F5FD6", "#E0A100", "#D93A4A", "#8B5CF6", "#0E9F8E", "#111418"];

/* ---------- geometry ---------- */
export const P = 10; // seat pitch in canvas units
export const SEAT = 8;
export const AISLE = 8;

export function maxSeats(s: Section) { return s.rows.reduce((m, r) => Math.max(m, r.seats), 0); }
export function seatX(s: Section, n: number) {
  const pos = s.numbering === "rtl" ? maxSeats(s) + 1 - n : n; // rtl: seat 1 on the right
  const before = s.aisle_after.filter((a) => a < pos).length;
  return (pos - 1) * P + before * AISLE;
}
export function sectionSize(s: Section) {
  const w = Math.max(1, maxSeats(s)) * P + s.aisle_after.filter((a) => a < maxSeats(s)).length * AISLE - (P - SEAT);
  const h = Math.max(1, s.rows.length) * P - (P - SEAT);
  return { w, h };
}
export function seatCount(s: Section) { return s.rows.reduce((n, r) => n + r.seats - r.removed.length, 0); }
export function sellableCount(s: Section) { return s.rows.reduce((n, r) => n + r.seats - r.removed.length - r.blocked.length, 0); }
export function standSeats(st: Stand) { return st.sections.reduce((n, s) => n + seatCount(s), 0); }

export function stats(l: Layout): Stats {
  const st: Stats = { seats: 0, sellable: 0, blocked: 0, removed: 0, sections: 0, stands: l.stands.length, by_zone: {} };
  for (const s of l.stands) for (const sec of s.sections) {
    st.sections++;
    for (const r of sec.rows) {
      const n = r.seats - r.removed.length;
      st.seats += n; st.removed += r.removed.length; st.blocked += r.blocked.length; st.sellable += n - r.blocked.length;
      st.by_zone[sec.zone] = (st.by_zone[sec.zone] || 0) + n - r.blocked.length;
    }
  }
  return st;
}

export const seatId = (sec: string, row: string, n: number) => `${sec}:${row}:${n}`;

/* ---------- builders ---------- */
export function newRow(label: string, seats: number): Row { return { label, seats, removed: [], blocked: [] }; }
export function newSection(key: string, rows: number, seats: number, zone = "", x = 0, y = 0): Section {
  return { key, name: key, zone, gate: "", seat_mode: "numbered", numbering: "ltr", aisle_after: [], x, y, rotation: 0,
    rows: Array.from({ length: rows }, (_, i) => newRow(String(i + 1), seats)) };
}
export function allSectionKeys(l: Layout) { return new Set(l.stands.flatMap((s) => s.sections.map((x) => x.key.toLowerCase()))); }
export function freeKey(l: Layout, base: string) {
  const used = allSectionKeys(l);
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
}
export function nextLetter(l: Layout) {
  const used = allSectionKeys(l);
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (![...used].some((k) => k.startsWith(c.toLowerCase()))) return c;
  return "S";
}

export type StandDraft = { name: string; position: string; shape: "straight" | "arc" | "corner"; sections: number; rows: number; seats: number; zone: string; aisle: boolean; prefix: string };

/** Generates a stand from the «Yangi tribuna» template form. */
export function buildStand(l: Layout, d: StandDraft, at: { x: number; y: number }): Stand {
  const secs: Section[] = [];
  const w = d.seats * P - (P - SEAT);
  const gap = d.aisle ? 14 : 4;
  for (let i = 0; i < d.sections; i++) {
    const key = freeKey({ ...l, stands: [...l.stands, { sections: secs } as unknown as Stand] }, `${d.prefix}${i + 1}`);
    const s = newSection(key, d.rows, d.seats, d.zone);
    if (d.shape === "arc") {
      const n = d.sections, step = 14, angle = (i - (n - 1) / 2) * step;
      const R = (w + gap) * n / (step * n * Math.PI / 180) || 400;
      const rad = (angle * Math.PI) / 180;
      s.x = Math.sin(rad) * R; s.y = R - Math.cos(rad) * R; s.rotation = angle;
    } else {
      s.x = i * (w + gap);
    }
    secs.push(s);
  }
  const rot: Record<string, number> = { N: 0, S: 180, W: 270, E: 90, NW: -45, NE: 45, SW: 225, SE: 135 };
  return { key: `s${Date.now().toString(36)}`, name: d.name, position: d.position, shape: d.shape, x: at.x, y: at.y,
    rotation: d.shape === "corner" ? rot[d.position] ?? 45 : rot[d.position] ?? 0, template_id: null, sections: secs };
}

/** Deep copy with fresh section keys (prefix optional): placing a template or a stand from another venue. */
export function cloneStand(l: Layout, src: Stand, prefix: string, at: { x: number; y: number }, link?: { id: number; version: number }): Stand {
  const st: Stand = JSON.parse(JSON.stringify(src));
  const keys = allSectionKeys(l);
  st.sections.forEach((s, i) => {
    let k = prefix ? `${prefix}${i + 1}` : s.key;
    for (let n = 2; keys.has(k.toLowerCase()); n++) k = `${prefix || s.key}${prefix ? i + 1 : ""}-${n}`;
    keys.add(k.toLowerCase());
    if (s.name === s.key) s.name = k;
    s.key = k;
  });
  st.key = `s${Date.now().toString(36)}${Math.floor(Math.random() * 99)}`;
  st.x = at.x; st.y = at.y;
  st.template_id = link ? link.id : null;
  st.template_version = link ? link.version : 0;
  return st;
}

export function mergeZones(l: Layout, zones: Zone[]) {
  const out = [...l.zones];
  for (const z of zones) if (!out.some((x) => x.key === z.key)) out.push(z);
  return out;
}

export function standBox(st: Stand) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of st.sections) {
    const { w, h } = sectionSize(s);
    const r = (s.rotation * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
    for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
      const x = s.x + px * c - py * sn, y = s.y + px * sn + py * c;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Bounding box of the whole layout in canvas units (for «Sig‘dirish»). */
export function layoutBox(l: Layout) {
  let x0 = l.pitch.x, y0 = l.pitch.y, x1 = l.pitch.x + l.pitch.w, y1 = l.pitch.y + l.pitch.h;
  for (const st of l.stands) {
    const b = standBox(st), r = (st.rotation * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    for (const [px, py] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) {
      const x = st.x + px * c - py * s, y = st.y + px * s + py * c;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return { x: x0 - 30, y: y0 - 40, w: x1 - x0 + 60, h: y1 - y0 + 70 };
}

/* ---------- tickets ---------- */
export type ZonePrice = {
  zone_key: string; title: string; subtitle: string; price: number; enabled: boolean; named: boolean; perks: string[]; gate: string; sort: number;
  kind: "oddiy" | "vip"; color: string; mode: "free" | "numbered"; capacity: number; sold: number; held: number; left: number; sections: string[]; configured: boolean;
};
export type Sale = {
  id: number; match_id: number; layout_id: number | null; status: "draft" | "open" | "paused" | "closed"; sale_from: string | null; sale_to: string | null;
  hold_minutes: number; max_per_order: number; refund_hours: number; service_fee: number; telegram_delivery: boolean; box_office: boolean;
  dynamic_qr: boolean; single_scan: boolean; face_mode: "off" | "vip" | "all"; face_check: "auto" | "manual"; face_threshold: number;
  activation_hours: number; transfer_allowed: boolean; no_face_entry: boolean; face_retention_days: number; opened_at: string | null; updated_at: string;
};
export type MatchInfo = { id: number; title: string; stage: string; kickoff_at: string | null; venue: string; status: string };
export type SaleView = { match: MatchInfo; sale: Sale | null; zones: ZonePrice[]; layout: LayoutView | null; revenue: number; daily: { day: string; count: number }[]; entry: Record<string, number>; gates: string[] };
export type SaleRow = { match_id: number; title: string; stage: string; kickoff_at: string | null; venue: string; match_status: string; sale_id: number | null; status: string; sale_from: string | null; sale_to: string | null; zones: ZonePrice[]; revenue: number; sold: number; capacity: number };
export type OrderRow = { id: number; number: string; created_at: string; paid_at: string | null; buyer_name: string; phone: string; match: string; match_id: number; items: { zone: string; qty: number }[]; total: number; refunded: number; provider: string; status: string; source: string; hold_until: string | null };
export type TicketV = { id: number; number: string; zone_key: string; zone_name: string; zone_kind: string; section: string; row: string; seat: number | null; gate: string; price: number; holder_name: string; status: string; face_status: string; activated_at: string | null; transfer_sent_at: string | null; used_at: string | null; used_gate: string; perks: string[] };

export const SALE_STATUS: Record<string, { label: string; tone: string }> = {
  none: { label: "Sotuv yo‘q", tone: "" }, draft: { label: "Qoralama", tone: "" }, open: { label: "Sotuvda", tone: "ok" },
  paused: { label: "To‘xtatilgan", tone: "warn" }, closed: { label: "Yopilgan", tone: "" },
};
export const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "To‘lov kutilmoqda", tone: "warn" }, paid: { label: "To‘langan", tone: "ok" }, refund_requested: { label: "Qaytarish so‘rovi", tone: "info" },
  partially_refunded: { label: "Qisman qaytarilgan", tone: "info" }, refunded: { label: "Qaytarilgan", tone: "danger" }, cancelled: { label: "Bekor", tone: "" }, expired: { label: "Muddati o‘tgan", tone: "" },
};
export const TICKET_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "To‘lanmagan", tone: "warn" }, active: { label: "Faol", tone: "ok" }, used: { label: "Kirdi", tone: "info" }, cancelled: { label: "Bekor", tone: "" }, refunded: { label: "Qaytarilgan", tone: "danger" },
};
export const PROVIDER: Record<string, string> = { payme: "Payme", click: "Click", uzum: "Uzum", cash: "Kassa", test: "Test", "": "—" };
export const SCAN_RESULT: Record<string, { label: string; tone: string }> = {
  ok: { label: "Kirdi", tone: "ok" }, face_ok: { label: "Yuz mos keldi", tone: "ok" }, document: { label: "Hujjat bilan", tone: "ok" },
  used: { label: "Ishlatilgan chipta", tone: "danger" }, stale: { label: "QR eskirgan (skrinshot)", tone: "warn" }, invalid: { label: "Soxta / noma’lum", tone: "danger" },
  cancelled: { label: "Bekor qilingan chipta", tone: "danger" }, wrong_match: { label: "Boshqa match", tone: "warn" }, not_activated: { label: "Faollashtirilmagan", tone: "warn" },
  face_mismatch: { label: "Yuz mos kelmadi", tone: "danger" }, rejected: { label: "Rad etildi", tone: "danger" },
};
