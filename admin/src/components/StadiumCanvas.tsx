import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AISLE, P, SEAT, layoutBox, seatX, sectionSize, type Layout, type Section, type Stand } from "@/lib/tickets";

/** SVG renderer of a stadium layout: view-only thumbnails and the editor canvas (pan, zoom, drag). */

export type Sel = { stand?: string; section?: string } | null;
type VB = { x: number; y: number; w: number; h: number };

type Props = {
  layout: Layout;
  sel?: Sel;
  colorBy?: "structure" | "zone";
  interactive?: boolean;
  height?: number | string;
  diff?: Record<string, string>; // section key → note (versions)
  sold?: Set<string>; // section keys with sold tickets
  ghost?: Stand | null; // stand being placed (follows the pointer)
  onSelect?: (s: Sel) => void;
  onMoveStand?: (key: string, x: number, y: number) => void;
  onMoveSection?: (stand: string, key: string, x: number, y: number) => void;
  onOpenSection?: (stand: string, key: string) => void;
  onPlace?: (x: number, y: number) => void;
  fitKey?: unknown; // change to re-fit the view
  zoomRef?: React.MutableRefObject<{ zoom: (f: number) => void; fit: () => void; pct: () => number } | null>;
  children?: ReactNode;
};

type M = [number, number, number, number, number, number]; // a b c d e f
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const tr = (x: number, y: number, deg: number): M => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, x, y]; };
const apply = (m: M, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

export function seatPaths(s: Section) {
  let normal = "", blocked = "";
  s.rows.forEach((r, ri) => {
    for (let n = 1; n <= r.seats; n++) {
      if (r.removed.includes(n)) continue;
      const d = `M${seatX(s, n)} ${ri * P}h${SEAT}v${SEAT}h-${SEAT}z`;
      if (r.blocked.includes(n)) blocked += d; else normal += d;
    }
  });
  return { normal, blocked };
}

export function StadiumCanvas(p: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const box = useMemo(() => layoutBox(p.layout), [p.fitKey ?? p.layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const [vb, setVb] = useState<VB>(box);
  const base = useRef<VB>(box);
  useEffect(() => { setVb(box); base.current = box; }, [box]);
  const drag = useRef<null | { kind: "pan" | "stand" | "section"; sx: number; sy: number; ox: number; oy: number; stand?: string; sec?: string; inv?: M; moved: boolean }>(null);
  const [ghostAt, setGhostAt] = useState<{ x: number; y: number } | null>(null);
  const zoneColor = useMemo(() => Object.fromEntries(p.layout.zones.map((z) => [z.key, z.color || "#9AA1AB"])), [p.layout.zones]);

  const toWorld = (cx: number, cy: number) => {
    const el = svg.current; if (!el) return { x: 0, y: 0 };
    const pt = el.createSVGPoint(); pt.x = cx; pt.y = cy;
    const m = el.getScreenCTM(); if (!m) return { x: 0, y: 0 };
    const w = pt.matrixTransform(m.inverse()); return { x: w.x, y: w.y };
  };
  const zoom = (f: number, at?: { x: number; y: number }) => setVb((v) => {
    const c = at || { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    const w = Math.min(Math.max(v.w * f, 60), base.current.w * 6), h = (w * v.h) / v.w;
    return { x: c.x - ((c.x - v.x) * w) / v.w, y: c.y - ((c.y - v.y) * h) / v.h, w, h };
  });
  if (p.zoomRef) p.zoomRef.current = { zoom: (f) => zoom(f), fit: () => setVb(base.current), pct: () => Math.round((base.current.w / vb.w) * 100) };

  useEffect(() => {
    const el = svg.current; if (!el || !p.interactive) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12, toWorld(e.clientX, e.clientY)); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [p.interactive]); // eslint-disable-line react-hooks/exhaustive-deps

  const down = (e: React.PointerEvent, kind: "pan" | "stand" | "section", st?: Stand, sec?: Section, parent?: M) => {
    if (!p.interactive || e.button !== 0) return;
    e.stopPropagation();
    if (p.ghost) return;
    const w = toWorld(e.clientX, e.clientY);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (kind === "section" && st && sec) {
      p.onSelect?.({ stand: st.key, section: sec.key });
      // section coordinates are in the stand's frame
      const m = parent!; const det = m[0] * m[3] - m[1] * m[2];
      const inv: M = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
      const l = apply(inv, w.x, w.y);
      drag.current = { kind, sx: l.x, sy: l.y, ox: sec.x, oy: sec.y, stand: st.key, sec: sec.key, inv, moved: false };
    } else if (kind === "stand" && st) {
      p.onSelect?.({ stand: st.key });
      drag.current = { kind, sx: w.x, sy: w.y, ox: st.x, oy: st.y, stand: st.key, moved: false };
    } else {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: vb.x, oy: vb.y, moved: false };
    }
  };
  const move = (e: React.PointerEvent) => {
    if (p.ghost) { setGhostAt(toWorld(e.clientX, e.clientY)); return; }
    const d = drag.current; if (!d) return;
    if (d.kind === "pan") {
      const el = svg.current!; const k = vb.w / el.clientWidth;
      setVb((v) => ({ ...v, x: d.ox - (e.clientX - d.sx) * k, y: d.oy - (e.clientY - d.sy) * k }));
      d.moved = true;
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    if (d.kind === "stand") {
      const nx = Math.round(d.ox + w.x - d.sx), ny = Math.round(d.oy + w.y - d.sy);
      if (nx !== d.ox || ny !== d.oy) { d.moved = true; p.onMoveStand?.(d.stand!, nx, ny); }
    } else {
      const l = apply(d.inv!, w.x, w.y);
      const nx = Math.round(d.ox + l.x - d.sx), ny = Math.round(d.oy + l.y - d.sy);
      if (nx !== d.ox || ny !== d.oy) { d.moved = true; p.onMoveSection?.(d.stand!, d.sec!, nx, ny); }
    }
  };
  const up = (e: React.PointerEvent) => {
    if (p.ghost && ghostAt) { p.onPlace?.(Math.round(ghostAt.x), Math.round(ghostAt.y)); return; }
    const d = drag.current; drag.current = null;
    if (d?.kind === "pan" && !d.moved) p.onSelect?.(null);
    void e;
  };

  const labels: ReactNode[] = [];
  const pitch = p.layout.pitch;
  return (
    <svg ref={svg} className={`st-canvas${p.interactive ? " interactive" : ""}${p.ghost ? " placing" : ""}`} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      style={{ height: p.height ?? "100%" }} onPointerDown={(e) => down(e, "pan")} onPointerMove={move} onPointerUp={up}
      onDoubleClick={(e) => e.preventDefault()} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Stadion sxemasi">
      <g className="pitch">
        <rect x={pitch.x} y={pitch.y} width={pitch.w} height={pitch.h} rx={4} fill="#2E6B45" />
        <rect x={pitch.x + 8} y={pitch.y + 8} width={pitch.w - 16} height={pitch.h - 16} fill="none" stroke="#fff" strokeOpacity={.85} strokeWidth={1.4} />
        <line x1={pitch.x + pitch.w / 2} y1={pitch.y + 8} x2={pitch.x + pitch.w / 2} y2={pitch.y + pitch.h - 8} stroke="#fff" strokeOpacity={.85} strokeWidth={1.4} />
        <circle cx={pitch.x + pitch.w / 2} cy={pitch.y + pitch.h / 2} r={Math.min(pitch.w, pitch.h) * .13} fill="none" stroke="#fff" strokeOpacity={.85} strokeWidth={1.4} />
      </g>
      {p.layout.stands.map((st) => {
        const sm = tr(st.x, st.y, st.rotation);
        const standSel = p.sel?.stand === st.key && !p.sel?.section;
        return (
          <g key={st.key} transform={`translate(${st.x} ${st.y}) rotate(${st.rotation})`} onPointerDown={(e) => down(e, "stand", st)}>
            {st.sections.map((sec) => {
              const { w, h } = sectionSize(sec);
              const m = mul(sm, tr(sec.x, sec.y, sec.rotation));
              const c = apply(m, w / 2, -10);
              const zc = zoneColor[sec.zone] || "#C4C9D0";
              const color = p.colorBy === "zone" ? zc : sec.zone && p.layout.zones.find((z) => z.key === sec.zone)?.kind === "vip" ? "#111418" : "#9AA1AB";
              const isSel = p.sel?.section === sec.key && p.sel?.stand === st.key;
              const paths = seatPaths(sec);
              const diff = p.diff?.[sec.key];
              labels.push(
                <g key={`l-${st.key}-${sec.key}`} transform={`translate(${c.x} ${c.y})`} className="st-label" pointerEvents="none">
                  <rect x={-Math.max(18, sec.name.length * 4 + 8)} y={-8} width={Math.max(36, sec.name.length * 8 + 16)} height={16} rx={3}
                    fill={isSel ? "#86D11C" : diff ? "#E0A100" : "#fff"} stroke={isSel || diff ? "none" : "#D5D9DF"} />
                  <text textAnchor="middle" y={4} fontSize={10} fontWeight={700} fill={isSel ? "#111418" : diff ? "#fff" : "#4A5160"}>{sec.name}{diff ? ` · ${diff}` : ""}</text>
                </g>,
              );
              return (
                <g key={sec.key} transform={`translate(${sec.x} ${sec.y}) rotate(${sec.rotation})`}
                  onPointerDown={(e) => down(e, "section", st, sec, sm)} onDoubleClick={() => p.onOpenSection?.(st.key, sec.key)} className="st-sec">
                  <rect x={-5} y={-5} width={w + 10} height={h + 10} rx={4} fill={isSel ? "rgba(134,209,28,.14)" : "transparent"}
                    stroke={isSel ? "#86D11C" : diff ? "#E0A100" : p.sold?.has(sec.key) ? "#1F5FD6" : standSel ? "#111418" : "transparent"}
                    strokeWidth={isSel ? 2 : 1.4} strokeDasharray={diff || (p.sold?.has(sec.key) && !isSel) ? "4 3" : undefined} />
                  <path d={paths.normal} fill={color} />
                  {paths.blocked && <path d={paths.blocked} fill="#D5D9DF" />}
                  {sec.seat_mode === "free" && <text x={w / 2} y={h + 14} textAnchor="middle" fontSize={8} fill="#8A92A0" pointerEvents="none">erkin o‘rindiq</text>}
                </g>
              );
            })}
          </g>
        );
      })}
      {labels}
      {p.ghost && ghostAt && (
        <g transform={`translate(${ghostAt.x} ${ghostAt.y}) rotate(${p.ghost.rotation})`} opacity={.75} pointerEvents="none">
          {p.ghost.sections.map((sec) => {
            const { w, h } = sectionSize(sec);
            return (
              <g key={sec.key} transform={`translate(${sec.x} ${sec.y}) rotate(${sec.rotation})`}>
                <rect x={-5} y={-5} width={w + 10} height={h + 10} rx={4} fill="rgba(134,209,28,.18)" stroke="#86D11C" strokeDasharray="5 4" />
                <path d={seatPaths(sec).normal} fill="#7AC70C" />
              </g>
            );
          })}
        </g>
      )}
      {p.children}
      <style>{`.st-canvas .st-sec{cursor:${p.interactive ? "move" : "default"}}`}</style>
      <desc>{`aisle ${AISLE}`}</desc>
    </svg>
  );
}
