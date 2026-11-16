import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from "react";
import { useNavigate } from "react-router";
import { I } from "@/components/Icons";
import { ErrorBox, Loading, useToast } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import {
  MODULES, MODULE_GROUPS, blockLabel, clone, copyBlock, diffLayouts, findBlock, insertAt, meta, moveBlock, moveRow, newBlock,
  removeBlock, resolveBlock, rowSum, scheduleState, scheduleText, shortLocal, tashkentMs, toLocal, uid, updateBlock, variantForSpan,
  type Block, type DropTarget, type Layout, type ModuleType, type Row,
} from "@/lib/layout";
import { Inspector } from "./Inspector";
import { HistoryDrawer, PreviewModal, PublishModal, TimelinePanel, type HpState } from "./Panels";
import { BI, BuilderCtx, Seg, useBuilder, type BuilderApi, type Device, type MatchLite, type NewsLite, type Refs, type Sel, type TeamLite } from "./shared";

type Drag = { kind: "new"; type: ModuleType } | { kind: "block"; id: string } | { kind: "row"; id: string };
type Drop = { kind: "gap"; index: number } | { kind: "in"; rowId: string; index: number; x: number; ok: boolean };
type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";

const EMPTY_REFS: Refs = { matches: [], news: [], teams: [], groups: [] };

