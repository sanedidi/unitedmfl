import { lazyT, useT } from "@/lib/i18n";
// Ticket sale on the site: types shared by the checkout, order and ticket pages
// and a tiny browser-side client for the public ticket API.

export type Zone = { key: string; name: string; kind: "oddiy" | "vip"; color: string };
export type Row = { label: string; seats: number; removed: number[] | null; blocked: number[] | null; zone_seats?: Record<string, number[]> };
export type Section = { key: string; name: string; zone: string; gate: string; seat_mode: "free" | "numbered"; numbering: "ltr" | "rtl"; aisle_after: number[] | null; x: number; y: number; rotation: number; rows: Row[] };
export type Stand = { key: string; name: string; x: number; y: number; rotation: number; sections: Section[] };
export type Layout = { pitch: { x: number; y: number; w: number; h: number }; zones: Zone[]; stands: Stand[] };

export type ZoneOffer = {
  zone_key: string; title: string; subtitle: string; price: number; enabled: boolean; named: boolean; perks: string[] | null; gate: string;
  kind: "oddiy" | "vip"; color: string; mode: "free" | "numbered"; capacity: number; sold: number; held: number; left: number; sections: string[] | null;
};
export type PublicSale = {
  match: MatchBrief; status: "none" | "soon" | "open" | "paused" | "closed" | "sold_out"; sale_from: string | null; sale_to: string | null;
  zones: ZoneOffer[]; layout: Layout | null; max_per_order: number; hold_minutes: number; refund_hours: number; service_fee: number;
  face_mode: "off" | "vip" | "all"; providers: string[]; telegram_delivery: boolean;
};
export type MatchBrief = { id: number; title: string; stage: string; kickoff_at: string | null; venue: string; status: string };
export type TicketV = {
  id: number; number: string; zone_key: string; zone_name: string; zone_kind: "oddiy" | "vip"; section: string; row: string; seat: number | null; gate: string;
  price: number; holder_name: string; status: string; face_status: "none" | "bound" | "document"; activated_at: string | null; transfer_sent_at: string | null;
  used_at: string | null; used_gate: string; holder_token?: string; perks: string[] | null;
};
export type OrderV = {
  number: string; status: string; buyer_name: string; phone: string; total: number; service_fee: number; refunded: number; provider: string; card_mask: string;
  created_at: string; paid_at: string | null; hold_until: string | null; match: MatchBrief; tickets: TicketV[]; face_mode: string; activate_by: string | null;
  refund_deadline: string | null; providers: string[]; transfer_allowed: boolean; no_face_entry: boolean;
};
export type TicketPage = {
  ticket: TicketV; match: MatchBrief; face_required: boolean; ready: boolean; activate_by: string | null; no_face_entry: boolean; dynamic_qr: boolean; retention_days: number;
};

export class TicketApiError extends Error {
  constructor(public status: number, message: string, public fields: Record<string, string> = {}, public code = "") { super(message); }
}

export async function tapi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const tx = useT();
  const init: RequestInit = { method, headers: { Accept: "application/json" }, cache: "no-store" };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); (init.headers as Record<string, string>)["Content-Type"] = "application/json"; }
  let res: Response;
  try { res = await fetch(`/api/v1${path}`, init); } catch { throw new TicketApiError(0, "Internet aloqasini tekshiring"); }
  if (!res.ok) {
    let e: { message?: string; fields?: Record<string, string>; code?: string } = {};
    try { e = (await res.json()).error || {}; } catch { /* not json */ }
    throw new TicketApiError(res.status, e.message || (res.status >= 500 ? tx("Server xatosi — birozdan keyin urinib ko‘ring") : tx("Xatolik")), e.fields || {}, e.code || "");
  }
  return res.json() as Promise<T>;
}

export const fmtSum = (n: number) => {
  const tx = useT();
  return (new Intl.NumberFormat("ru-RU").format(n).replace(/ /g, " ") + tx(" so‘m"));
};
export const PROVIDERS: Record<string, { name: string; tag: string; sub: string }> = lazyT({
  payme: { name: "Payme", tag: "PM", sub: "Ilova yoki karta orqali" },
  click: { name: "Click", tag: "CL", sub: "Click Evolution ilovasi" },
  uzum: { name: "Uzum Bank", tag: "UZ", sub: "Uzum ilovasi orqali" },
  test: { name: "Test to‘lov", tag: "TS", sub: "Faqat sinov serverida" },
}, ["sub", "name"] as const);

export function seatLine(t: Pick<TicketV, "section" | "row" | "seat">) {
  const tx = useT();
  if (t.row) return tx("Sektor {0}, {1}-qator, {2}-o‘rin", t.section, t.row, t.seat);
  return tx("{0}{1} · erkin o‘rindiq", t.section.includes(",") ? "Sektorlar " : "Sektor ", t.section);
}

/* ---------- map geometry (same units as the admin constructor) ---------- */
const P = 10, SEAT = 8, AISLE = 8;
const maxSeats = (s: Section) => s.rows.reduce((m, r) => Math.max(m, r.seats), 0);
export function sectionSize(s: Section) {
  const n = maxSeats(s), a = (s.aisle_after || []).filter((x) => x < n).length;
  return { w: Math.max(1, n) * P + a * AISLE - (P - SEAT), h: Math.max(1, s.rows.length) * P - (P - SEAT) };
}
/** Seat squares of a section grouped by zone: price categories (zone_seats) get their own path. */
export function seatPaths(s: Section): Record<string, string> {
  const tx = useT();
  const out: Record<string, string> = {};
  const n = maxSeats(s);
  s.rows.forEach((r, ri) => {
    for (let i = 1; i <= r.seats; i++) {
      if (r.removed?.includes(i)) continue;
      const pos = s.numbering === "rtl" ? n + 1 - i : i;
      const x = (pos - 1) * P + (s.aisle_after || []).filter((a) => a < pos).length * AISLE;
      let z = s.zone;
      for (const [k, nums] of Object.entries(r.zone_seats || {})) if (nums.includes(i)) z = k;
      out[z] = (out[z] || "") + tx("M{0} {1}h{2}v{3}h-{4}z", x, ri * P, SEAT, SEAT, SEAT);
    }
  });
  return out;
}
type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const tr = (x: number, y: number, deg: number): M => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, x, y]; };
export const sectionMatrix = (st: Stand, s: Section) => mul(tr(st.x, st.y, st.rotation), tr(s.x, s.y, s.rotation));
export function layoutBox(l: Layout) {
  let x0 = l.pitch.x, y0 = l.pitch.y, x1 = l.pitch.x + l.pitch.w, y1 = l.pitch.y + l.pitch.h;
  for (const st of l.stands) for (const s of st.sections) {
    const m = sectionMatrix(st, s), { w, h } = sectionSize(s);
    for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
      const x = m[0] * px + m[2] * py + m[4], y = m[1] * px + m[3] * py + m[5];
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return { x: x0 - 20, y: y0 - 20, w: x1 - x0 + 40, h: y1 - y0 + 40 };
}
