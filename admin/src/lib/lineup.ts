// Lineup helpers shared by the match editor and the Live console.
// Mirrors backend/internal/lineup (formations, roles, validation rules).

export type Slot = { role: string; line: number; index: number; count: number };
export type Formation = { code: string; size: number; slots: Slot[] };
export type LPlayer = {
  player_id: number | null;
  player_name: string;
  number: number | null;
  position: string;
  role: string;
  slot: number | null;
  is_starter: boolean;
  is_captain: boolean;
};
export type Check = { level: "error" | "warning"; code: string; text: string };
export type LineupMeta = {
  formation: string;
  status: "draft" | "published";
  source: string;
  coach: string;
  assistant: string;
  version: number;
  published_at: string | null;
  updated_at: string;
};
export type SideData = { meta: LineupMeta; players: LPlayer[]; checks: Check[]; suspended: number[] };
export type LineupsResponse = { home: SideData; away: SideData; bench_max: number };
export type Side = "home" | "away";

export const ROLE_LABEL: Record<string, string> = {
  GK: "Darvozabon", LB: "Chap himoyachi", CB: "Markaziy himoyachi", RB: "O‘ng himoyachi", LWB: "Chap qanot himoyachisi", RWB: "O‘ng qanot himoyachisi",
  DM: "Tayanch yarim himoyachi", CM: "Markaziy yarim himoyachi", AM: "Hujumkor yarim himoyachi", LM: "Chap yarim himoyachi", RM: "O‘ng yarim himoyachi",
  LW: "Chap qanot hujumchisi", RW: "O‘ng qanot hujumchisi", ST: "Hujumchi", MF: "Yarim himoyachi",
};

function lineRoles(li: number, lines: number, n: number): string[] {
  const rep = (r: string) => Array(n).fill(r);
  if (li === 0) return ({ 1: ["CB"], 2: ["CB", "CB"], 3: ["CB", "CB", "CB"], 4: ["LB", "CB", "CB", "RB"], 5: ["LWB", "CB", "CB", "CB", "RWB"] } as Record<number, string[]>)[n] || rep("DF");
  if (li === lines - 1) return ({ 1: ["ST"], 2: ["ST", "ST"], 3: ["LW", "ST", "RW"], 4: ["LW", "ST", "ST", "RW"] } as Record<number, string[]>)[n] || rep("FW");
  const mids = lines - 2, pos = li - 1;
  const base = mids > 1 && pos === 0 ? "DM" : mids > 1 && pos === mids - 1 ? "AM" : "CM";
  if (n === 3 && base === "AM") return ["LW", "AM", "RW"];
  if (n === 4) return ["LM", base, base, "RM"];
  if (n === 5) return ["LM", base, base, base, "RM"];
  return rep(base);
}

/** Parses "4-2-3-1"; returns null when the code is invalid. */
export function parseFormation(code: string): Formation | null {
  const parts = code.trim().split("-");
  if (parts.length < 2 || parts.length > 5) return null;
  const lines = parts.map((p) => Number(p));
  if (lines.some((n) => !Number.isInteger(n) || n < 1 || n > 6)) return null;
  const total = lines.reduce((a, b) => a + b, 0);
  if (total < 4 || total > 10) return null;
  const slots: Slot[] = [{ role: "GK", line: 0, index: 0, count: 1 }];
  lines.forEach((n, li) => lineRoles(li, lines.length, n).forEach((role, i) => slots.push({ role, line: li + 1, index: i, count: n })));
  return { code: code.trim(), size: total + 1, slots };
}

/**
 * Slot position in metres on a 68×105 pitch, team attacking up (own goal at y = 105).
 * "full" spreads one team over the whole pitch; "half" keeps it in its own half.
 */
export function slotPoint(f: Formation, i: number, mode: "full" | "half" = "full") {
  const s = f.slots[i];
  const lines = Math.max(...f.slots.map((x) => x.line));
  const a = mode === "full" ? 82 : 86, b = mode === "full" ? 22 : 59;
  const y = s.line === 0 ? 100 : lines === 1 ? a : a + ((b - a) * (s.line - 1)) / (lines - 1);
  let x = (68 * (s.index + 1)) / (s.count + 1);
  if (s.count === 2 && s.line > 0 && s.line < lines) x = s.index === 0 ? 24 : 44;
  return { x, y };
}

