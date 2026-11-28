"use client";
import { useMemo } from "react";
import { layoutBox, sectionMatrix, sectionSize, seatPaths, type Layout, type ZoneOffer } from "@/lib/tickets";

import { useT } from "@/lib/i18n";
/** Read-only stadium map for the checkout: sections coloured by zone, click a section to pick its zone. */
export function StadiumMap({ layout, offers, selected, onPick }: { layout: Layout; offers: ZoneOffer[]; selected: Set<string>; onPick?: (zone: string) => void }) {
  const tx = useT();
  const box = useMemo(() => layoutBox(layout), [layout]);
  const byZone = useMemo(() => Object.fromEntries(offers.map((o) => [o.zone_key, o])), [offers]);
  const p = layout.pitch;
  return (
    <svg className="tk-map" viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} role="img" aria-label={tx("Stadion sxemasi")}>
      <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={4} fill="#2E6B45" />
      <g fill="none" stroke="#fff" strokeOpacity={.85} strokeWidth={1.4}>
        <rect x={p.x + 8} y={p.y + 8} width={p.w - 16} height={p.h - 16} />
        <line x1={p.x + p.w / 2} y1={p.y + 8} x2={p.x + p.w / 2} y2={p.y + p.h - 8} />
        <circle cx={p.x + p.w / 2} cy={p.y + p.h / 2} r={Math.min(p.w, p.h) * .13} />
        <rect x={p.x + 8} y={p.y + p.h * .28} width={p.w * .12} height={p.h * .44} />
        <rect x={p.x + p.w - 8 - p.w * .12} y={p.y + p.h * .28} width={p.w * .12} height={p.h * .44} />
      </g>
      {layout.stands.map((st) => st.sections.map((s) => {
        const { w, h } = sectionSize(s);
        const m = sectionMatrix(st, s);
        const paths = seatPaths(s);
        const fillOf = (zone: string) => {
          const o = byZone[zone];
          const on = !!o && selected.has(zone), off = !o || o.left === 0, vip = o?.kind === "vip";
          return off ? "#E3E6EA" : on ? (vip ? "#15181C" : "#91DA27") : vip ? "#4F5661" : zoneTint(o);
        };
        const zonesHere = Object.keys(paths);
        const anyOn = zonesHere.some((z) => selected.has(z));
        const main = byZone[s.zone];
        const off = zonesHere.every((z) => !byZone[z] || byZone[z].left === 0);
        const c = { x: m[0] * w / 2 + m[2] * h / 2 + m[4], y: m[1] * w / 2 + m[3] * h / 2 + m[5] };
        return (
          <g key={`${st.key}-${s.key}`} className={`tk-sec${off ? " off" : ""}`}>
            <title>{`${s.name}${zonesHere.map((z) => byZone[z] ? ` · ${byZone[z].title}${byZone[z].left === 0 ? tx(" (sotilgan)") : ""}` : "").join("")}`}</title>
            <g transform={`matrix(${m.join(" ")})`}>
              <rect x={-4} y={-4} width={w + 8} height={h + 8} rx={4} fill={anyOn ? "rgba(145,218,39,.18)" : "transparent"} stroke={anyOn ? "#76B91A" : "transparent"} strokeWidth={1.5}
                onClick={() => main && main.left > 0 && onPick?.(s.zone)} />
              {zonesHere.map((z) => (
                <path key={z} d={paths[z]} fill={fillOf(z)} onClick={() => byZone[z] && byZone[z].left > 0 && onPick?.(z)}>
                  {z !== s.zone && byZone[z] && <title>{`${s.name} · ${byZone[z].title}`}</title>}
                </path>
              ))}
            </g>
            <g transform={`translate(${c.x} ${c.y})`} pointerEvents="none">
              <rect x={-Math.max(16, s.name.length * 4 + 6)} y={-8} width={Math.max(32, s.name.length * 8 + 12)} height={16} rx={3} fill={anyOn && main?.kind === "vip" ? "#91DA27" : "#fff"} opacity={.95} />
              <text textAnchor="middle" y={4} fontSize={10} fontWeight={700} fill="#15181C">{s.name}</text>
            </g>
          </g>
        );
      }))}
    </svg>
  );
}

/** Map colour of an ordinary zone: its own colour when the admin picked one, grey otherwise. */
export function zoneTint(o: Pick<ZoneOffer, "color" | "kind">) {
  return o.kind === "vip" ? "#4F5661" : o.color && o.color.toUpperCase() !== "#9AA1AB" ? o.color : "#C3C8CF";
}
