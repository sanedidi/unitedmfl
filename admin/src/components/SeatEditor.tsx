import { useEffect, useMemo, useRef, useState } from "react";
import { I } from "./Icons";
import { cleanRowZones, newRow, seatCount, seatId, seatZone, sectionZoneCounts, setSeatZone, type Section, type Zone } from "@/lib/tickets";

import { tx } from "@/lib/i18n";
/** S3: seat-level editing of one section — select, remove, block, split, rows. */
export function SeatEditor({ section: s, zones, sold, path, onBack, onChange, onSplit, onAddZone }: {
  section: Section; zones: Zone[]; sold: Set<string>; path: string[]; onBack: () => void;
  onChange: (fn: (s: Section) => void) => void; onSplit: (rows: [string, number[]][]) => void;
  onAddZone: (name: string) => string; // creates a zone in the layout, returns its key
}) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [zoneMenu, setZoneMenu] = useState(false);
  const [newZone, setNewZone] = useState<string | null>(null);
  useEffect(() => { if (!sel.size) { setZoneMenu(false); setNewZone(null); } }, [sel.size]);
  const colorOf = (k: string) => zones.find((z) => z.key === k)?.color || "#9AA1AB";
  const counts = sectionZoneCounts(s);
  const usedZones = Object.keys(counts).filter((k) => k !== s.zone);
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
      cleanRowZones(x);
    });
    setSel(new Set());
  };
  const restore = (row: string, n: number) => onChange((x) => { const r = x.rows.find((q) => q.label === row)!; r.removed = r.removed.filter((q) => q !== n); });
  const setRowSeats = (label: string, n: number) => onChange((x) => { const r = x.rows.find((q) => q.label === label)!; r.seats = Math.max(0, Math.min(400, n)); r.removed = r.removed.filter((q) => q <= r.seats); r.blocked = r.blocked.filter((q) => q <= r.seats); cleanRowZones(x); });
  const selZones = () => new Set(byRow.flatMap(([label, nums]) => { const r = s.rows.find((x) => x.label === label)!; return nums.map((n) => seatZone(s, r, n)); }));
  const selZone = () => { const z = selZones(); return z.size === 1 ? [...z][0] : ""; };
  const selZoneName = () => { const z = selZone(); return z ? zones.find((q) => q.key === z)?.name || z : tx("aralash"); };
  const applyZone = (k: string) => { onChange((x) => setSeatZone(x, byRow, k)); setZoneMenu(false); setNewZone(null); setSel(new Set()); };
  const rowSold = (label: string) => [...sold].some((id) => id.startsWith(`${s.key}:${label}:`));

  return (
    <div className="seat-ed">
      <div className="seat-ed-top">
        <button className="btn btn-sm" onClick={onBack}><I.back size={14} />{" "}{tx("Butun stadion")}</button>
        <span className="muted small">{path.filter(Boolean).join(" / ")}</span>
        <span className="grow" />
        <span className="small"><i className="dot" style={{ background: zone?.color || "#D5D9DF" }} /> {zone?.name || tx("Zonasiz")} · {seatCount(s)}{" "}{tx("o‘rin ·")}{" "}{s.seat_mode === "free" ? tx("erkin o‘rindiq") : tx("raqamlangan")}</span>
      </div>
      <div className="seat-ed-body">
        <div className="seat-ed-grid" onPointerLeave={() => (dragging.current = null)}><div className="seat-ed-inner">
          <div className="seat-ed-pitch">{tx("↑ MAYDON TOMON")}</div>
          {s.rows.map((r) => (
            <div key={r.label} className="seat-row">
              <span className="rl">{r.label}</span>
              {Array.from({ length: maxN }, (_, i) => i + 1).map((pos) => {
                const n = s.numbering === "rtl" ? maxN + 1 - pos : pos;
                const aisle = s.aisle_after.includes(pos - 1) && pos > 1;
                if (n > r.seats) return <span key={pos} className={`seat none${aisle ? " aisle" : ""}`} />;
                const k = key(r.label, n);
                const removed = r.removed.includes(n), blocked = r.blocked.includes(n), isSold = sold.has(seatId(s.key, r.label, n));
                if (removed) return <button key={pos} className={`seat removed${aisle ? " aisle" : ""}`} title={tx("O‘rinni qaytarish")} onClick={() => restore(r.label, n)}>+</button>;
                return (
                  <button key={pos} className={`seat${sel.has(k) ? " sel" : ""}${blocked ? " blocked" : ""}${isSold ? " sold" : ""}${aisle ? " aisle" : ""}`}
                    style={!sel.has(k) && !blocked && !isSold ? { background: colorOf(seatZone(s, r, n)) } : undefined}
                    title={isSold ? tx("Sotilgan") : blocked ? tx("Bloklangan") : tx("{0}-qator, {1}-o‘rin · {2}", r.label, n, zones.find((z) => z.key === seatZone(s, r, n))?.name || "zonasiz")}
                    onPointerDown={(e) => { e.preventDefault(); const add = !sel.has(k); dragging.current = { add }; toggle(k, add); }}
                    onPointerEnter={() => dragging.current && toggle(k, dragging.current.add)}>{n}</button>
                );
              })}
              <span className="rl">{r.label}</span>
            </div>
          ))}
          <button className="seat-ed-addrow" onClick={() => onChange((x) => { x.rows.push(newRow(String(x.rows.length + 1), x.rows[x.rows.length - 1]?.seats ?? 10)); })}><I.plus size={14} />{" "}{tx("Qator qo‘shish ({0}-qator)", s.rows.length + 1)}</button>
          <div className="seat-ed-legend">
            <span><i className="seat-mini" style={{ background: zone?.color || "#9AA1AB" }} /> {zone?.name || tx("Bo‘sh")}</span>
            {usedZones.map((k) => <span key={k}><i className="seat-mini" style={{ background: colorOf(k) }} /> {zones.find((z) => z.key === k)?.name || k}</span>)}<span><i className="seat-mini sel" />{" "}{tx("Tanlangan")}</span><span><i className="seat-mini blocked" />{" "}{tx("Bloklangan")}</span>
            <span><i className="seat-mini sold" />{" "}{tx("Sotilgan")}</span><span><i className="seat-mini removed" />{" "}{tx("O‘chirilgan — bosib qaytarish")}</span>
          </div>
        </div></div>
        <div className="seat-ed-rows">
          <div className="row"><b className="grow">{tx("Sektordagi zonalar")}</b><small className="muted">{tx("narx toifalari")}</small></div>
          <div className="seat-zones">
            <div className="seat-zone"><i className="hollow" style={{ borderColor: colorOf(s.zone) }} /><span className="grow"><b>{zone?.name || tx("Zonasiz")}</b><small>{tx("Sektor zonasi · qolgan o‘rinlar")}</small></span><b>{counts[s.zone] || 0}</b></div>
            {usedZones.map((k) => (
              <div key={k} className="seat-zone"><i style={{ background: colorOf(k) }} /><span className="grow"><b>{zones.find((z) => z.key === k)?.name || k}</b><small>{rowsOf(s, k)}</small></span>
                <span className="seat-zone-n"><b>{counts[k]}</b><button className="link" onClick={() => onChange((x) => { x.rows.forEach((r) => { if (r.zone_seats) delete r.zone_seats[k]; }); cleanRowZones(x); })}>{tx("Olib tashlash")}</button></span></div>
            ))}
            {!usedZones.length && <small className="muted">{tx("Markaziy o‘rinlar qimmatroq bo‘lsin desangiz — ularni belgilang va pastdagi «Zona» tugmasini bosing.")}{s.seat_mode === "free" ? tx(" Sektor raqamlangan o‘rindiqqa o‘tadi.") : ""}</small>}
          </div>
          <div className="row"><b className="grow">{tx("Qatorlar")}</b><small className="muted">{tx("o‘rinlar soni")}</small></div>
          {s.rows.map((r, i) => (
            <div key={r.label} className="row seat-ed-row">
              <span className="grow">{r.label}{tx("-qator")}{" "}{r.blocked.length ? <small className="muted">{tx("· {0} bloklangan", r.blocked.length)}</small> : null}{r.removed.length ? <small className="muted">{tx("· {0} o‘chirilgan", r.removed.length)}</small> : null}</span>
              <div className="num sm">
                <button onClick={() => setRowSeats(r.label, r.seats - 1)} disabled={rowSold(r.label)}>−</button>
                <input value={r.seats} onChange={(e) => setRowSeats(r.label, parseInt(e.target.value || "0", 10) || 0)} />
                <button onClick={() => setRowSeats(r.label, r.seats + 1)}>+</button>
              </div>
              <button className="btn btn-ghost btn-icon btn-sm" disabled={rowSold(r.label) || s.rows.length === 1} title={tx("Qatorni o‘chirish")}
                onClick={() => onChange((x) => { x.rows.splice(i, 1); })}><I.trash size={14} /></button>
            </div>
          ))}
          <label className="toggle-row"><span><b>{tx("Yo‘lak")}</b><small>{s.aisle_after.length ? tx("{0} va keyingi o‘rin orasida", s.aisle_after.join(", ")) : tx("yo‘q")}</small></span>
            <input type="checkbox" className="switch lime" checked={s.aisle_after.length > 0} onChange={(e) => onChange((x) => { x.aisle_after = e.target.checked ? [Math.floor(maxN / 2)] : []; })} /></label>
          {s.aisle_after.length > 0 && <div className="num sm"><button onClick={() => onChange((x) => { x.aisle_after = [Math.max(1, x.aisle_after[0] - 1)]; })}>−</button><input readOnly value={s.aisle_after[0]} /><button onClick={() => onChange((x) => { x.aisle_after = [Math.min(maxN - 1, x.aisle_after[0] + 1)]; })}>+</button></div>}
          <label className="toggle-row"><span><b>{tx("Raqamlash")}</b><small>{s.numbering === "rtl" ? tx("O‘ngdan chapga") : tx("Chapdan o‘ngga")}{tx(", har qatorda 1 dan")}</small></span>
            <input type="checkbox" className="switch" checked={s.numbering === "rtl"} onChange={(e) => onChange((x) => { x.numbering = e.target.checked ? "rtl" : "ltr"; })} /></label>
          <button className="btn btn-primary" onClick={onBack}>{tx("Tayyor — stadionga qaytish")}</button>
        </div>
      </div>
      {sel.size > 0 && (
        <div className="seat-ed-actions">
          <b>{sel.size}{" "}{tx("o‘rin tanlandi")}</b>
          <button className="lime" disabled={soldSel} onClick={() => { onSplit(byRow); setSel(new Set()); }}><I.plus size={14} />{" "}{tx("Alohida sektor")}</button>
          <span className="seat-zone-pick">
            <button className={zoneMenu ? "on" : ""} disabled={soldSel} onClick={() => setZoneMenu(!zoneMenu)}>{tx("Zona:")}{" "}{selZoneName()} {zoneMenu ? "▴" : "▾"}</button>
            {zoneMenu && (
              <div className="seat-zone-menu">
                <small>{tx("Tanlangan o‘rinlar narx toifasi")}</small>
                {[s.zone, ...zones.map((z) => z.key).filter((k) => k !== s.zone)].filter(Boolean).map((k) => {
                  const z = zones.find((q) => q.key === k);
                  const own = k === s.zone;
                  return (
                    <button key={k} className={selZone() === k ? "on" : ""} onClick={() => applyZone(k)}>
                      <i className={own ? "hollow" : ""} style={own ? { borderColor: colorOf(k) } : { background: colorOf(k) }} />
                      <span><b>{own ? tx("Sektor zonasi ({0})", z?.name) : z?.name}</b><small>{own ? tx("Alohida toifani olib tashlash") : tx("{0} o‘rin shu sektorda", counts[k] || 0)}</small></span>
                      {selZone() === k && <I.check size={14} />}
                    </button>
                  );
                })}
                <hr />
                {newZone === null ? <button onClick={() => setNewZone("")}><I.plus size={14} /> <span><b>{tx("Yangi zona yaratish…")}</b></span></button> : (
                  <form className="seat-zone-new" onSubmit={(e) => { e.preventDefault(); if (newZone.trim()) applyZone(onAddZone(newZone.trim())); }}>
                    <input autoFocus className="input input-sm" placeholder={tx("Markaziy")} value={newZone} onChange={(e) => setNewZone(e.target.value)} />
                    <button type="submit" className="btn btn-primary btn-sm" disabled={!newZone.trim()}>{tx("Qo‘shish")}</button>
                  </form>
                )}
              </div>
            )}
          </span>
          <button onClick={() => act("block")} disabled={soldSel}><I.lock size={14} />{" "}{tx("Bloklash")}</button>
          {blockedSel && <button onClick={() => act("unblock")}>{tx("Blokdan chiqarish")}</button>}
          <button className="red" disabled={soldSel} onClick={() => act("remove")}><I.trash size={14} />{" "}{tx("O‘chirish")}</button>
          <button onClick={() => setSel(new Set())} aria-label={tx("Bekor")}><I.x size={14} /></button>
          {soldSel && <small>{tx("Sotilgan o‘rinlar tanlangan")}</small>}
        </div>
      )}
    </div>
  );
}

/** "1–4 qator, 4–9 o‘rinlar"-style summary of where a zone sits in the section. */
function rowsOf(s: Section, zone: string) {
  const rows = s.rows.filter((r) => r.zone_seats?.[zone]?.length);
  if (!rows.length) return "";
  const nums = [...new Set(rows.flatMap((r) => r.zone_seats![zone]))].sort((a, b) => a - b);
  const span = (a: string[]) => (a.length > 1 ? `${a[0]}–${a[a.length - 1]}` : a[0]);
  return tx("{0} qator, {1} o‘rinlar", span(rows.map((r) => r.label)), span(nums.map(String)));
}