export function HomepageBuilder() {
  const navigate = useNavigate();
  const toast = useToast();
  const [hp, setHp] = useState<HpState | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [refs, setRefs] = useState<Refs>(EMPTY_REFS);
  const [sel, setSel] = useState<Sel>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [left, setLeft] = useState<"modules" | "layers">("modules");
  const [q, setQ] = useState("");
  const [at, setAt] = useState<number | null>(null);
  const [ttOpen, setTtOpen] = useState(false);
  const [timeline, setTimeline] = useState(false);
  const [history, setHistory] = useState(false);
  const [publishing, setPublishing] = useState<"" | "open" | "busy">("");
  const [preview, setPreview] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<number>(0);
  const [drop, setDropState] = useState<Drop | null>(null);
  const dropRef = useRef<Drop | null>(null); // read on drop: the state may not have re-rendered yet
  const setDrop = (d: Drop | null) => {
    dropRef.current = d;
    setDropState(d);
  };
  const [realNow, setRealNow] = useState(Date.now());

  const past = useRef<Layout[]>([]);
  const future = useRef<Layout[]>([]);
  const lastCommit = useRef(0);
  const stamp = useRef<string | null>(null); // draft updated_at the editor is based on
  const pending = useRef<Layout | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<number>(0);
  const drag = useRef<Drag | null>(null);
  const [, force] = useState(0);

  // ---------- load ----------
  const applyState = useCallback((s: HpState) => {
    setHp(s);
    setLayout(s.draft.config);
    stamp.current = s.draft.exists ? s.draft.updated_at : null;
    past.current = [];
    future.current = [];
    setSave("idle");
    setSel(null);
  }, []);
  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      applyState(await api.get<HpState>("/admin/homepage"));
    } catch (e) {
      setLoadErr(e);
    }
  }, [applyState]);
  useEffect(() => {
    load();
    Promise.all([
      api.get<MatchLite[]>("/matches?limit=200").catch(() => []),
      api.get<{ items: NewsLite[] }>("/admin/news?status=published&limit=40").then((r) => r.items).catch(() => []),
      api.get<{ items: TeamLite[] }>("/admin/teams?limit=100").then((r) => r.items).catch(() => []),
      api.get<{ groups: Record<string, unknown>; group_info?: Record<string, { name: string; ord: number }> }>("/standings").catch(() => null),
    ]).then(([matches, news, teams, st]) => {
      const groups = st ? Object.keys(st.groups).sort((a, b) => (st.group_info?.[a]?.ord ?? 99) - (st.group_info?.[b]?.ord ?? 99) || a.localeCompare(b))
        .map((code) => ({ code, name: st.group_info?.[code]?.name || `Guruh ${code}` })) : [];
      setRefs({ matches, news, teams, groups });
    });
    const t = setInterval(() => setRealNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [load]);

  // ---------- save ----------
  const doSave = useCallback(async (overwrite = false) => {
    if (!pending.current) return;
    const config = pending.current;
    pending.current = null;
    setSave("saving");
    try {
      const r = await api.put<{ updated_at: string }>("/admin/homepage/draft", { config, updated_at: overwrite ? null : stamp.current });
      stamp.current = r.updated_at;
      setSavedAt(Date.now());
      setSave(pending.current ? "saving" : "saved");
    } catch (e) {
      if (!pending.current) pending.current = config;
      if (e instanceof ApiError && e.status === 409) {
        setSave("conflict");
        toast(e.message, "error");
      } else {
        setSave("error");
        toast(e instanceof Error ? e.message : "Saqlanmadi", "error");
      }
    }
  }, [toast]);
  const queueSave = useCallback((l: Layout) => {
    pending.current = l;
    setSave("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      saving.current = doSave().finally(() => (saving.current = null));
    }, 900);
  }, [doSave]);
  /** Waits for the autosave so preview and publish see the latest draft. */
  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (saving.current) await saving.current;
    if (pending.current) await doSave();
    return !pending.current;
  }, [doSave]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (pending.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  // ---------- edit ----------
  const commit = useCallback((next: Layout) => {
    setLayout((cur) => {
      if (!cur || JSON.stringify(cur) === JSON.stringify(next)) return cur;
      // keystrokes within a moment form one undo step
      if (Date.now() - lastCommit.current > 700) {
        past.current.push(cur);
        if (past.current.length > 100) past.current.shift();
      }
      lastCommit.current = Date.now();
      future.current = [];
      queueSave(next);
      return next;
    });
  }, [queueSave]);
  const undo = useCallback(() => {
    setLayout((cur) => {
      const prev = past.current.pop();
      if (!cur || !prev) return cur;
      future.current.push(cur);
      lastCommit.current = 0;
      queueSave(prev);
      return prev;
    });
  }, [queueSave]);
  const redo = useCallback(() => {
    setLayout((cur) => {
      const nx = future.current.pop();
      if (!cur || !nx) return cur;
      past.current.push(cur);
      lastCommit.current = 0;
      queueSave(nx);
      return nx;
    });
  }, [queueSave]);

  const addBlock = useCallback((type: ModuleType, afterRowId?: string) => {
    if (!layout) return;
    const b = newBlock(type);
    const next = clone(layout);
    let index = next.rows.length;
    const anchor = afterRowId || (sel?.kind === "row" ? sel.id : sel?.kind === "block" ? findBlock(layout, sel.id)?.row.id : undefined);
    if (anchor) index = next.rows.findIndex((r) => r.id === anchor) + 1 || index;
    next.rows.splice(index, 0, { id: uid("r"), blocks: [b] });
    commit(next);
    setSel({ kind: "block", id: b.id });
    requestAnimationFrame(() => document.querySelector(`[data-hb-block="${b.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, [layout, sel, commit]);

  // keyboard
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]") || document.querySelector(".overlay")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (e.key === "Escape") setSel(null);
      if (!layout || sel?.kind !== "block") return;
      const f = findBlock(layout, sel.id);
      if (!f) return;
      if ((e.key === "Delete" || e.key === "Backspace") && !f.alt) {
        e.preventDefault();
        if (f.block.locked) return toast("Blok qulflangan", "error");
        commit(removeBlock(layout, f.block.id));
        setSel(null);
      }
      if (mod && e.key.toLowerCase() === "d" && !f.alt) {
        e.preventDefault();
        const next = clone(layout);
        const c = copyBlock(f.block);
        next.rows.splice(f.ri + 1, 0, { id: uid("r"), blocks: [c] });
        commit(next);
        setSel({ kind: "block", id: c.id });
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [layout, sel, undo, redo, commit, toast]);

  // ---------- drag & drop ----------
  const startDrag = (d: Drag) => (e: DragEvent) => {
    drag.current = d;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", d.kind);
    force((x) => x + 1);
  };
  const endDrag = () => {
    drag.current = null;
    setDrop(null);
    force((x) => x + 1);
  };
  const overGap = (index: number) => (e: DragEvent) => {
    if (!drag.current) return;
    e.preventDefault();
    e.stopPropagation();
    const cur = dropRef.current;
    if (cur?.kind !== "gap" || cur.index !== index) setDrop({ kind: "gap", index });
  };
  const overRow = (row: Row, ri: number) => (e: DragEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !layout) return;
    e.stopPropagation();
    const grid = e.currentTarget;
    const r = grid.getBoundingClientRect();
    if (d.kind === "row") {
      e.preventDefault();
      const index = e.clientY < r.top + r.height / 2 ? ri : ri + 1;
      const cur = dropRef.current;
      if (cur?.kind !== "gap" || cur.index !== index) setDrop({ kind: "gap", index });
      return;
    }
    const els = Array.from(grid.querySelectorAll<HTMLElement>(":scope > [data-bi]"));
    let index = els.length, x = r.width;
    for (let i = 0; i < els.length; i++) {
      const b = els[i].getBoundingClientRect();
      if (e.clientX < b.left + b.width / 2) {
        index = i;
        x = b.left - r.left - 6;
        break;
      }
      x = b.right - r.left + 6;
    }
    const type = d.kind === "new" ? d.type : findBlock(layout, d.id)?.block.type;
    const same = d.kind === "block" && row.blocks.some((b) => b.id === d.id);
    const ok = same || (row.blocks.length < 4 && type !== "hero" && !row.blocks.some((b) => b.type === "hero"));
    if (ok) e.preventDefault();
    const cur = dropRef.current;
    if (cur?.kind !== "in" || cur.rowId !== row.id || cur.index !== index || cur.ok !== ok) setDrop({ kind: "in", rowId: row.id, index, x, ok });
  };
  const doDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const d = drag.current, t = dropRef.current;
    endDrag();
    if (!d || !t || !layout) return;
    if (t.kind === "in" && !t.ok) return toast("Qatorda joy yo‘q: ko‘pi bilan 4 blok, Hero alohida qatorda", "error");
    if (d.kind === "row") {
      if (t.kind === "gap") commit(moveRow(layout, d.id, t.index));
      return;
    }
    const target: DropTarget = t.kind === "gap" ? { kind: "row", index: t.index } : { kind: "block", rowId: t.rowId, index: t.index };
    if (d.kind === "new") {
      const b = newBlock(d.type);
      if (target.kind === "block") {
        const row = layout.rows.find((r) => r.id === target.rowId)!;
        const room = 12 - rowSum(row);
        const fit = meta(d.type).spans.filter((s) => s <= room).pop();
        if (fit) Object.assign(b, { span: fit, variant: variantForSpan(fit) });
      }
      const r = insertAt(layout, b, target);
      if (!r.ok) return toast("Bu yerga qo‘yib bo‘lmaydi", "error");
      commit(r.layout);
      setSel({ kind: "block", id: b.id });
    } else {
      const r = moveBlock(layout, d.id, target);
      if (!r.ok) return toast("Bu yerga ko‘chirib bo‘lmaydi", "error");
      commit(r.layout);
      setSel({ kind: "block", id: d.id });
    }
  };

  // ---------- resize ----------
  const resize = (b: Block, row: Row) => (e: RPointerEvent<HTMLSpanElement>) => {
    if (!layout || b.locked) return;
    e.preventDefault();
    e.stopPropagation();
    const grid = (e.currentTarget.closest(".hb-row-grid") as HTMLElement).getBoundingClientRect();
    const col = grid.width / 12;
    const start = e.clientX, from = b.span, before = layout;
    const free = 12 - rowSum(row) + b.span;
    const spans = meta(b.type).spans.filter((s) => s <= free);
    let cur = before;
    const move = (ev: PointerEvent) => {
      const want = from + (ev.clientX - start) / col;
      const span = spans.reduce((a, s) => (Math.abs(s - want) < Math.abs(a - want) ? s : a), from);
      cur = updateBlock(before, b.id, (x) => ({ ...x, span, variant: x.span === span ? x.variant : variantForSpan(span) }));
      setLayout(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (cur === before) return;
      setLayout(before);
      lastCommit.current = 0;
      commit(cur);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---------- derived ----------
  const now = at ?? realNow;
  const changes = useMemo(() => (hp && layout ? diffLayouts(hp.published_config, layout) : []), [hp, layout]);
  const apiValue: BuilderApi | null = layout ? { layout, refs, now, device, commit, select: setSel, sel, toast, addBlock } : null;

  if (loadErr) return <div className="hb-fail"><ErrorBox error={loadErr} retry={load} /></div>;
  if (!hp || !layout || !apiValue) return <div className="hb-fail"><Loading /></div>;

  const openPreview = async () => {
    if (!(await flush())) return toast("Avval qoralamani saqlang", "error");
    try {
      setPreview((await api.post<{ token: string }>("/admin/homepage/preview")).token);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  };
  const publish = async (summary: string, publishAt: string | null) => {
    setPublishing("busy");
    try {
      if (!(await flush())) throw new Error("Qoralama saqlanmadi");
      const r = await api.post<{ version: number; publish_at: string }>("/admin/homepage/publish", { summary, changes, publish_at: publishAt, updated_at: stamp.current });
      applyState(await api.get<HpState>("/admin/homepage"));
      setPublishing("");
      toast(publishAt ? `v${r.version} rejalashtirildi · ${shortLocal(toLocal(Date.parse(r.publish_at)))}` : `Nashr qilindi · v${r.version}`, "ok");
    } catch (e) {
      setPublishing("open");
      toast(e instanceof Error ? e.message : "Nashr qilinmadi", "error");
    }
  };

  const saveChip = (() => {
    if (save === "conflict") return <button className="hb-save err" onClick={async () => { if (window.confirm("Boshqa foydalanuvchining o‘zgarishlari ustidan yozilsinmi? «Bekor qilish» — sahifani qayta yuklash.")) { await doSave(true); } else { await load(); } }}>Qoralama boshqa joyda o‘zgardi — hal qilish</button>;
    if (save === "error") return <button className="hb-save err" onClick={() => doSave()}>Saqlanmadi — qayta urinish</button>;
    if (save === "saving") return <span className="hb-save"><i className="spin" /> Saqlanmoqda…</span>;
    if (changes.length) return <span className="hb-save warn" title={savedAt ? `Qoralama saqlandi ${new Date(savedAt).toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" })}` : "Qoralama saqlangan"}><i /> Nashr qilinmagan o‘zgarishlar · {changes.length}</span>;
    return <span className="hb-save ok"><i /> {hp.published ? `Nashr qilingan · v${hp.published.version}` : "Saytdagi tartib"}</span>;
  })();

  const lib = MODULES.filter((m) => !q.trim() || `${m.name} ${m.desc}`.toLowerCase().includes(q.trim().toLowerCase()));
  const dragging = !!drag.current;

  return (
    <BuilderCtx.Provider value={apiValue}>
      <div className={`hb${dragging ? " dragging" : ""}`}>
        {/* ---------- top bar ---------- */}
        <header className="hb-top">
          <button className="btn btn-ghost btn-icon" onClick={() => navigate("/")} aria-label="Orqaga"><I.back /></button>
          <h1>Bosh sahifa konstruktori</h1>
          {saveChip}
          <span className="hb-undo">
            <button className="btn btn-ghost btn-icon btn-sm" onClick={undo} disabled={!past.current.length} title="Bekor qilish (Ctrl+Z)" aria-label="Bekor qilish"><BI.undo /></button>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={redo} disabled={!future.current.length} title="Qaytarish (Ctrl+Shift+Z)" aria-label="Qaytarish"><BI.redo /></button>
          </span>
          <span className="grow" />
          <Seg value={device} onChange={setDevice} options={[
            { key: "desktop", label: <><BI.monitor size={14} /> Desktop <small>1440</small></> },
            { key: "tablet", label: <><BI.tablet size={14} /> Tablet <small>768</small></> },
            { key: "mobile", label: <><BI.phone size={14} /> Mobile <small>390</small></> },
          ]} />
          <span className="hb-tt-wrap">
            {at ? (
              <span className="hb-tt on"><button onClick={() => setTtOpen((v) => !v)}><BI.clock size={14} /> {shortLocal(toLocal(at))}</button><button onClick={() => setAt(null)} aria-label="Hozirgi vaqtga qaytish"><I.x size={14} /></button></span>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => setTtOpen((v) => !v)} title="Sahifani boshqa vaqtda ko‘rish"><BI.clock size={16} /> <span className="hide-sm">Vaqt</span></button>
            )}
            {ttOpen && (
              <div className="hb-pop" onMouseLeave={() => setTtOpen(false)}>
                <b>Sahifani boshqa vaqtda ko‘rish</b>
                <input className="input input-sm" type="datetime-local" value={toLocal(at ?? realNow)} onChange={(e) => e.target.value && setAt(tashkentMs(e.target.value))} />
                <div className="hb-pills">
                  <button className="hb-pill" onClick={() => setAt((at ?? realNow) + 86400_000)}>+1 kun</button>
                  <button className="hb-pill" onClick={() => setAt((at ?? realNow) + 7 * 86400_000)}>+1 hafta</button>
                  <button className="hb-pill" onClick={() => { setAt(null); setTtOpen(false); }}>Hozir</button>
                </div>
                <small className="muted">Vaqtga bog‘liq bloklar tanlangan payt bo‘yicha ko‘rsatiladi. Toshkent vaqti.</small>
              </div>
            )}
          </span>
          <button className={`btn btn-ghost btn-sm${timeline ? " on" : ""}`} onClick={() => setTimeline((v) => !v)}><BI.layers size={16} /> <span className="hide-sm">Jadval</span></button>
          <button className="btn btn-ghost btn-sm" onClick={() => setHistory(true)}><I.refresh size={16} /> <span className="hide-sm">Tarix</span></button>
          <button className="btn btn-dark btn-sm" onClick={openPreview}>Ko‘rish</button>
          <button className="btn btn-primary btn-sm" onClick={() => setPublishing("open")} disabled={!changes.length}>Nashr qilish</button>
        </header>

        <div className="hb-body">
          {/* ---------- left: modules / layers ---------- */}
          <aside className="hb-left">
            <div className="tabs hb-tabs" role="tablist">
              <button role="tab" aria-selected={left === "modules"} onClick={() => setLeft("modules")}>Modullar</button>
              <button role="tab" aria-selected={left === "layers"} onClick={() => setLeft("layers")}>Qatlamlar</button>
            </div>
            {left === "modules" ? (
              <div className="hb-lib">
                <div className="search"><I.search size={16} /><input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Modul qidirish…" /></div>
                {MODULE_GROUPS.map((g) => {
                  const items = lib.filter((m) => m.group === g);
                  if (!items.length) return null;
                  return (
                    <Fragment key={g}>
                      <div className="hb-lib-group">{g}</div>
                      {items.map((m) => (
                        <div key={m.type} className="hb-lib-item" draggable onDragStart={startDrag({ kind: "new", type: m.type })} onDragEnd={endDrag} title="Kanvasga sudrang">
                          <span className="ic"><TypeIcon type={m.type} /></span>
                          <span className="grow"><b>{m.name}</b><small>{m.desc}</small></span>
                          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => addBlock(m.type)} aria-label={`${m.name} qo‘shish`} title="Qo‘shish"><I.plus size={16} /></button>
                        </div>
                      ))}
                    </Fragment>
                  );
                })}
              </div>
            ) : (
              <Layers />
            )}
          </aside>

          {/* ---------- canvas ---------- */}
          <main className="hb-canvas" onClick={() => setSel(null)}>
            {at && <div className="hb-tt-note"><BI.clock size={14} /> Sahifa <b>{shortLocal(toLocal(at))}</b> holatida — vaqtga bog‘liq bloklar shu vaqtga ko‘ra ko‘rsatilgan.</div>}
            {device === "mobile" ? (
              <MobileCanvas />
            ) : (
              <div className={`hb-page d-${device}`}>
                <Gap index={0} active={drop?.kind === "gap" && drop.index === 0} onOver={overGap(0)} onDrop={doDrop} label={drag.current?.kind === "row" ? "Qatorni shu yerga" : "Yangi qator"} />
                {layout.rows.map((row, ri) => (
                  <Fragment key={row.id}>
                    <RowView row={row} ri={ri} drop={drop?.kind === "in" && drop.rowId === row.id ? drop : null}
                      onOver={overRow(row, ri)} onDrop={doDrop} startDrag={startDrag} endDrag={endDrag} resize={resize} />
                    <Gap index={ri + 1} active={drop?.kind === "gap" && drop.index === ri + 1} onOver={overGap(ri + 1)} onDrop={doDrop} label={drag.current?.kind === "row" ? "Qatorni shu yerga" : "Yangi qator"} />
                  </Fragment>
                ))}
                {!layout.rows.length && <div className="hb-empty">Modulni chap paneldan shu yerga sudrang</div>}
              </div>
            )}
          </main>

          {/* ---------- right: inspector ---------- */}
          <aside className="hb-right" onClick={(e) => e.stopPropagation()}>
            <Inspector />
          </aside>
        </div>

        {timeline && <TimelinePanel layout={layout} matches={refs.matches} realNow={realNow} at={at} onPick={(id) => setSel({ kind: "block", id })} onAt={setAt} onClose={() => setTimeline(false)} />}
      </div>

      {history && <HistoryDrawer onClose={() => setHistory(false)} onState={applyState} dirty={changes.length > 0} />}
      {publishing && <PublishModal changes={changes} busy={publishing === "busy"} nextVersion={(hp.published?.version || 0) + 1 + hp.scheduled.length} onClose={() => setPublishing("")} onPublish={publish} onPreview={openPreview} />}
      {preview && <PreviewModal token={preview} at={at} device={device} onClose={() => setPreview(null)} />}
    </BuilderCtx.Provider>
  );
}

// ---------------- canvas parts ----------------

function Gap({ index, active, onOver, onDrop, label }: { index: number; active: boolean; onOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void; label: string }) {
  return (
    <div className={`hb-gap${active ? " on" : ""}`} data-gap={index} onDragOver={onOver} onDragEnter={onOver} onDrop={onDrop}>
      <span><I.plus size={14} /> {label}</span>
    </div>
  );
}

function RowView({ row, ri, drop, onOver, onDrop, startDrag, endDrag, resize }: {
  row: Row; ri: number; drop: Extract<Drop, { kind: "in" }> | null;
  onOver: (e: DragEvent<HTMLDivElement>) => void; onDrop: (e: DragEvent) => void;
  startDrag: (d: Drag) => (e: DragEvent) => void; endDrag: () => void;
  resize: (b: Block, row: Row) => (e: RPointerEvent<HTMLSpanElement>) => void;
}) {
  const { sel, select, device } = useBuilder();
  const sum = rowSum(row);
  const half = row.blocks.every((b) => b.span <= 6);
  const selected = sel?.kind === "row" && sel.id === row.id;
  return (
    <div className={`hb-row${selected ? " sel" : ""}${row.hidden ? " is-hidden" : ""}${row.bg ? ` bg-${row.bg}` : ""}`} data-hb-row={row.id}>
      <button className="hb-row-handle" draggable onDragStart={startDrag({ kind: "row", id: row.id })} onDragEnd={endDrag}
        onClick={(e) => { e.stopPropagation(); select({ kind: "row", id: row.id }); }} title="Qator sozlamalari · sudrab ko‘chirish">
        <I.table size={13} /><span>{ri + 1}</span>
      </button>
      {selected && <span className="hb-row-label">Qator {ri + 1} · {row.blocks.length} blok · {row.blocks.map((b) => b.span).join(" + ")}{row.hidden ? " · yashirin" : ""}</span>}
      <div className="hb-row-grid" style={{ gap: row.gap ? Math.round(row.gap / 2) : 12 }} onDragOver={onOver} onDragEnter={onOver} onDrop={onDrop}>
        {row.blocks.map((b, bi) => (
          <BlockView key={b.id} b={b} bi={bi} row={row} span={device === "tablet" ? (half ? 6 : 12) : b.span} startDrag={startDrag} endDrag={endDrag} resize={resize} />
        ))}
        {device === "desktop" && sum < 12 && !row.blocks.some((b) => b.type === "hero") && <div className="hb-free" style={{ gridColumn: `span ${12 - sum}` }}>{12 - sum} ustun bo‘sh</div>}
        {drop && <i className={`hb-vind${drop.ok ? "" : " bad"}`} style={{ left: drop.x }} />}
      </div>
    </div>
  );
}

function BlockView({ b, bi, row, span, startDrag, endDrag, resize }: {
  b: Block; bi: number; row: Row; span: number;
  startDrag: (d: Drag) => (e: DragEvent) => void; endDrag: () => void;
  resize: (b: Block, row: Row) => (e: RPointerEvent<HTMLSpanElement>) => void;
}) {
  const { sel, select, now, refs, device, layout, commit, toast } = useBuilder();
  const selected = sel?.kind === "block" && (sel.id === b.id || sel.id === b.alt?.id);
  const resolved = resolveBlock({ ...b, hidden: false }, now, refs.matches);
  const sch = b.schedule && b.schedule.mode !== "always" ? scheduleState(b.schedule, now, refs.matches) : null;
  const shown = resolved || b;
  const off = !resolved;
  const hiddenOn = device !== "desktop" && b.devices && !b.devices[device];
  const act = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <div className={`hb-blk t-${b.type}${selected ? " sel" : ""}${b.hidden ? " is-hidden" : ""}${off ? " is-off" : ""}${hiddenOn ? " is-hidden" : ""}${b.locked ? " locked" : ""}`}
      style={{ gridColumn: `span ${span}` }} data-bi={bi} data-hb-block={b.id}
      draggable={!b.locked} onDragStart={startDrag({ kind: "block", id: b.id })} onDragEnd={endDrag}
      onClick={(e) => { e.stopPropagation(); select({ kind: "block", id: b.id }); }}>
      {selected && (
        <span className="hb-blk-label">{b.title ? `${b.title} · ${meta(b.type).name}` : `${meta(b.type).name} · ${b.variant}`}</span>
      )}
      {selected && (
        <div className="hb-toolbar" onClick={(e) => e.stopPropagation()}>
          <span className="hb-tb-grip" title="Sudrab ko‘chirish"><BI.grip size={14} /></span>
          <button title="Nusxa" onClick={act(() => { const c = copyBlock(b); const next = clone(layout); next.rows.splice(layout.rows.indexOf(row) + 1, 0, { id: uid("r"), blocks: [c] }); commit(next); select({ kind: "block", id: c.id }); })}><I.copy size={14} /></button>
          {b.type === "news" && <button title="Yangilikni alohida blokka chiqarish — «Sozlamalar» → Ichki elementlar" onClick={act(() => toast("Inspektorda «Ichki elementlar» ro‘yxatidan yangilikni tanlang", "info"))}><BI.extract size={14} /></button>}
          <button title={b.hidden ? "Ko‘rsatish" : "Yashirish"} onClick={act(() => commit(updateBlock(layout, b.id, (x) => ({ ...x, hidden: !x.hidden }))))}>{b.hidden ? <I.eye size={14} /> : <BI.eyeOff size={14} />}</button>
          <button title={b.locked ? "Qulfni ochish" : "Qulflash"} onClick={act(() => commit(updateBlock(layout, b.id, (x) => ({ ...x, locked: !x.locked }))))}>{b.locked ? <BI.unlock size={14} /> : <I.lock size={14} />}</button>
          <button title="O‘chirish" disabled={b.locked} onClick={act(() => { commit(removeBlock(layout, b.id)); select(null); })}><I.trash size={14} /></button>
        </div>
      )}
      <div className="hb-blk-head">
        <span className="ic"><TypeIcon type={shown.type} /></span>
        <b>{off ? blockLabel(b) : blockLabel(shown)}</b>
        <small>{shown.variant} · {span}/12</small>
      </div>
      <Thumb b={shown} />
      <div className="hb-badges">
        {sch && <span className={`hb-badge ${sch.active ? "ok" : "off"}`} title={sch.text}><BI.clock size={11} /> {scheduleText(b.schedule)}{b.schedule?.mode === "range" ? ` · ${sch.text.replace("Faol · ", "")}` : ""}</span>}
        {b.alt && <span className="hb-badge" title="Ko‘rinmaydigan vaqtda o‘rniga">↺ {blockLabel(b.alt)}</span>}
        {b.devices && !b.devices.mobile && <span className="hb-badge"><BI.phone size={11} /> yashirin</span>}
        {b.devices && !b.devices.tablet && <span className="hb-badge"><BI.tablet size={11} /> yashirin</span>}
        {b.devices && !b.devices.desktop && <span className="hb-badge"><BI.monitor size={11} /> yashirin</span>}
        {b.mobileOrder ? <span className="hb-badge"><BI.phone size={11} /> {b.mobileOrder}-o‘rin</span> : null}
        {b.hidden && <span className="hb-badge off">yashirilgan</span>}
        {b.locked && <span className="hb-badge"><I.lock size={11} /></span>}
      </div>
      {off && <div className="hb-off-note">{b.hidden ? "Yashirilgan" : "Bu vaqtda ko‘rinmaydi"}</div>}
      {resolved && resolved !== b && resolved.id !== b.id && <div className="hb-alt-note">O‘rnida: {blockLabel(resolved)}</div>}
      {selected && device === "desktop" && !b.locked && b.type !== "hero" && <span className="hb-resize" onPointerDown={resize(b, row)} title="Kenglikni o‘zgartirish" />}
    </div>
  );
}