const category = (f: Formation, i: number) => {
  const s = f.slots[i];
  const lines = Math.max(...f.slots.map((x) => x.line));
  return s.line === 0 ? 0 : s.line === 1 ? 1 : s.line === lines ? 3 : 2;
};
const posCategory = (p: LPlayer) => ({ GK: 0, DF: 1, MF: 2, FW: 3 } as Record<string, number>)[p.position] ?? 2;

/** Places starters into free slots by squad position (GK → GK, DF → defence, …). */
export function autoPlace(f: Formation, players: LPlayer[]): LPlayer[] {
  const out = players.map((p) => ({ ...p }));
  const taken = new Set(out.filter((p) => p.is_starter && p.slot != null && p.slot < f.slots.length).map((p) => p.slot!));
  const free = f.slots.map((_, i) => i).filter((i) => !taken.has(i));
  const waiting = out.filter((p) => p.is_starter && (p.slot == null || p.slot >= f.slots.length));
  for (const p of [...waiting].sort((a, b) => posCategory(a) - posCategory(b))) {
    let k = free.findIndex((i) => category(f, i) === posCategory(p));
    if (k < 0) k = free.findIndex((i) => category(f, i) !== 0 || posCategory(p) === 0);
    if (k < 0) k = 0;
    if (!free.length) break;
    const slot = free.splice(k, 1)[0];
    p.slot = slot;
    p.role = f.slots[slot].role;
  }
  return out;
}

/** Moves starters to a new formation, keeping each one in the nearest slot of the same line type. */
export function reassign(from: Formation | null, to: Formation, players: LPlayer[]): LPlayer[] {
  const out = players.map((p) => ({ ...p }));
  const starters = out.filter((p) => p.is_starter);
  const free = new Set(to.slots.map((_, i) => i));
  const pos = (p: LPlayer) => {
    if (from && p.slot != null && p.slot < from.slots.length) return { cat: category(from, p.slot), x: slotPoint(from, p.slot).x };
    return { cat: posCategory(p), x: 34 };
  };
  const order = [...starters].sort((a, b) => pos(a).cat - pos(b).cat || pos(a).x - pos(b).x);
  const pending: LPlayer[] = [];
  for (const p of order) {
    const { cat, x } = pos(p);
    const cands = [...free].filter((i) => category(to, i) === cat).sort((i, j) => Math.abs(slotPoint(to, i).x - x) - Math.abs(slotPoint(to, j).x - x));
    if (cands.length) {
      p.slot = cands[0];
      p.role = to.slots[cands[0]].role;
      free.delete(cands[0]);
    } else pending.push(p);
  }
  for (const p of pending) {
    const near = [...free].filter((i) => category(to, i) !== 0 || pos(p).cat === 0).sort((i, j) => Math.abs(category(to, i) - pos(p).cat) - Math.abs(category(to, j) - pos(p).cat))[0];
    if (near == null) { p.slot = null; continue; }
    p.slot = near;
    p.role = to.slots[near].role;
    free.delete(near);
  }
  return out;
}

const label = (p: LPlayer) => (p.number != null ? `${p.number} · ${p.player_name}` : p.player_name);
const surname = (n: string) => n.trim().split(/\s+/).pop() || n;

