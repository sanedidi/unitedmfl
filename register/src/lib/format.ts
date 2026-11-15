import type { Player } from "./api";

const TZ = "Asia/Tashkent";
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];

function parts(iso: string) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (t: string) => f.find((p) => p.type === t)?.value || "";
  return { y: g("year"), m: g("month"), d: g("day"), hh: g("hour"), mm: g("minute") };
}

/** «30-noyabr, 23:59» */
export function fmtDeadline(iso?: string | null) {
  if (!iso) return "";
  const p = parts(iso);
  return `${+p.d}-${MONTHS[+p.m - 1]}, ${p.hh}:${p.mm}`;
}
/** «15-noyabr, 13:12» */
export const fmtDateTime = fmtDeadline;
/** 2001-07-20 → 20.07.2001 */
export function fmtBirth(d?: string) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return d || "—";
  const [y, m, dd] = d.split("-");
  return `${dd}.${m}.${y}`;
}

export const KIT_SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];
export const REP_ROLES: Record<string, string> = { captain: "Kapitan", manager: "Menejer", coach: "Murabbiy", other: "Boshqa" };
export const STAFF_ROLES: Record<string, string> = {
  head_coach: "Bosh murabbiy", assistant: "Murabbiy yordamchisi", gk_coach: "Darvozabonlar murabbiyi",
  fitness: "Jismoniy tayyorgarlik", doctor: "Shifokor", manager: "Menejer", other: "Boshqa",
};
export const ROLE_LABEL: Record<string, string> = { player: "O‘yinchi", goalkeeper: "Darvozabon", media: "Media shaxs" };

export const fullName = (p: { first_name: string; last_name: string }) => `${p.first_name} ${p.last_name}`.trim();

export function initials(name: string) {
  const w = name.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  return w.length === 1 ? w[0].slice(0, 2).toUpperCase() : (w[0][0] + w[1][0]).toUpperCase();
}

export function sizeSummary(people: { kit_size: string }[]) {
  const m = new Map<string, number>();
  for (const p of people) if (p.kit_size) m.set(p.kit_size, (m.get(p.kit_size) || 0) + 1);
  return KIT_SIZES.filter((s) => m.has(s)).map((s) => ({ size: s, n: m.get(s)! }));
}

export const emptyPlayer = (role: Player["role"] = "player"): Player => ({
  first_name: "", last_name: "", jersey_name: "", birth_date: "", number: null, kit_size: "", workplace: "", role, photo_url: "", medical: null,
});