function MobileCanvas() {
  const { layout, sel, select, now, refs } = useBuilder();
  const flat = layout.rows.flatMap((r) => r.blocks.map((b) => ({ b, rowHidden: !!r.hidden })));
  const rest = flat.filter((x) => !x.b.mobileOrder);
  const fixed = flat.filter((x) => (x.b.mobileOrder || 0) > 0).sort((a, b) => a.b.mobileOrder! - b.b.mobileOrder!);
  for (const f of fixed) rest.splice(Math.min(f.b.mobileOrder! - 1, rest.length), 0, f);
  return (
    <div className="hb-page d-mobile">
      <p className="hb-hint-m">Telefonda bloklar bitta ustunda. Tartibni blokning «Qurilmalar» bo‘limida o‘zgartiring.</p>
      {rest.map(({ b, rowHidden }, i) => {
        const hidden = (b.devices && !b.devices.mobile) || b.hidden || rowHidden;
        const resolved = resolveBlock({ ...b, hidden: false }, now, refs.matches);
        const shown = resolved || b;
        const selected = sel?.kind === "block" && (sel.id === b.id || sel.id === b.alt?.id);
        return (
          <div key={b.id} className={`hb-blk t-${shown.type}${selected ? " sel" : ""}${hidden ? " is-hidden" : ""}${!resolved ? " is-off" : ""}`} data-hb-block={b.id}
            onClick={(e) => { e.stopPropagation(); select({ kind: "block", id: b.id }); }}>
            <div className="hb-blk-head"><span className="ic"><TypeIcon type={shown.type} /></span><b>{blockLabel(shown)}</b><small>{i + 1}{b.mobileOrder ? " · qo‘lda" : ""}</small></div>
            <Thumb b={shown} />
            {hidden && <div className="hb-off-note">Mobil versiyada yashirin</div>}
            {!hidden && !resolved && <div className="hb-off-note">Bu vaqtda ko‘rinmaydi</div>}
          </div>
        );
      })}
    </div>
  );
}

