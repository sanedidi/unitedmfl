import type { Match } from "./types";

import { lazyT, useLang, useT } from "@/lib/i18n";
export const TZ = "Asia/Tashkent";
const MONTHS_UZ = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const WEEKDAYS_UZ = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];
// Russian: month in the genitive case ("19 июня 2026")
const MONTHS_RU = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS_RU = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const month = (i: number) => (useLang() === "ru" ? MONTHS_RU : MONTHS_UZ)[i];
const weekday = (i: number) => (useLang() === "ru" ? WEEKDAYS_RU : WEEKDAYS_UZ)[i];

function parts(iso: string) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => f.find((p) => p.type === t)?.value || "";
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { y: +get("year"), m: +get("month"), d: +get("day"), hh: get("hour"), mm: get("minute"), wd };
}

/** "19 iyun 2026" */
export function fmtDate(iso: string | null | undefined, withYear = true) {
  if (!iso) return "";
  const p = parts(iso);
  return `${p.d} ${month(p.m - 1)}${withYear ? ` ${p.y}` : ""}`;
}
/** "18:30" */
export function fmtTime(iso: string | null | undefined) {
  if (!iso) return "";
  const p = parts(iso);
  return `${p.hh}:${p.mm}`;
}
export function fmtWeekday(iso: string) {
  return weekday(parts(iso).wd);
}
/** Date-only string from the API ("2026-07-04") → "4 iyul 2026" */
export function fmtPlainDate(s: string | null | undefined) {
  if (!s) return "";
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return `${d} ${month(m - 1)} ${y}`;
}
export function dayKey(iso: string) {
  const p = parts(iso);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
export function isToday(iso: string) {
  return dayKey(iso) === dayKey(new Date().toISOString());
}

export function fmtUZS(n: number) {
  const tx = useT();
  return new Intl.NumberFormat("ru-RU").format(n).replace(/ /g, " ") + tx(" so‘m");
}

export const isLive = (m: Pick<Match, "status">) => m.status === "live" || m.status === "halftime";
export const isFinished = (m: Pick<Match, "status">) => m.status === "finished";

export const STATUS_LABEL: Record<string, string> = lazyT({
  scheduled: "Rejalashtirilgan",
  live: "Jonli",
  halftime: "Tanaffus",
  finished: "Yakunlandi",
  postponed: "Qoldirildi",
  cancelled: "Bekor qilindi",
});

export const POSITION_LABEL: Record<string, string> = lazyT({
  GK: "Darvozabon",
  DF: "Himoyachi",
  MF: "Yarim himoyachi",
  FW: "Hujumchi",
});

/** Current match minute from clock fields; serverOffsetMs corrects client clock skew. */
export function matchMinute(m: Pick<Match, "period" | "clock_started_at" | "clock_offset_sec">, now = Date.now(), serverOffsetMs = 0) {
  if (m.period === "HT") return "TAN";
  if (m.period === "PEN") return "PEN";
  if (m.period === "FT") return "FT";
  if (!m.clock_started_at) return "";
  const elapsed = Math.max(0, (now + serverOffsetMs - new Date(m.clock_started_at).getTime()) / 1000);
  const total = m.clock_offset_sec + elapsed;
  const minute = Math.floor(total / 60) + 1;
  const cap = m.period === "1H" ? 45 : m.period === "2H" ? 90 : 120;
  return minute > cap ? `${cap}+${minute - cap}'` : `${minute}'`;
}

export function scoreText(m: Match) {
  if (m.home_score == null || m.away_score == null) return null;
  return `${m.home_score} : ${m.away_score}`;
}

export function initials(name: string, short?: string) {
  if (short) return short.slice(0, 3).toUpperCase();
  const w = name.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean);
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[1][0]).toUpperCase();
}

const PALETTE = ["#E5383B", "#8E44D9", "#F59E0B", "#2F80ED", "#91DA27", "#B03A8C", "#6B7380", "#16A34A", "#0EA5E9", "#F97316", "#CC3366", "#1F2A6B", "#14B8A6", "#EAB308", "#A855F7", "#EF4444"];
export function teamColor(t: { id: number; colors?: string[] } | null | undefined) {
  if (!t) return "#333A46";
  if (t.colors && t.colors[0]) return t.colors[0];
  return PALETTE[(t.id - 1 + PALETTE.length) % PALETTE.length];
}

/** An uploaded video file (played with our own player, not YouTube). */
export function isFileVideo(v: { url: string; source?: string }) {
  return v.source === "file" || /\/uploads\/videos\/[0-9a-f]{32}\.(mp4|mov|webm)$/.test(v.url);
}

export function youtubeId(url: string, id?: string) {
  if (id) return id;
  const m = url.match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
  return m ? m[1] : "";
}