/** Client-side mirror of lineup.Validate (the server re-checks on save and publish). */
export function validate(formation: string, players: LPlayer[], opts: { benchMax: number; suspended?: number[]; coach?: string }): Check[] {
  const cs: Check[] = [];
  const add = (level: Check["level"], code: string, text: string) => cs.push({ level, code, text });
  if (!players.length) return [{ level: "error", code: "empty", text: "Tarkib kiritilmagan" }];
  const starters = players.filter((p) => p.is_starter), bench = players.filter((p) => !p.is_starter);
  let size = 0;
  if (formation) {
    const f = parseFormation(formation);
    if (!f) add("error", "formation", "Sxema noto‘g‘ri");
    else {
      size = f.size;
      const used = new Set<number>();
      for (const p of starters) {
        if (p.slot == null) { add("error", "unplaced", `${label(p)} maydonga joylashtirilmagan`); continue; }
        if (used.has(p.slot)) add("error", "slot_taken", `${label(p)} o‘rni band`);
        used.add(p.slot);
      }
    }
  }
  if (size && starters.length !== size) add("error", "count", `Maydonda ${starters.length} o‘yinchi — ${size} kerak`);
  else if (!size && (starters.length < 5 || starters.length > 11)) add("error", "count", `Asosiy tarkibda ${starters.length} o‘yinchi`);
  const gk = starters.filter((p) => p.role === "GK" || (!p.role && p.position === "GK")).length;
  if (gk === 0) add("error", "gk", "Darvozabon belgilanmagan");
  else if (gk > 1) add("error", "gk", "Maydonda bittadan ortiq darvozabon");
  const nums = new Map<number, string[]>();
  const ids = new Set<number>();
  for (const p of players) {
    if (p.number != null) nums.set(p.number, [...(nums.get(p.number) || []), surname(p.player_name)]);
    if (p.player_id != null) {
      if (ids.has(p.player_id)) add("error", "duplicate", `${label(p)} ikki marta kiritilgan`);
      ids.add(p.player_id);
      if (opts.suspended?.includes(p.player_id)) add("warning", "suspended", `${label(p)} diskvalifikatsiyada bo‘lishi mumkin`);
    }
  }
  for (const [n, who] of nums) if (who.length > 1) add("error", "number", `Raqam ${n} ikki marta: ${who.join(" va ")}`);
  const caps = starters.filter((p) => p.is_captain).length;
  if (caps === 0) add("warning", "captain", "Kapitan belgilanmagan");
  else if (caps > 1) add("error", "captain", "Kapitan faqat bitta bo‘ladi");
  if (opts.benchMax > 0 && bench.length > opts.benchMax) add("error", "bench", `Zaxirada ${bench.length} ta — ko‘pi bilan ${opts.benchMax}`);
  else if (!bench.length) add("warning", "bench", "Zaxira kiritilmagan");
  if (!formation) add("warning", "no_formation", "Sxema tanlanmagan — saytda ro‘yxat ko‘rinishida chiqadi");
  if (opts.coach !== undefined && !opts.coach.trim()) add("warning", "coach", "Bosh murabbiy ko‘rsatilmagan");
  return cs;
}

export const hasErrors = (cs: Check[]) => cs.some((c) => c.level === "error");
export const surnameOf = surname;

/** Current lineup after substitutions, sendings-off and formation changes (events in match order). */
export function currentLineup(
  formation: string,
  players: LPlayer[],
  events: { type: string; side: Side; player_id: number | null; player_name: string; related_player_id: number | null; related_player_name: string; note: string; payload?: { slots?: Record<string, number> } | null }[],
  side: Side,
) {
  let f = formation;
  const on = players.filter((p) => p.is_starter).map((p) => ({ ...p, sentOff: false, subbedIn: false }));
  const bench = players.filter((p) => !p.is_starter).map((p) => ({ ...p, sentOff: false, subbedIn: false }));
  const same = (p: LPlayer, id: number | null, name: string) => (id != null ? p.player_id === id : !!name && p.player_name === name);
  for (const e of events) {
    if (e.side !== side) continue;
    if (e.type === "sub") {
      const outIdx = on.findIndex((p) => same(p, e.related_player_id, e.related_player_name));
      const inIdx = bench.findIndex((p) => same(p, e.player_id, e.player_name));
      if (outIdx < 0) continue;
      const out = on[outIdx];
      const incoming = inIdx >= 0 ? bench.splice(inIdx, 1)[0] : { ...out, player_id: e.player_id, player_name: e.player_name, number: null, is_captain: false };
      on[outIdx] = { ...incoming, slot: out.slot, role: out.role, is_starter: true, subbedIn: true, sentOff: false };
    } else if (e.type === "red" || e.type === "second_yellow") {
      const p = on.find((x) => same(x, e.player_id, e.player_name));
      if (p) p.sentOff = true;
    } else if (e.type === "formation" && e.note) {
      f = e.note;
      const map = e.payload?.slots || {};
      for (const p of on) if (p.player_id != null && map[String(p.player_id)] != null) p.slot = map[String(p.player_id)];
      const nf = parseFormation(f);
      if (nf) for (const p of on) if (p.slot != null && nf.slots[p.slot]) p.role = nf.slots[p.slot].role;
    }
  }
  return { formation: f, on, bench };
}
