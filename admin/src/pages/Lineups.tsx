import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { api, ApiError, type Page } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { POSITIONS, ago } from "@/lib/format";
import type { MatchDetail, Player } from "@/lib/types";
import {
  ROLE_LABEL, autoPlace, hasErrors, parseFormation, reassign, validate,
  type Check, type Formation, type LPlayer, type LineupsResponse, type Side,
} from "@/lib/lineup";
import { LineupPitch } from "@/components/Pitch";
import { Badge, Crest, ErrorBox, Loading, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { SITE_URL } from "@/components/Layout";

type Staff = { id: number; team_id: number; full_name: string; role: string; show_on_site: boolean };
type Draft = { formation: string; coach: string; assistant: string; players: LPlayer[]; version: number; status: "draft" | "published"; updated_at: string; dirty: boolean };
type Sel = { kind: "slot"; slot: number } | { kind: "player"; key: string } | null;
type Filter = "all" | "pitch" | "bench" | "free";

const keyOf = (p: { player_id: number | null; player_name: string }) => (p.player_id != null ? `id${p.player_id}` : `nm${p.player_name}`);
const fromSquad = (p: Player): LPlayer => ({ player_id: p.id, player_name: p.full_name, number: p.number, position: p.position, role: "", slot: null, is_starter: false, is_captain: false });
const POS_ORDER: Record<string, number> = { GK: 0, DF: 1, MF: 2, FW: 3, "": 4 };
const GROUP_LABEL: Record<string, string> = { GK: "DARVOZABONLAR", DF: "HIMOYACHILAR", MF: "YARIM HIMOYACHILAR", FW: "HUJUMCHILAR", "": "BOSHQALAR" };

export function LineupEditor({ detail, onSaved }: { detail: MatchDetail; onSaved: () => void }) {
  const m = detail.match;
  const toast = useToast();
  const confirm = useConfirm();
  const load = useLoad(async () => {
    const team = (id?: number) => (id ? api.get<Page<Player>>(`/admin/players?team_id=${id}&limit=200`).then((r) => r.items) : Promise.resolve([] as Player[]));
    const staff = (id?: number) => (id ? api.get<Page<Staff>>(`/admin/team-staff?team_id=${id}&limit=50`).then((r) => r.items).catch(() => [] as Staff[]) : Promise.resolve([] as Staff[]));
    const [lineups, formations, sqH, sqA, stH, stA] = await Promise.all([
      api.get<LineupsResponse>(`/admin/matches/${m.id}/lineups`),
      api.get<{ items: Formation[]; bench_max: number }>(`/admin/formations`),
      team(m.home?.id), team(m.away?.id), staff(m.home?.id), staff(m.away?.id),
    ]);
    return { lineups, formations: formations.items, benchMax: formations.bench_max, squads: { home: sqH, away: sqA }, staff: { home: stH, away: stA } };
  }, [m.id]);

  const [drafts, setDrafts] = useState<Record<Side, Draft> | null>(null);
  const [side, setSide] = useState<Side>("home");
  const [sel, setSel] = useState<Sel>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [serverChecks, setServerChecks] = useState<Partial<Record<Side, Check[]>>>({});
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const [dropBench, setDropBench] = useState(false);
  const drag = useRef<string | null>(null);

  useEffect(() => {
    if (!load.data) return;
    const L = load.data.lineups;
    const mk = (s: Side): Draft => ({ ...L[s].meta, formation: L[s].meta.formation, players: L[s].players, dirty: false });
    setDrafts({ home: mk("home"), away: mk("away") });
  }, [load.data]);

  const d = drafts?.[side];
  const team = side === "home" ? m.home : m.away;
  const formation = useMemo(() => (d?.formation ? parseFormation(d.formation) : null), [d?.formation]);
  const squad = load.data?.squads[side] || [];
  const suspended = load.data?.lineups[side].suspended || [];
  const benchMax = load.data?.benchMax ?? 9;

  const checksFor = useCallback((s: Side) => {
    const x = drafts?.[s];
    if (!x) return [];
    return validate(x.formation, x.players, { benchMax, suspended: load.data?.lineups[s].suspended, coach: x.coach });
  }, [drafts, benchMax, load.data]);
  const checks = checksFor(side);

  const update = (fn: (x: Draft) => Draft) => setDrafts((all) => (all ? { ...all, [side]: { ...fn(all[side]), dirty: true } } : all));
  const setPlayers = (fn: (ps: LPlayer[]) => LPlayer[]) => update((x) => ({ ...x, players: fn(x.players) }));

  // ---------- squad view ----------
  const rows = useMemo(() => {
    if (!d) return [];
    const inLineup = new Map(d.players.map((p) => [keyOf(p), p]));
    const list: { key: string; p: LPlayer; photo: string; status: "pitch" | "bench" | "free" }[] = [];
    for (const s of squad.filter((x) => x.is_active || inLineup.has(`id${x.id}`))) {
      const lp = inLineup.get(`id${s.id}`);
      list.push({ key: `id${s.id}`, p: lp || fromSquad(s), photo: s.photo_url, status: lp ? (lp.is_starter ? "pitch" : "bench") : "free" });
      inLineup.delete(`id${s.id}`);
    }
    for (const [key, p] of inLineup) list.push({ key, p, photo: "", status: p.is_starter ? "pitch" : "bench" });
    return list.sort((a, b) => (POS_ORDER[a.p.position] ?? 4) - (POS_ORDER[b.p.position] ?? 4) || (a.p.number ?? 999) - (b.p.number ?? 999));
  }, [d, squad]);
  const shown = rows.filter((r) => (filter === "all" || r.status === filter) && (!q || `${r.p.number ?? ""} ${r.p.player_name}`.toLowerCase().includes(q.toLowerCase())));
  const counts = { all: rows.length, pitch: rows.filter((r) => r.status === "pitch").length, bench: rows.filter((r) => r.status === "bench").length, free: rows.filter((r) => r.status === "free").length };

  // ---------- mutations ----------
  function rowFor(key: string): LPlayer | undefined {
    return rows.find((r) => r.key === key)?.p;
  }
  function placeAt(slot: number, key: string) {
    if (!formation) return;
    const incoming = rowFor(key);
    if (!incoming) return;
    setPlayers((ps) => {
      let out = ps.map((p) => ({ ...p }));
      const idx = out.findIndex((p) => keyOf(p) === key);
      const occIdx = out.findIndex((p) => p.is_starter && p.slot === slot);
      const src = idx >= 0 ? { ...out[idx] } : null;
      if (occIdx >= 0 && occIdx !== idx) {
        const occ = out[occIdx];
        if (src?.is_starter && src.slot != null) { occ.slot = src.slot; occ.role = formation.slots[src.slot].role; }
        else if (src && !src.is_starter) { occ.is_starter = false; occ.slot = null; occ.role = ""; occ.is_captain = false; }
        else out = out.filter((_, i) => i !== occIdx);
      }
      const role = formation.slots[slot].role;
      const j = out.findIndex((p) => keyOf(p) === key);
      if (j >= 0) out[j] = { ...out[j], is_starter: true, slot, role };
      else out.push({ ...incoming, is_starter: true, slot, role });
      return out;
    });
    setSel({ kind: "player", key });
  }
  function toBench(key: string) {
    const p = rowFor(key);
    if (!p) return;
    setPlayers((ps) => ps.some((x) => keyOf(x) === key) ? ps.map((x) => (keyOf(x) === key ? { ...x, is_starter: false, slot: null, role: "", is_captain: false } : x)) : [...ps, { ...p, is_starter: false, slot: null }]);
  }
  const removeP = (key: string) => { setPlayers((ps) => ps.filter((x) => keyOf(x) !== key)); setSel(null); };
  const patchP = (key: string, patch: Partial<LPlayer>) => setPlayers((ps) => ps.map((x) => (keyOf(x) === key ? { ...x, ...patch } : patch.is_captain ? { ...x, is_captain: false } : x)));

  function setFormation(code: string) {
    const f = parseFormation(code);
    if (!f || !d) return;
    update((x) => ({ ...x, formation: code, players: reassign(formation, f, x.players) }));
    setSel(null);
  }
  function autoFill() {
    if (!d) return;
    const f = formation || parseFormation("4-3-3")!;
    let ps = d.players.map((p) => ({ ...p }));
    const need = f.size - ps.filter((p) => p.is_starter).length;
    if (need > 0) {
      const lineCount = (cat: number) => f.slots.filter((s, i) => (i === 0 ? 0 : s.line === 1 ? 1 : s.line === Math.max(...f.slots.map((z) => z.line)) ? 3 : 2) === cat).length;
      const have = (pos: string) => ps.filter((p) => p.is_starter && p.position === pos).length;
      const free = rows.filter((r) => r.status === "free" && !suspended.includes(r.p.player_id ?? -1)).map((r) => r.p);
      const pick: LPlayer[] = [];
      ["GK", "DF", "MF", "FW"].forEach((pos, cat) => {
        const want = lineCount(cat) - have(pos);
        pick.push(...free.filter((p) => p.position === pos).slice(0, Math.max(0, want)));
      });
      for (const p of free) if (pick.length < need && !pick.includes(p)) pick.push(p);
      ps = [...ps, ...pick.slice(0, need).map((p) => ({ ...p, is_starter: true }))];
    }
    update((x) => ({ ...x, formation: f.code, players: autoPlace(f, ps) }));
  }
  async function clearPitch() {
    if (!(await confirm({ title: "Maydonni tozalash", text: "Barcha asosiy o‘yinchilar maydondan olinadi (zaxira saqlanadi).", danger: true, ok: "Tozalash" }))) return;
    setPlayers((ps) => ps.filter((p) => !p.is_starter));
    setSel(null);
  }

  // ---------- drag & drop ----------
  const startDrag = (key: string, e: DragEvent) => { drag.current = key; e.dataTransfer.setData("text/plain", key); e.dataTransfer.effectAllowed = "move"; };
  const keyFromDrop = (e: DragEvent) => e.dataTransfer.getData("text/plain") || drag.current;
  const onDropSlot = (slot: number, e: DragEvent) => { const k = keyFromDrop(e); setDropSlot(null); if (k) placeAt(slot, k); drag.current = null; };
  const onDropBench = (e: DragEvent) => { e.preventDefault(); const k = keyFromDrop(e); setDropBench(false); if (k) toBench(k); drag.current = null; };
  const onDropList = (e: DragEvent) => { e.preventDefault(); const k = keyFromDrop(e); if (k && d?.players.some((p) => keyOf(p) === k)) removeP(k); drag.current = null; };

  function clickSlot(slot: number) {
    const occ = d?.players.find((p) => p.is_starter && p.slot === slot);
    if (sel?.kind === "player" && (!occ || keyOf(occ) !== sel.key) && rows.find((r) => r.key === sel.key)?.status !== "pitch") return placeAt(slot, sel.key);
    setSel(occ ? { kind: "player", key: keyOf(occ) } : { kind: "slot", slot });
  }
  function clickRow(key: string) {
    if (sel?.kind === "slot") return placeAt(sel.slot, key);
    setSel({ kind: "player", key });
  }

  // ---------- save / publish ----------
  async function saveSide(s: Side) {
    const x = drafts![s];
    const res = await api.put<{ version: number; status: Draft["status"]; checks: Check[] }>(`/admin/matches/${m.id}/lineups/${s}`, {
      formation: x.formation, coach: x.coach, assistant: x.assistant, version: x.version, players: x.players,
    });
    setDrafts((all) => (all ? { ...all, [s]: { ...all[s], version: res.version, status: res.status, dirty: false, updated_at: new Date().toISOString() } } : all));
    setServerChecks((c) => ({ ...c, [s]: res.checks }));
  }
  async function saveAll(silent = false) {
    if (!drafts) return false;
    setBusy(true);
    try {
      for (const s of ["home", "away"] as Side[]) if (drafts[s].dirty) await saveSide(s);
      if (!silent) toast("Tarkib saqlandi");
      return true;
    } catch (e) {
      const checks = e instanceof ApiError ? (e.data as { checks?: Check[] })?.checks : undefined;
      if (checks) setServerChecks((c) => ({ ...c, [side]: checks }));
      toast(e instanceof Error ? e.message : "Xato", "error");
      return false;
    } finally {
      setBusy(false);
    }
  }
  // autosave drafts 10 s after the last change (published lineups are saved explicitly)
  const dirtyKey = drafts ? JSON.stringify([drafts.home.dirty && drafts.home.status === "draft" ? drafts.home.players : 0, drafts.home.formation, drafts.home.coach, drafts.away.dirty && drafts.away.status === "draft" ? drafts.away.players : 0, drafts.away.formation, drafts.away.coach]) : "";
  useEffect(() => {
    if (!drafts || busy) return;
    const pending = (["home", "away"] as Side[]).filter((s) => drafts[s].dirty && drafts[s].status === "draft");
    if (!pending.length) return;
    const t = setTimeout(() => { void saveAll(true); }, 10000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyKey]);

  async function publish() {
    if (!(await saveAll(true))) return;
    const sides = (["home", "away"] as Side[]).filter((s) => drafts![s].players.length);
    setBusy(true);
    try {
      await api.post(`/admin/matches/${m.id}/lineups/publish`, { sides });
      setDrafts((all) => all && { home: sides.includes("home") ? { ...all.home, status: "published" } : all.home, away: sides.includes("away") ? { ...all.away, status: "published" } : all.away });
      setPublishOpen(false);
      toast("Tarkiblar saytda e’lon qilindi");
      onSaved();
    } catch (e) {
      const c = e instanceof ApiError ? (e.data as { checks?: Partial<Record<Side, Check[]>> })?.checks : undefined;
      if (c) setServerChecks(c);
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  async function unpublish() {
    if (!(await confirm({ title: "Saytdan yashirish", text: "Tarkiblar saytda «e’lon qilinmagan» holatiga qaytadi.", ok: "Yashirish" }))) return;
    await api.del(`/admin/matches/${m.id}/lineups/publish`);
    setDrafts((all) => all && { home: { ...all.home, status: "draft" }, away: { ...all.away, status: "draft" } });
    toast("Tarkiblar saytdan yashirildi");
  }
  async function copyLast() {
    if (d?.players.length && !(await confirm({ title: "O‘tgan matchdan nusxa", text: "Joriy qoralama almashtiriladi.", ok: "Nusxa olish" }))) return;
    try {
      const r = await api.post<{ from: string }>(`/admin/matches/${m.id}/lineups/${side}/copy-last`);
      toast(`Nusxa olindi: ${r.from}`);
      load.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }

  if (load.error) return <ErrorBox error={load.error} retry={load.reload} />;
  if (!drafts || !d || !load.data) return <Loading />;

  const published = drafts.home.status === "published" || drafts.away.status === "published";
  const anyDirty = drafts.home.dirty || drafts.away.dirty;
  const selKey = sel?.kind === "player" ? sel.key : null;
  const selP = selKey ? rows.find((r) => r.key === selKey) : undefined;
  const selSlot = sel?.kind === "slot" ? sel.slot : selP?.p.is_starter ? selP.p.slot : null;
  const errSlots = new Set<number>();
  const numCount = new Map<number, number>();
  d.players.forEach((p) => p.number != null && numCount.set(p.number, (numCount.get(p.number) || 0) + 1));
  d.players.forEach((p) => p.is_starter && p.slot != null && p.number != null && (numCount.get(p.number) || 0) > 1 && errSlots.add(p.slot));
  const bench = d.players.filter((p) => !p.is_starter);
  const shownChecks = serverChecks[side] && hasErrors(serverChecks[side]!) && !d.dirty ? serverChecks[side]! : checks;
  const errCount = shownChecks.filter((c) => c.level === "error").length;
  const coachOpts = load.data.staff[side];
  const sideCount = (s: Side) => {
    const x = drafts[s];
    const f = x.formation ? parseFormation(x.formation) : null;
    const n = x.players.filter((p) => p.is_starter).length;
    return { text: `${n}/${f?.size ?? 11}`, ok: !hasErrors(checksFor(s)) };
  };

  return (
    <div className="stack lineup-editor">
      <div className="card lineup-status">
        <div className="row wrap" style={{ gap: 10 }}>
          {published ? <Badge tone="ok">E’lon qilingan</Badge> : <Badge>Qoralama</Badge>}
          <span className="muted small">
            {published ? "Saytda ko‘rinadi" : "Saytda ko‘rinmaydi"} · {anyDirty ? "saqlanmagan o‘zgarishlar bor" : `oxirgi saqlash ${ago(d.updated_at)}`}
          </span>
        </div>
        <div className="grow" />
        <div className="team-switch" role="tablist" aria-label="Jamoa">
          {(["home", "away"] as Side[]).map((s) => {
            const c = sideCount(s);
            const t = s === "home" ? m.home : m.away;
            return (
              <button key={s} role="tab" aria-selected={side === s} onClick={() => { setSide(s); setSel(null); }}>
                <Crest team={t} size={22} /> {t?.name || "—"} <span className={`count ${c.ok ? "ok" : "bad"}`}>{c.text}</span>
              </button>
            );
          })}
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          <Link className="btn btn-ghost btn-sm" to="/protocols"><I.upload size={15} /> Protokoldan</Link>
          <button className="btn btn-ghost btn-sm" onClick={copyLast} disabled={d.status === "published"}><I.refresh size={15} /> O‘tgan matchdan</button>
        </div>
      </div>

      {serverChecks[side] && hasErrors(serverChecks[side]!) && !d.dirty && (
        <div className="alert danger"><I.alert size={16} /> E’lon qilish uchun xatolarni tuzating — qoralama saqlangan.</div>
      )}

      <div className="lineup-grid">
        {/* squad */}
        <section className="card squad" onDragOver={(e) => e.preventDefault()} onDrop={onDropList}>
          <div className="card-head" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}><h3>Jamoa ro‘yxati</h3><span className="muted small">{team?.name} · {rows.length} o‘yinchi</span></div>
            <div className="search"><I.search size={16} /><input className="input input-sm" placeholder="Ism yoki raqam" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <div className="chips">
              {([["all", "Hammasi"], ["pitch", "Maydonda"], ["bench", "Zaxira"], ["free", "Bo‘sh"]] as [Filter, string][]).map(([k, l]) => (
                <button key={k} className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l} {counts[k]}</button>
              ))}
            </div>
          </div>
          {!rows.length ? (
            <div className="empty"><b>Jamoa ro‘yxati bo‘sh</b>Avval «O‘yinchilar» bo‘limida {team?.name} o‘yinchilarini qo‘shing.<div style={{ marginTop: 12 }}><Link className="btn btn-sm" to="/players">O‘yinchilar</Link></div></div>
          ) : (
            <div className="squad-list">
              {Object.keys(GROUP_LABEL).map((g) => {
                const list = shown.filter((r) => (r.p.position || "") === g);
                if (!list.length) return null;
                return (
                  <div key={g}>
                    <div className="squad-group">{GROUP_LABEL[g]}</div>
                    {list.map((r) => {
                      const susp = r.p.player_id != null && suspended.includes(r.p.player_id);
                      return (
                        <div key={r.key} className={`squad-row${selKey === r.key ? " selected" : ""}${r.status === "free" ? " free" : ""}`} draggable onDragStart={(e) => startDrag(r.key, e)} onClick={() => clickRow(r.key)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && clickRow(r.key)}>
                          <span className="handle" aria-hidden>⋮⋮</span>
                          <b className="num tnum">{r.p.number ?? "–"}</b>
                          <span className="grow"><b className="ellipsis" style={{ display: "block" }}>{r.p.player_name}</b><small className={susp ? "danger-text" : "muted"}>{susp ? "Oldingi matchda chetlatilgan" : POSITIONS[r.p.position] || "—"}{r.p.is_captain ? " · kapitan" : ""}</small></span>
                          <span className={`pill pill-${r.status}`}>{r.status === "pitch" ? r.p.role || "✓" : r.status === "bench" ? "Zaxira" : susp ? "Diskv.?" : "—"}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
          <div className="card-foot muted small">Tortib maydonga yoki zaxiraga qo‘ying. Ro‘yxatga qaytarish — shu yerga tashlang.</div>
        </section>

        {/* pitch */}
        <section className="card pitch-card">
          <div className="card-head" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="field" style={{ minWidth: 150 }}>
              <span className="label">Sxema</span>
              <select className="select" value={d.formation} onChange={(e) => setFormation(e.target.value)} aria-label="Sxema">
                {!d.formation && <option value="">Tanlang…</option>}
                {load.data.formations.map((f) => <option key={f.code} value={f.code}>{f.code} · {f.size}</option>)}
                {d.formation && !load.data.formations.some((f) => f.code === d.formation) && <option value={d.formation}>{d.formation}</option>}
              </select>
            </label>
            <div className="grow" />
            <button className="btn btn-ghost btn-sm" onClick={autoFill} title="Bo‘sh o‘rinlarni amplua bo‘yicha to‘ldirish">Avtojoylash</button>
            <button className="btn btn-ghost btn-sm" onClick={clearPitch} disabled={!d.players.some((p) => p.is_starter)}>Tozalash</button>
          </div>
          <div className="pitch-wrap">
            {formation ? (
              <LineupPitch formation={formation} players={d.players} selected={selSlot} dropSlot={dropSlot} flagged={errSlots}
                onSlot={clickSlot} onDragStartSlot={(i, e) => { const p = d.players.find((x) => x.is_starter && x.slot === i); if (p) startDrag(keyOf(p), e); }}
                onDragOverSlot={setDropSlot} onDropSlot={onDropSlot} />
            ) : (
              <div className="empty" style={{ color: "#fff" }}><b style={{ color: "#fff" }}>Sxemani tanlang</b>Yoki «Avtojoylash» — 4-3-3 bilan boshlanadi.</div>
            )}
          </div>
          <div className={`bench-zone${dropBench ? " drop" : ""}`} onDragOver={(e) => { e.preventDefault(); setDropBench(true); }} onDragLeave={() => setDropBench(false)} onDrop={onDropBench}>
            <div className="row" style={{ justifyContent: "space-between" }}><span className="overline">Zaxira · {bench.length}{benchMax ? ` / ${benchMax}` : ""}</span><span className="muted small">Tortib o‘tkazing yoki tanlang</span></div>
            <div className="chips">
              {bench.map((p) => (
                <span key={keyOf(p)} className={`bench-chip${selKey === keyOf(p) ? " selected" : ""}`} draggable onDragStart={(e) => startDrag(keyOf(p), e)} onClick={() => setSel({ kind: "player", key: keyOf(p) })}>
                  <b className="tnum">{p.number ?? "–"}</b> {p.player_name.split(" ").pop()}
                  <button className="x" aria-label="Zaxiradan olish" onClick={(e) => { e.stopPropagation(); removeP(keyOf(p)); }}><I.x size={13} /></button>
                </span>
              ))}
              {!bench.length && <span className="muted small">Zaxira bo‘sh</span>}
            </div>
          </div>
        </section>

        {/* inspector */}
        <div className="stack">
          <section className="card">
            {selP ? (
              <>
                <div className="card-head">
                  <div className="row"><span className="avatar">{selP.photo ? <img src={selP.photo} alt="" /> : (selP.p.number ?? "–")}</span><div><b>{selP.p.number != null ? `${selP.p.number} · ` : ""}{selP.p.player_name}</b><div className="muted small">{POSITIONS[selP.p.position] || "—"} · {selP.status === "pitch" ? "maydonda" : selP.status === "bench" ? "zaxirada" : "tarkibda emas"}</div></div></div>
                  <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setSel(null)} aria-label="Yopish"><I.x size={16} /></button>
                </div>
                <div className="card-pad stack" style={{ gap: 14 }}>
                  {formation && (
                    <label className="field"><span className="label">Maydondagi o‘rni</span>
                      <select className="select" value={selP.p.is_starter && selP.p.slot != null ? selP.p.slot : ""} onChange={(e) => e.target.value !== "" && placeAt(Number(e.target.value), selP.key)}>
                        <option value="">— maydonda emas —</option>
                        {formation.slots.map((s, i) => {
                          const occ = d.players.find((p) => p.is_starter && p.slot === i);
                          return <option key={i} value={i}>{s.role} · {ROLE_LABEL[s.role] || s.role}{occ && keyOf(occ) !== selP.key ? ` (${occ.number ?? ""} ${occ.player_name.split(" ").pop()})` : ""}</option>;
                        })}
                      </select>
                    </label>
                  )}
                  {selP.status !== "free" && (
                    <>
                      <label className="field"><span className="label">Raqam (shu match uchun)</span>
                        <input className="input" type="number" min={0} max={99} value={selP.p.number ?? ""} onChange={(e) => patchP(selP.key, { number: e.target.value === "" ? null : Number(e.target.value) })} />
                      </label>
                      {selP.status === "pitch" && (
                        <label className="check"><input type="checkbox" checked={selP.p.is_captain} onChange={(e) => patchP(selP.key, { is_captain: e.target.checked })} /> Kapitan</label>
                      )}
                    </>
                  )}
                  <div className="row wrap">
                    {selP.status !== "bench" && <button className="btn btn-sm" onClick={() => toBench(selP.key)}>Zaxiraga</button>}
                    {selP.status === "free" && sel?.kind !== "slot" && <span className="muted small">Bo‘sh o‘ringa bosing yoki torting</span>}
                    {selP.status !== "free" && <button className="btn btn-ghost btn-sm" onClick={() => removeP(selP.key)}>Tarkibdan olish</button>}
                  </div>
                </div>
              </>
            ) : sel?.kind === "slot" && formation ? (
              <div className="card-pad"><b>{formation.slots[sel.slot].role} · {ROLE_LABEL[formation.slots[sel.slot].role]}</b><p className="muted small" style={{ margin: "6px 0 0" }}>O‘rin bo‘sh — ro‘yxatdan o‘yinchini bosing yoki tortib qo‘ying.</p></div>
            ) : (
              <div className="card-pad muted small">O‘yinchini yoki maydondagi o‘rinni tanlang. Klaviatura: Tab bilan o‘ting, Enter — tanlash.</div>
            )}
          </section>

          <section className="card">
            <div className="card-head"><h3>Tekshiruv</h3>{errCount ? <Badge tone="danger">{errCount} ta xato</Badge> : <Badge tone="ok">Tayyor</Badge>}</div>
            <ul className="checklist">
              {shownChecks.length === 0 && <li className="ok"><I.check size={16} /> Hammasi joyida</li>}
              {shownChecks.map((c, i) => <li key={i} className={c.level}>{c.level === "error" ? <I.x size={16} /> : <I.alert size={16} />} {c.text}</li>)}
            </ul>
          </section>

          <section className="card">
            <div className="card-head"><h3>Murabbiylar</h3></div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              <datalist id={`staff-${side}`}>{coachOpts.map((s) => <option key={s.id} value={s.full_name} />)}</datalist>
              <label className="field"><span className="label">Bosh murabbiy</span><input className="input" list={`staff-${side}`} value={d.coach} onChange={(e) => update((x) => ({ ...x, coach: e.target.value }))} placeholder="Ism familiya" /></label>
              <label className="field"><span className="label">Yordamchi</span><input className="input" list={`staff-${side}`} value={d.assistant} onChange={(e) => update((x) => ({ ...x, assistant: e.target.value }))} placeholder="Ixtiyoriy" /></label>
              <span className="muted small">Tavsiyalar «Jamoalar → {team?.name} → Murabbiylar»dan.</span>
            </div>
          </section>
        </div>
      </div>

      <div className="lineup-actions">
        <a className="btn btn-ghost" href={`${SITE_URL}/matchlar/${m.id}`} target="_blank" rel="noreferrer"><I.globe size={16} /> Saytda ko‘rish</a>
        <div className="grow" />
        {published && <button className="btn btn-ghost" onClick={unpublish} disabled={busy}>Saytdan yashirish</button>}
        <button className="btn" onClick={() => saveAll()} disabled={busy || !anyDirty}>{busy ? "Saqlanmoqda…" : published ? "O‘zgarishlarni saqlash" : "Qoralamani saqlash"}</button>
        {!published && <button className="btn btn-primary" onClick={() => setPublishOpen(true)} disabled={busy || hasErrors(checksFor("home")) && hasErrors(checksFor("away"))}>E’lon qilish</button>}
      </div>

      {publishOpen && (
        <Modal title="Tarkiblarni e’lon qilish" onClose={() => setPublishOpen(false)}
          footer={<><button className="btn btn-ghost" onClick={() => setPublishOpen(false)}>Bekor qilish</button><button className="btn btn-primary" onClick={publish} disabled={busy || (["home", "away"] as Side[]).some((s) => drafts[s].players.length && hasErrors(checksFor(s)))}>E’lon qilish</button></>}>
          <p className="muted" style={{ marginTop: 0 }}>Saytdagi «Tarkiblar» bo‘limida darhol ko‘rinadi. Keyingi o‘zgarishlar (almashtirishlar, Live-pult) ham avtomatik yangilanadi.</p>
          <div className="stack" style={{ gap: 10 }}>
            {(["home", "away"] as Side[]).map((s) => {
              const x = drafts[s];
              const cs = checksFor(s);
              const t = s === "home" ? m.home : m.away;
              const starters = x.players.filter((p) => p.is_starter).length;
              return (
                <div key={s} className="publish-row">
                  <Crest team={t} size={32} />
                  <div className="grow"><b>{t?.name || "—"}</b><div className="muted small">{x.players.length ? `${x.formation || "sxemasiz"} · ${starters} asosiy + ${x.players.length - starters} zaxira${x.players.some((p) => p.is_captain) ? " · kapitan belgilangan" : ""}` : "Tarkib kiritilmagan — e’lon qilinmaydi"}</div>
                    {hasErrors(cs) && <div className="danger-text small">{cs.filter((c) => c.level === "error").map((c) => c.text).join("; ")}</div>}</div>
                  {x.players.length ? (hasErrors(cs) ? <I.x size={18} /> : <I.check size={18} />) : null}
                </div>
              );
            })}
          </div>
        </Modal>
      )}
    </div>
  );
}