function Layers() {
  const { layout, sel, select, commit } = useBuilder();
  const moveTo = (ri: number, d: number) => {
    const j = ri + d;
    if (j < 0 || j >= layout.rows.length) return;
    commit(moveRow(layout, layout.rows[ri].id, d > 0 ? j + 1 : j));
  };
  return (
    <div className="hb-layers">
      {layout.rows.map((r, ri) => (
        <div key={r.id} className="hb-layer-row">
          <div className={`hb-layer${sel?.kind === "row" && sel.id === r.id ? " sel" : ""}${r.hidden ? " is-hidden" : ""}`} onClick={() => select({ kind: "row", id: r.id })}>
            <I.table size={14} /><b className="grow">{ri + 1} · {r.blocks.length > 1 ? `${r.blocks.length} blok (${r.blocks.map((b) => b.span).join("+")})` : blockLabel(r.blocks[0])}</b>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={(e) => { e.stopPropagation(); moveTo(ri, -1); }} disabled={ri === 0} aria-label="Yuqoriga"><I.up size={14} /></button>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={(e) => { e.stopPropagation(); moveTo(ri, 1); }} disabled={ri === layout.rows.length - 1} aria-label="Pastga"><I.down size={14} /></button>
          </div>
          {r.blocks.map((b) => (
            <Fragment key={b.id}>
              <div className={`hb-layer child${sel?.kind === "block" && sel.id === b.id ? " sel" : ""}${b.hidden ? " is-hidden" : ""}`} onClick={() => select({ kind: "block", id: b.id })}>
                <TypeIcon type={b.type} /><span className="grow">{blockLabel(b)} · {b.variant}</span>
                {b.schedule && b.schedule.mode !== "always" && <BI.clock size={12} />}
                {b.locked && <I.lock size={12} />}
              </div>
              {b.alt && (
                <div className={`hb-layer child alt${sel?.kind === "block" && sel.id === b.alt.id ? " sel" : ""}`} onClick={() => select({ kind: "block", id: b.alt!.id })}>
                  ↺ <span className="grow">{blockLabel(b.alt)} (o‘rniga)</span>
                </div>
              )}
            </Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------- schematic previews ----------------

function TypeIcon({ type }: { type: ModuleType }) {
  const map: Partial<Record<ModuleType, React.ReactNode>> = {
    hero: <I.image size={14} />, intro: <I.doc size={14} />, fmatch: <I.ball size={14} />, live: <I.radio size={14} />, upcoming: <I.calendar size={14} />,
    results: <I.check size={14} />, standings: <I.table size={14} />, scorers: <I.trophy size={14} />, stats: <I.grid size={14} />, news: <I.news size={14} />,
    fnews: <I.news size={14} />, video: <I.play size={14} />, gallery: <I.camera size={14} />, social: <I.globe size={14} />, player: <I.user size={14} />,
    team: <I.shirt size={14} />, partners: <I.users size={14} />, banner: <I.image size={14} />, custom: <I.edit size={14} />, shop: <I.bag size={14} />,
  };
  return map[type] || <I.grid size={14} />;
}

function Lines({ n, w = [] }: { n: number; w?: number[] }) {
  return <>{Array.from({ length: n }, (_, i) => <i key={i} className="ln" style={{ width: `${w[i % (w.length || 1)] || 100}%` }} />)}</>;
}

function Thumb({ b }: { b: Block }) {
  const { refs } = useBuilder();
  const p = b.props || {};
  const n = (k: string, d: number) => (typeof p[k] === "number" ? (p[k] as number) : d);
  const narrow = b.variant === "compact" || b.span <= 4;
  switch (b.type) {
    case "hero":
      return <div className="hb-th dark tall"><span className="ov">HERO · BANNERLAR</span><b className="big">Bosh e’lonlar karuseli</b><Lines n={1} w={[40]} /></div>;
    case "intro":
      return <div className="hb-th split"><b>{(p.title as string) || "United MFL — media futbol ligasi"}</b><div><Lines n={3} w={[100, 90, 60]} /></div></div>;
    case "fmatch": {
      const m = refs.matches.find((x) => x.id === p.matchId);
      return <div className="hb-th match"><span className="cr" /><b className="big">{m ? `${m.home?.name || "?"} — ${m.away?.name || "?"}` : "2 : 1"}</b><span className="cr" /></div>;
    }
    case "live": case "upcoming": case "results": {
      const c = Math.min(n("count", 3), narrow ? 4 : 4);
      return narrow
        ? <div className="hb-th list">{Array.from({ length: c }, (_, i) => <div key={i} className="li"><span className="cr s" /><Lines n={2} w={[70, 55]} /></div>)}</div>
        : <div className="hb-th cards" style={{ ["--c" as string]: Math.min(c, Math.max(1, Math.floor(b.span / 3))) }}>{Array.from({ length: Math.min(c, Math.max(1, Math.floor(b.span / 3))) }, (_, i) => <div key={i} className="cd"><Lines n={3} w={[60, 80, 40]} /></div>)}</div>;
    }
    case "standings": {
      const g = refs.groups.find((x) => x.code === p.group);
      return <div className="hb-th table"><span className="ov">{p.group === "all" ? "BARCHA GURUHLAR" : (g?.name || "1-GURUH").toUpperCase()}</span>{Array.from({ length: narrow ? 4 : 5 }, (_, i) => <div key={i} className="tr"><span className="cr s" /><i className="ln" /><i className="num" /></div>)}</div>;
    }
    case "scorers":
      return <div className="hb-th list">{Array.from({ length: Math.min(n("count", 5), 5) }, (_, i) => <div key={i} className="li"><em>{i + 1}</em><Lines n={1} w={[70]} /><i className="num" /></div>)}</div>;
    case "stats":
      return <div className={`hb-th nums${b.span >= 8 ? " row3" : ""}`}><b>49</b><b>4,9</b><b>23</b></div>;
    case "news":
      return b.variant === "featured" && !narrow
        ? <div className="hb-th news"><span className="img" /><div>{Array.from({ length: Math.min(n("count", 5) - 1, 4) }, (_, i) => <div key={i} className="li"><span className="img s" /><Lines n={2} w={[90, 60]} /></div>)}</div></div>
        : <div className="hb-th list">{Array.from({ length: Math.min(n("count", 5), narrow ? 4 : 3) }, (_, i) => <div key={i} className="li"><span className="img s" /><Lines n={2} w={[90, 60]} /></div>)}</div>;
    case "fnews": {
      const it = refs.news.find((x) => x.slug === p.slug);
      return <div className="hb-th fnews"><span className="img" /><div><span className="ov">{it?.category || "YANGILIK"}</span><b>{it?.title || "Eng so‘nggi yangilik"}</b><Lines n={2} w={[90, 70]} /></div></div>;
    }
    case "video": case "shop": case "gallery": case "social": {
      const c = Math.max(1, Math.min(n("count", 3), b.span >= 8 ? 4 : narrow ? 2 : 3));
      return <div className={`hb-th tiles t-${b.type}`} style={{ ["--c" as string]: c }}>{Array.from({ length: c }, (_, i) => <span key={i} className="img">{b.type === "video" && <I.play size={14} />}</span>)}</div>;
    }
    case "player": case "team": {
      const t = refs.teams.find((x) => x.slug === p.slug);
      return <div className="hb-th spot"><span className="av" /><div><b>{b.type === "team" ? t?.name || "Jamoa" : "O‘yinchi"}</b><Lines n={2} w={[60, 40]} /></div></div>;
    }
    case "partners": {
      const items = Array.isArray(p.items) ? (p.items as { name?: string }[]) : [];
      return <div className="hb-th partners">{items.slice(0, 5).map((x, i) => <span key={i}>{x.name || "Logo"}</span>)}{p.cta !== false && <span className="muted">+ Brend</span>}</div>;
    }
    case "banner":
      return <div className="hb-th dark banner" style={p.image ? { backgroundImage: `linear-gradient(90deg, rgba(11,13,16,.85), rgba(11,13,16,.3)), url("${p.image as string}")` } : undefined}><span className="ov">{(p.eyebrow as string) || "BANNER"}</span><b className="big">{(p.title as string) || "Sarlavha"}</b>{p.ctaLabel ? <span className="cta">{p.ctaLabel as string}</span> : null}</div>;
    case "custom":
      return <div className="hb-th text"><b>{b.title || "Matn bloki"}</b><p>{((p.text as string) || "Matn…").slice(0, 140)}</p></div>;
  }
  return <div className="hb-th"><Lines n={3} /></div>;
}
