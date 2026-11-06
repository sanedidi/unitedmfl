// Formation geometry and lineup state for the match page.
// Mirrors backend/internal/lineup and admin/src/lib/lineup.ts.
import type { LineupMeta, LineupRow, Match, MatchEvent } from "./types";

export type Side = "home" | "away";
export type Slot = { role: string; line: number; index: number; count: number };
export type Formation = { code: string; size: number; slots: Slot[] };

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

export function parseFormation(code: string | undefined | null): Formation | null {
  if (!code) return null;
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

/** Slot position in metres (68 × 105), team attacking up. "half" keeps the team inside its own half. */
export function slotPoint(f: Formation, i: number, mode: "full" | "half") {
  const s = f.slots[i];
  const lines = Math.max(...f.slots.map((x) => x.line));
  const a = mode === "full" ? 82 : 86, b = mode === "full" ? 22 : 59;
  const y = s.line === 0 ? 100 : lines === 1 ? a : a + ((b - a) * (s.line - 1)) / (lines - 1);
  let x = (68 * (s.index + 1)) / (s.count + 1);
  if (s.count === 2 && s.line > 0 && s.line < lines) x = s.index === 0 ? 24 : 44;
  return { x, y };
}

export type PlayerEvents = {
  goals: MatchEvent[];
  ownGoals: MatchEvent[];
  missed: MatchEvent[];
  yellow: MatchEvent | null;
  red: MatchEvent | null;
  subOut: MatchEvent | null;
  subIn: MatchEvent | null;
  all: MatchEvent[];
};

export type LPlayer = LineupRow & {
  key: string;
  ev: PlayerEvents;
  /** in the current-lineup view: came off the bench */
  subbedIn?: boolean;
  /** replaced this player (for bench rows that came on) */
  replaced?: string;
};

const sameP = (r: LineupRow, id: number | null, name: string) => (id != null && r.player_id != null ? r.player_id === id : !!name && r.player_name === name);

function eventsFor(r: LineupRow, events: MatchEvent[]): PlayerEvents {
  const mine = events.filter((e) => e.side === r.side);
  const as = (types: string[]) => mine.filter((e) => types.includes(e.type) && sameP(r, e.player_id, e.player_name));
  const ev: PlayerEvents = {
    goals: as(["goal", "penalty_goal"]),
    ownGoals: as(["own_goal"]),
    missed: as(["penalty_missed"]),
    yellow: as(["yellow"])[0] || null,
    red: as(["red", "second_yellow"])[0] || null,
    subOut: mine.find((e) => e.type === "sub" && sameP(r, e.related_player_id, e.related_player_name)) || null,
    subIn: mine.find((e) => e.type === "sub" && sameP(r, e.player_id, e.player_name)) || null,
    all: [],
  };
  ev.all = mine.filter((e) => e.type !== "formation" && (sameP(r, e.player_id, e.player_name) || (e.type === "sub" && sameP(r, e.related_player_id, e.related_player_name))));
  return ev;
}

export type TeamLineup = {
  side: Side;
  meta: LineupMeta | null;
  formation: Formation | null;
  /** formation code shown for the chosen view (current view follows in-match changes) */
  code: string;
  starters: LPlayer[];
  bench: LPlayer[];
  /** on the pitch for the chosen view, slot = position in `formation` */
  onPitch: LPlayer[];
  subs: number;
};

const chrono = (events: MatchEvent[]) => [...events].sort((a, b) => a.minute - b.minute || a.extra_minute - b.extra_minute || a.id - b.id);

export function teamLineup(side: Side, rows: LineupRow[], metaList: LineupMeta[] | undefined, events: MatchEvent[], view: "start" | "current"): TeamLineup {
  const meta = metaList?.find((m) => m.side === side) || null;
  const list = rows.filter((r) => r.side === side);
  const evs = chrono(events);
  const mk = (r: LineupRow, i: number): LPlayer => ({ ...r, key: `${side}-${r.player_id ?? r.player_name}-${i}`, ev: eventsFor(r, evs) });
  const all = list.map(mk);
  const starters = all.filter((p) => p.is_starter);
  const bench = all.filter((p) => !p.is_starter);
  for (const b of bench) if (b.ev.subIn) b.replaced = b.ev.subIn.related_player_name;
  const subs = evs.filter((e) => e.side === side && e.type === "sub").length;

  let code = meta?.formation || "";
  let onPitch = starters.map((p) => ({ ...p }));
  if (view === "current") {
    const benchLeft = bench.map((p) => ({ ...p }));
    for (const e of evs) {
      if (e.side !== side) continue;
      if (e.type === "sub") {
        const oi = onPitch.findIndex((p) => sameP(p, e.related_player_id, e.related_player_name));
        if (oi < 0) continue;
        const out = onPitch[oi];
        const bi = benchLeft.findIndex((p) => sameP(p, e.player_id, e.player_name));
        const inn: LPlayer = bi >= 0 ? benchLeft.splice(bi, 1)[0] : { ...out, key: `${side}-in-${e.id}`, player_id: e.player_id, player_name: e.player_name, number: null, photo_url: "", is_captain: false, ev: eventsFor({ ...out, player_id: e.player_id, player_name: e.player_name }, evs) };
        onPitch[oi] = { ...inn, slot: out.slot, role: out.role, is_starter: true, subbedIn: true };
      } else if (e.type === "formation" && e.note && parseFormation(e.note)) {
        code = e.note;
        const map = e.payload?.slots || {};
        const nf = parseFormation(code)!;
        for (const p of onPitch) {
          if (p.player_id != null && map[String(p.player_id)] != null) p.slot = map[String(p.player_id)];
          if (p.slot != null && nf.slots[p.slot]) p.role = nf.slots[p.slot].role;
        }
      }
    }
  }
  const formation = parseFormation(code);
  return { side, meta, formation, code, starters, bench, onPitch, subs };
}

/** Minutes a player spent on the pitch, or null before kickoff. */
export function minutesPlayed(p: LPlayer, m: Match, liveMinute: number): number | null {
  if (m.status === "scheduled" || m.status === "cancelled") return null;
  const end = m.status === "finished" ? (m.home_et != null ? 120 : 90) : liveMinute;
  if (!p.is_starter && !p.ev.subIn) return 0;
  const from = p.ev.subIn ? p.ev.subIn.minute : 0;
  const to = p.ev.subOut ? p.ev.subOut.minute : p.ev.red ? p.ev.red.minute : end;
  return Math.max(0, Math.min(to, end) - from);
}

export const surname = (n: string) => n.trim().split(/\s+/).pop() || n;
export const roleText = (p: LineupRow, pos: Record<string, string>) => (p.role && ROLE_LABEL[p.role]) || pos[p.position] || p.position || "";
