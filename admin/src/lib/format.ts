import { lang, tx } from "@/lib/i18n";
export const TZ = "Asia/Tashkent";
const MONTHS = lang === "ru" ? ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"] : ["yan", "fev", "mar", "apr", "may", "iyun", "iyul", "avg", "sen", "okt", "noy", "dek"];

function parts(iso: string) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (t: string) => f.find((p) => p.type === t)?.value || "";
  return { y: g("year"), m: g("month"), d: g("day"), hh: g("hour"), mm: g("minute") };
}
export const fmtDate = (iso?: string | null) => (iso ? (() => { const p = parts(iso); return `${+p.d} ${MONTHS[+p.m - 1]} ${p.y}`; })() : "—");
export const fmtDateTime = (iso?: string | null) => (iso ? (() => { const p = parts(iso); return `${p.d}.${p.m}.${p.y} ${p.hh}:${p.mm}`; })() : "—");
export const fmtShort = (iso?: string | null) => (iso ? (() => { const p = parts(iso); return `${p.d}.${p.m} · ${p.hh}:${p.mm}`; })() : "—");

/** ISO → value for <input type="datetime-local"> in Tashkent time. */
export function toLocalInput(iso?: string | null) {
  if (!iso) return "";
  const p = parts(iso);
  return `${p.y}-${p.m}-${p.d}T${p.hh}:${p.mm}`;
}
/** <input type="datetime-local"> value (Tashkent, UTC+5, no DST) → ISO string. */
export function fromLocalInput(v: string) {
  return v ? `${v}:00+05:00` : null;
}

export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return tx("hozirgina");
  if (s < 3600) return tx("{0} daqiqa oldin", Math.floor(s / 60));
  if (s < 86400) return tx("{0} soat oldin", Math.floor(s / 3600));
  if (s < 86400 * 7) return tx("{0} kun oldin", Math.floor(s / 86400));
  return fmtDate(iso);
}

export const MATCH_STATUS: Record<string, { label: string; tone: string }> = {
  scheduled: { label: tx("Rejalashtirilgan"), tone: "info" },
  live: { label: tx("Jonli"), tone: "live" },
  halftime: { label: tx("Tanaffus"), tone: "live" },
  finished: { label: tx("Yakunlangan"), tone: "muted" },
  postponed: { label: tx("Qoldirilgan"), tone: "warn" },
  cancelled: { label: tx("Bekor qilingan"), tone: "danger" },
};

export const EVENT_LABEL: Record<string, string> = {
  goal: tx("Gol"), own_goal: tx("Avtogol"), penalty_goal: tx("Penalti (gol)"), penalty_missed: tx("Penalti (o‘tmadi)"),
  yellow: tx("Sariq"), second_yellow: tx("Ikkinchi sariq"), red: tx("Qizil"), sub: tx("Almashtirish"),
  shootout_scored: tx("Seriya: gol"), shootout_missed: tx("Seriya: o‘tmadi"), note: tx("Izoh"), period: tx("Davr"), formation: tx("Sxema"),
};

export const POSITIONS: Record<string, string> = { GK: tx("Darvozabon"), DF: tx("Himoyachi"), MF: tx("Yarim himoyachi"), FW: tx("Hujumchi") };
export const ROLE_LABEL: Record<string, string> = { admin: tx("Administrator"), editor: tx("Muharrir"), operator: tx("Match operatori"), shop: tx("Do‘kon menejeri"), controller: tx("Nazoratchi") };

export function initials(name: string, short?: string) {
  if (short) return short.slice(0, 3).toUpperCase();
  const w = name.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  return w.length === 1 ? w[0].slice(0, 2).toUpperCase() : (w[0][0] + w[1][0]).toUpperCase();
}
const PALETTE = ["#E5383B", "#8E44D9", "#F59E0B", "#2F80ED", "#91DA27", "#B03A8C", "#6B7380", "#16A34A", "#0EA5E9", "#F97316", "#CC3366", "#1F2A6B", "#14B8A6", "#EAB308", "#A855F7", "#EF4444"];
export const teamColor = (t: { id: number; colors?: string[] } | null | undefined) => (!t ? "#A9B0BC" : t.colors?.[0] || PALETTE[(t.id - 1 + PALETTE.length) % PALETTE.length]);

export function slugify(s: string) {
  const map: Record<string, string> = { "‘": "", "’": "", "ʻ": "", "ʼ": "", "'": "", "`": "" };
  return s
    .toLowerCase()
    .replace(/[‘’ʻʼ'`]/g, (c) => map[c] ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/** Shirt number as typed → as printed: «z 10» → «Z10». Letters and digits only, at most 4 (same rule as the backend). */
export const jerseyInput = (s: string) => s.replace(/[^\p{L}0-9]/gu, "").toUpperCase().slice(0, 4);
const jerseyOrd = (n: string | null | undefined) => { const d = (n ?? "").replace(/\D/g, ""); return d ? Number(d) : Infinity; };
/** Squad order of shirt numbers: 2 < 10 < Z10; no number goes last. */
export const jerseyCmp = (a: string | null | undefined, b: string | null | undefined) => {
  const x = jerseyOrd(a), y = jerseyOrd(b);
  if (x !== y) return x < y ? -1 : 1;
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
};

export const fmtUZS = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("ru-RU").format(n).replace(/ /g, " ") + tx(" so‘m"));
export const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * Random id. crypto.randomUUID exists only in secure contexts (HTTPS or
 * localhost); the admin is also opened over plain HTTP by IP, where it is
 * undefined — fall back to getRandomValues, which works everywhere.
 */
export function uid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
