import type { DragEvent, ReactNode } from "react";
import { slotPoint, surnameOf, type Formation, type LPlayer } from "@/lib/lineup";

// Pitch geometry in metres (68 × 105 plus a 3 m margin), team attacking up.
const M = 3, W = 74, H = 111;
const r = (n: number) => +n.toFixed(2);
function lines() {
  const rect = (x1: number, y1: number, x2: number, y2: number) => `M${r(M + x1)} ${r(M + y1)}H${r(M + x2)}V${r(M + y2)}H${r(M + x1)}Z`;
  const dx = Math.sqrt(9.15 ** 2 - 5.5 ** 2);
  return [
    rect(0, 0, 68, 105), `M${M} ${M + 52.5}H${M + 68}`,
    rect(13.84, 0, 54.16, 16.5), rect(13.84, 88.5, 54.16, 105), rect(24.84, 0, 43.16, 5.5), rect(24.84, 99.5, 43.16, 105),
    `M${r(M + 34 - dx)} ${M + 16.5}A9.15 9.15 0 0 0 ${r(M + 34 + dx)} ${M + 16.5}`, `M${r(M + 34 - dx)} ${M + 88.5}A9.15 9.15 0 0 1 ${r(M + 34 + dx)} ${M + 88.5}`,
    rect(30.34, -1.8, 37.66, 0), rect(30.34, 105, 37.66, 106.8),
  ].join("");
}
const LINES = lines();

export function PitchSurface({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <div className={`pitch ${className}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className="pitch-lines">
        <path d={LINES} />
        <circle cx={M + 34} cy={M + 52.5} r={9.15} />
        <circle cx={M + 34} cy={M + 52.5} r={0.35} className="spot" />
        <circle cx={M + 34} cy={M + 11} r={0.35} className="spot" />
        <circle cx={M + 34} cy={M + 94} r={0.35} className="spot" />
      </svg>
      {children}
    </div>
  );
}

export const pos = (x: number, y: number) => ({ left: `${((M + x) / W) * 100}%`, top: `${((M + y) / H) * 100}%` });

type SlotProps = {
  formation: Formation;
  players: LPlayer[];
  selected?: number | null;
  dropSlot?: number | null;
  flagged?: Set<number>;
  compact?: boolean;
  dim?: (p: LPlayer) => boolean;
  badge?: (p: LPlayer) => ReactNode;
  onSlot?: (slot: number) => void;
  onDragStartSlot?: (slot: number, e: DragEvent) => void;
  onDragOverSlot?: (slot: number | null) => void;
  onDropSlot?: (slot: number, e: DragEvent) => void;
};

/** Editable pitch: one team, every formation slot either filled or empty. */
export function LineupPitch({ formation, players, selected, dropSlot, flagged, compact, dim, badge, onSlot, onDragStartSlot, onDragOverSlot, onDropSlot }: SlotProps) {
  const bySlot = new Map<number, LPlayer>();
  for (const p of players) if (p.is_starter && p.slot != null) bySlot.set(p.slot, p);
  return (
    <PitchSurface className={compact ? "compact" : ""}>
      {formation.slots.map((s, i) => {
        const p = bySlot.get(i);
        const pt = slotPoint(formation, i, "full");
        const cls = ["slot", p ? "filled" : "empty", selected === i ? "selected" : "", dropSlot === i ? "drop" : "", flagged?.has(i) ? "error" : "", p && dim?.(p) ? "dim" : ""].filter(Boolean).join(" ");
        return (
          <button
            key={i}
            type="button"
            className={cls}
            style={pos(pt.x, pt.y)}
            draggable={!!p && !!onDragStartSlot}
            onClick={() => onSlot?.(i)}
            onDragStart={(e) => onDragStartSlot?.(i, e)}
            onDragOver={(e) => { if (onDropSlot) { e.preventDefault(); onDragOverSlot?.(i); } }}
            onDragLeave={() => onDragOverSlot?.(null)}
            onDrop={(e) => { e.preventDefault(); onDropSlot?.(i, e); }}
            aria-label={p ? `${s.role}: ${p.number ?? ""} ${p.player_name}` : `${s.role} — bo‘sh o‘rin`}
          >
            <span className="disc">
              {p ? p.number ?? "–" : s.role}
              {p?.is_captain && <i className="cap">C</i>}
              {p && badge?.(p)}
            </span>
            {!compact && <span className="name">{p ? surnameOf(p.player_name) : dropSlot === i ? "Qo‘yish" : "Bo‘sh"}</span>}
            {compact && <span className="role">{s.role}</span>}
          </button>
        );
      })}
    </PitchSurface>
  );
}
