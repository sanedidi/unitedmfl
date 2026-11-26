import { useEffect, useMemo, useRef, useState } from "react";
import { I } from "./Icons";
import { newRow, seatCount, seatId, type Section, type Zone } from "@/lib/tickets";

/** S3: seat-level editing of one section — select, remove, block, split, rows. */
export function SeatEditor({ section: s, zones, sold, path, onBack, onChange, onSplit }: {
  section: Section; zones: Zone[]; sold: Set<string>; path: string[]; onBack: () => void;
  onChange: (fn: (s: Section) => void) => void; onSplit: (rows: [string, number[]][]) => void;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const dragging = useRef<null | { add: boolean }>(null);
  useEffect(() => { setSel(new Set()); }, [s.key]);
  useEffect(() => { const up = () => (dragging.current = null); window.addEventListener("pointerup", up); return () => window.removeEventListener("pointerup", up); }, []);
  const maxN = s.rows.reduce((m, r) => Math.max(m, r.seats), 0);
  const zone = zones.find((z) => z.key === s.zone);
  const key = (row: string, n: number) => `${row}:${n}`;
  const toggle = (k: string, add?: boolean) => setSel((cur) => { const n = new Set(cur); const on = add ?? !n.has(k); if (on) n.add(k); else n.delete(k); return n; });
  const byRow = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const k of sel) { const [r, n] = k.split(":"); m.set(r, [...(m.get(r) || []), Number(n)]); }
    return [...m.entries()].map(([r, ns]) => [r, ns.sort((a, b) => a - b)] as [string, number[]]);
  }, [sel]);
  const blockedSel = [...sel].some((k) => { const [r, n] = k.split(":"); return !!s.rows.find((x) => x.label === r)?.blocked.includes(Number(n)); });
  const soldSel = [...sel].some((k) => { const [r, n] = k.split(":"); return sold.has(seatId(s.key, r, Number(n))); });
  const act = (kind: "remove" | "block" | "unblock") => {
    onChange((x) => {
      for (const r of x.rows) {
        const nums = byRow.find(([l]) => l === r.label)?.[1] || [];
        if (!nums.length) continue;
        if (kind === "remove") { r.removed = [...new Set([...r.removed, ...nums])].sort((a, b) => a - b); r.blocked = r.blocked.filter((n) => !nums.includes(n)); }
        if (kind === "block") r.blocked = [...new Set([...r.blocked, ...nums.filter((n) => !r.removed.includes(n))])].sort((a, b) => a - b);
        if (kind === "unblock") r.blocked = r.blocked.filter((n) => !nums.includes(n));
      }
    });
    setSel(new Set());
  };
  const restore = (row: string, n: number) => onChange((x) => { const r = x.rows.find((q) => q.label === row)!; r.removed = r.removed.filter((q) => q !== n); });
  const setRowSeats = (label: string, n: number) => onChange((x) => { const r = x.rows.find((q) => q.label === label)!; r.seats = Math.max(0, Math.min(400, n)); r.removed = r.removed.filter((q) => q <= r.seats); r.blocked = r.blocked.filter((q) => q <= r.seats); });
  const rowSold = (label: string) => [...sold].some((id) => id.startsWith(`${s.key}:${label}:`));

  return (
    <div className="seat-ed">
      <div className="seat-ed-top">
        <button className="btn btn-sm" onClick={onBack}><I.back size={14} /> Butun stadion</button>
        <span className="muted small">{path.filter(Boolean).join(" / ")}</span>
        <span className="grow" />
        <span className="small"><i className="dot" style={{ background: zone?.color || "#D5D9DF" }} /> {zone?.name || "Zonasiz"} · {seatCount(s)} o‘rin · {s.seat_mode === "free" ? "erkin o‘rindiq" : "raqamlangan"}</span>
      </div>
      <div className="seat-ed-body">
        <div className="seat-ed-grid" onPointerLeave={() => (dragging.current = null)}><div className="seat-ed-inner">
          <div className="seat-ed-pitch">↑ MAYDON TOMON</div>
          {s.rows.map((r) => (
            <div key={r.label} className="seat-row">
              <span className="rl">{r.label}</span>
              {Array.from({ length: maxN }, (_, i) => i + 1).map((pos) => {
                const n = s.numbering === "rtl" ? maxN + 1 - pos : pos;
                const aisle = s.aisle_after.includes(pos - 1) && pos > 1;
                if (n > r.seats) return <span key={pos} className={`seat none${aisle ? " aisle" : ""}`} />;
                const k = key(r.label, n);
                const removed = r.removed.includes(n), blocked = r.blocked.includes(n), isSold = sold.has(seatId(s.key, r.label, n));
                if (removed) return <button key={pos} className={`seat removed${aisle ? " aisle" : ""}`} title="O‘rinni qaytarish" onClick={() => restore(r.label, n)}>+</button>;
                return (
                  <button key={pos} className={`seat${sel.has(k) ? " sel" : ""}${blocked ? " blocked" : ""}${isSold ? " sold" : ""}${aisle ? " aisle" : ""}`}
                    style={!sel.has(k) && !blocked && !isSold ? { background: zone?.color || "#9AA1AB" } : undefined}
                    title={isSold ? "Sotilgan" : blocked ? "Bloklangan" : `${r.label}-qator, ${n}-o‘rin`}
                    onPointerDown={(e) => { e.preventDefault(); const add = !sel.has(k); dragging.current = { add }; toggle(k, add); }}
                    onPointerEnter={() => dragging.current && toggle(k, dragging.current.add)}>{n}</button>
                );
              })}
              <span className="rl">{r.label}</span>
            </div>
          ))}
          <button className="seat-ed-addrow" onClick={() => onChange((x) => { x.rows.push(newRow(String(x.rows.length + 1), x.rows[x.rows.length - 1]?.seats ?? 10)); })}><I.plus size={14} /> Qator qo‘shish ({s.rows.length + 1}-qator)</button>
          <div className="seat-ed-legend">
            <span><i className="seat-mini" style={{ background: zone?.color || "#9AA1AB" }} /> Bo‘sh</span><span><i className="seat-mini sel" /> Tanlangan</span><span><i className="seat-mini blocked" /> Bloklangan</span>
            <span><i className="seat-mini sold" /> Sotilgan</span><span><i className="seat-mini removed" /> O‘chirilgan — bosib qaytarish</span>
          </div>
        </div></div>
        <div className="seat-ed-rows">
          <div className="row"><b className="grow">Qatorlar</b><small className="muted">o‘rinlar soni</small></div>
          {s.rows.map((r, i) => (
            <div key={r.label} className="row seat-ed-row">
              <span className="grow">{r.label}-qator {r.blocked.length ? <small className="muted">· {r.blocked.length} bloklangan</small> : null}{r.removed.length ? <small className="muted">· {r.removed.length} o‘chirilgan</small> : null}</span>
              <div className="num sm">
                <button onClick={() => setRowSeats(r.label, r.seats - 1)} disabled={rowSold(r.label)}>−</button>
                <input value={r.seats} onChange={(e) => setRowSeats(r.label, parseInt(e.target.value || "0", 10) || 0)} />
                <button onClick={() => setRowSeats(r.label, r.seats + 1)}>+</button>
              </div>
              <button className="btn btn-ghost btn-icon btn-sm" disabled={rowSold(r.label) || s.rows.length === 1} title="Qatorni o‘chirish"
                onClick={() => onChange((x) => { x.rows.splice(i, 1); })}><I.trash size={14} /></button>
            </div>
          ))}
          <label className="toggle-row"><span><b>Yo‘lak</b><small>{s.aisle_after.length ? `${s.aisle_after.join(", ")} va keyingi o‘rin orasida` : "yo‘q"}</small></span>
            <input type="checkbox" className="switch lime" checked={s.aisle_after.length > 0} onChange={(e) => onChange((x) => { x.aisle_after = e.target.checked ? [Math.floor(maxN / 2)] : []; })} /></label>
          {s.aisle_after.length > 0 && <div className="num sm"><button onClick={() => onChange((x) => { x.aisle_after = [Math.max(1, x.aisle_after[0] - 1)]; })}>−</button><input readOnly value={s.aisle_after[0]} /><button onClick={() => onChange((x) => { x.aisle_after = [Math.min(maxN - 1, x.aisle_after[0] + 1)]; })}>+</button></div>}
          <label className="toggle-row"><span><b>Raqamlash</b><small>{s.numbering === "rtl" ? "O‘ngdan chapga" : "Chapdan o‘ngga"}, har qatorda 1 dan</small></span>
            <input type="checkbox" className="switch" checked={s.numbering === "rtl"} onChange={(e) => onChange((x) => { x.numbering = e.target.checked ? "rtl" : "ltr"; })} /></label>
          <button className="btn btn-primary" onClick={onBack}>Tayyor — stadionga qaytish</button>
        </div>
      </div>
      {sel.size > 0 && (
        <div className="seat-ed-actions">
          <b>{sel.size} o‘rin tanlandi</b>
          <button className="lime" disabled={soldSel} onClick={() => { onSplit(byRow); setSel(new Set()); }}><I.plus size={14} /> Yangi sektorga ajratish</button>
          <button onClick={() => act("block")} disabled={soldSel}><I.lock size={14} /> Bloklash</button>
          {blockedSel && <button onClick={() => act("unblock")}>Blokdan chiqarish</button>}
          <button className="red" disabled={soldSel} onClick={() => act("remove")}><I.trash size={14} /> O‘chirish</button>
          <button onClick={() => setSel(new Set())} aria-label="Bekor"><I.x size={14} /></button>
          {soldSel && <small>Sotilgan o‘rinlar tanlangan</small>}
        </div>
      )}
    </div>
  );
}
