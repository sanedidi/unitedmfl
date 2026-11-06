export const TZ = "Asia/Tashkent";
const MONTHS = ["yan", "fev", "mar", "apr", "may", "iyun", "iyul", "avg", "sen", "okt", "noy", "dek"];

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
  if (s < 60) return "hozirgina";
  if (s < 3600) return `${Math.floor(s / 60)} daqiqa oldin`;
  if (s < 86400) return `${Math.floor(s / 3600)} soat oldin`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} kun oldin`;
  return fmtDate(iso);
}

export const MATCH_STATUS: Record<string, { label: string; tone: string }> = {
  scheduled: { label: "Rejalashtirilgan", tone: "info" },
  live: { label: "Jonli", tone: "live" },
  halftime: { label: "Tanaffus", tone: "live" },
  finished: { label: "Yakunlangan", tone: "muted" },
  postponed: { label: "Qoldirilgan", tone: "warn" },
  cancelled: { label: "Bekor qilingan", tone: "danger" },
};

export const EVENT_LABEL: Record<string, string> = {
  goal: "Gol", own_goal: "Avtogol", penalty_goal: "Penalti (gol)", penalty_missed: "Penalti (o‘tmadi)",
  yellow: "Sariq", second_yellow: "Ikkinchi sariq", red: "Qizil", sub: "Almashtirish",
  shootout_scored: "Seriya: gol", shootout_missed: "Seriya: o‘tmadi", note: "Izoh", period: "Davr", formation: "Sxema",
};

export const POSITIONS: Record<string, string> = { GK: "Darvozabon", DF: "Himoyachi", MF: "Yarim himoyachi", FW: "Hujumchi" };
export const ROLE_LABEL: Record<string, string> = { admin: "Administrator", editor: "Muharrir", operator: "Match operatori", shop: "Do‘kon menejeri" };

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

export const fmtUZS = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("ru-RU").format(n).replace(/ /g, " ") + " so‘m");
export const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
