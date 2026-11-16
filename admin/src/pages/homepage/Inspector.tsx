import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { I } from "@/components/Icons";
import { ImageInput } from "@/components/ui";
import { api } from "@/lib/api";
import {
  DAYS, MODULES, PRESETS, VARIANTS, applyPreset, blockLabel, clone, copyBlock, findBlock, fitRow, meta, newBlock, removeBlock,
  rowSum, scheduleState, toLocal, uid, updateBlock, updateRow, type Block, type ModuleType, type Row, type Schedule,
} from "@/lib/layout";
import { BI, F, Seg, Switch, useBuilder } from "./shared";

type Tab = 0 | 1 | 2 | 3;

export function Inspector() {
  const { sel, layout } = useBuilder();
  if (!sel) return <EmptyInspector />;
  if (sel.kind === "row") {
    const ri = layout.rows.findIndex((r) => r.id === sel.id);
    if (ri < 0) return <EmptyInspector />;
    return <RowInspector row={layout.rows[ri]} index={ri} />;
  }
  const f = findBlock(layout, sel.id);
  if (!f) return <EmptyInspector />;
  return <BlockInspector key={f.block.id} block={f.block} parent={f.alt ? f.row.blocks[f.bi] : null} rowSpan={rowSum(f.row)} />;
}

function EmptyInspector() {
  return (
    <div className="hb-insp-empty">
      <BI.layers size={28} />
      <b>Blok yoki qatorni tanlang</b>
      <p>Kanvasdagi blokni bosing — sozlamalar shu yerda chiqadi. Qator raqamini bossangiz, qator sozlamalari ochiladi.</p>
      <p className="muted small">Modulni chap paneldan kanvasga sudrang. Ctrl+Z — bekor qilish, Delete — o‘chirish.</p>
    </div>
  );
}

// ---------------- block ----------------

function BlockInspector({ block: b, parent, rowSpan }: { block: Block; parent: Block | null; rowSpan: number }) {
  const { layout, commit, select, toast } = useBuilder();
  const [tab, setTab] = useState<Tab>(0);
  const m = meta(b.type);
  const set = (patch: Partial<Block>) => commit(updateBlock(layout, b.id, (x) => ({ ...x, ...patch })));
  const setProps = (patch: Record<string, unknown>) => commit(updateBlock(layout, b.id, (x) => ({ ...x, props: { ...(x.props || {}), ...patch } })));
  const isAlt = !!parent;
  const free = 12 - rowSpan + b.span; // widest span that still fits in the row
  const tabs = isAlt ? ["Sozlamalar", "Ko‘rinish"] : ["Sozlamalar", "Ko‘rinish", "Qurilmalar", "Vaqt"];

  const duplicate = () => {
    const f = findBlock(layout, b.id);
    if (!f || f.alt) return;
    const next = clone(layout);
    const row = next.rows[f.ri];
    const c = copyBlock(b);
    if (row.blocks.length < 4 && rowSum(row) + c.span <= 12 && b.type !== "hero") row.blocks.splice(f.bi + 1, 0, c);
    else next.rows.splice(f.ri + 1, 0, { id: uid("r"), blocks: [c] });
    commit(next);
    select({ kind: "block", id: c.id });
  };
  const remove = () => {
    if (b.locked) return toast("Blok qulflangan", "error");
    if (isAlt) {
      commit(updateBlock(layout, parent!.id, (x) => ({ ...x, alt: undefined, schedule: x.schedule ? { ...x.schedule, onEnd: "hide" } : x.schedule })));
      select({ kind: "block", id: parent!.id });
      return;
    }
    commit(removeBlock(layout, b.id));
    select(null);
  };

  return (
    <>
      <div className="hb-insp-head">
        <div className="row" style={{ gap: 8 }}>
          <span className="hb-chip"><I.grid size={12} /> {m.name} · {VARIANTS.find((v) => v.key === b.variant)?.label}</span>
          <span className="grow" />
          {b.locked && <span className="badge plain" title="Qulflangan"><I.lock size={12} /></span>}
        </div>
        <h3>{blockLabel(b)}</h3>
        {isAlt && (
          <button className="hb-back" onClick={() => select({ kind: "block", id: parent!.id })}>
            ← {blockLabel(parent!)} o‘rnini bosuvchi blok
          </button>
        )}
        <div className="tabs hb-tabs" role="tablist">
          {tabs.map((t, i) => <button key={t} role="tab" aria-selected={tab === i} onClick={() => setTab(i as Tab)}>{t}{i === 3 && b.schedule && b.schedule.mode !== "always" && <i className="hb-dot" />}</button>)}
        </div>
      </div>
      <div className="hb-insp-body">
        {tab === 0 && (
          <>
            <F label="Variant">
              <div className="hb-variants">
                {VARIANTS.map((v) => (
                  <button key={v.key} type="button" className={`hb-variant v-${v.key}`} aria-pressed={b.variant === v.key} onClick={() => set({ variant: v.key })}>
                    <span className="hb-variant-pic"><i /><i /><i /></span>{v.label}
                  </button>
                ))}
              </div>
            </F>
            {!isAlt && (
              <F label="Kenglik" value={`${b.span} / 12 ustun`} hint={free < 12 && m.spans.some((s) => s > free) ? "Kengroq qilish uchun qatordagi boshqa blokni toraytiring yoki uni yangi qatorga oling." : undefined}>
                <div className="hb-span" role="group" aria-label="Kenglik">
                  {Array.from({ length: 12 }, (_, i) => <i key={i} className={i < b.span ? "on" : ""} />)}
                </div>
                <Seg full value={b.span} onChange={(v) => set({ span: v })}
                  options={m.spans.map((s) => ({ key: s, label: s, disabled: s > free, title: s > free ? "Qatorda joy yo‘q" : `${s} ustun` }))} />
              </F>
            )}
            <PropsEditor b={b} setProps={setProps} set={set} />
          </>
        )}
        {tab === 1 && <LookTab b={b} set={set} />}
        {tab === 2 && !isAlt && <DevicesTab b={b} set={set} />}
        {tab === 3 && !isAlt && <ScheduleTab b={b} />}
      </div>
      <div className="hb-insp-foot">
        {!isAlt && <button className="btn btn-sm" onClick={duplicate}><I.copy size={14} /> Nusxa</button>}
        {!isAlt && <button className="btn btn-sm" onClick={() => set({ hidden: !b.hidden })}>{b.hidden ? <><I.eye size={14} /> Ko‘rsatish</> : <><BI.eyeOff size={14} /> Yashirish</>}</button>}
        {!isAlt && <button className="btn btn-sm" onClick={() => set({ locked: !b.locked })}>{b.locked ? <><BI.unlock size={14} /> Qulfni ochish</> : <><I.lock size={14} /> Qulflash</>}</button>}
        <button className="btn btn-sm btn-danger" onClick={remove} disabled={b.locked}><I.trash size={14} /> O‘chirish</button>
      </div>
    </>
  );
}

function LookTab({ b, set }: { b: Block; set: (p: Partial<Block>) => void }) {
  const m = meta(b.type);
  const noHead = b.type === "hero" || b.type === "intro" || b.type === "banner";
  return (
    <>
      {!noHead && (
        <>
          <F label="Sarlavha" hint="Bo‘sh qoldirilsa, modul nomi ishlatiladi.">
            <input className="input input-sm" value={b.title || ""} placeholder={defaultTitle(b.type) || m.name} maxLength={120} onChange={(e) => set({ title: e.target.value || undefined })} />
          </F>
          <Switch label="Sarlavhani yashirish" checked={!!b.hideTitle} onChange={(v) => set({ hideTitle: v || undefined })} />
          <F label="«Barchasi» havolasi">
            <div className="hb-2">
              <input className="input input-sm" value={b.linkLabel || ""} placeholder="Matn" maxLength={40} onChange={(e) => set({ linkLabel: e.target.value || undefined })} />
              <input className="input input-sm" value={b.linkHref || ""} placeholder="/matchlar" maxLength={500} onChange={(e) => set({ linkHref: e.target.value || undefined })} />
            </div>
          </F>
        </>
      )}
      {b.type !== "hero" && b.type !== "intro" && (
        <F label="Blok foni">
          <Seg full value={b.bg || ""} onChange={(v) => set({ bg: (v || undefined) as Block["bg"] })} options={[{ key: "", label: "Yo‘q" }, { key: "subtle", label: "Kulrang" }, { key: "dark", label: "Qora" }]} />
        </F>
      )}
      {noHead && <p className="muted small">Bu modulning ko‘rinishi «Sozlamalar» bo‘limida sozlanadi.</p>}
    </>
  );
}

const defaultTitle = (t: ModuleType) => ({ fmatch: "Asosiy match", live: "Jonli", upcoming: "Matchlar", results: "So‘nggi natijalar", standings: "Turnir jadvali", scorers: "To‘purarlar", stats: "Raqamlarda", news: "Yangiliklar", video: "Video", gallery: "Foto", social: "Ijtimoiy tarmoqlar", player: "O‘yinchi", team: "Jamoa", partners: "Hamkorlar", shop: "Rasmiy do‘kon" } as Record<string, string>)[t];

function DevicesTab({ b, set }: { b: Block; set: (p: Partial<Block>) => void }) {
  const d = b.devices || { desktop: true, tablet: true, mobile: true };
  const put = (k: keyof typeof d, v: boolean) => {
    const next = { ...d, [k]: v };
    set({ devices: next.desktop && next.tablet && next.mobile ? undefined : next });
  };
  return (
    <>
      {([["desktop", "Desktop · 1440", BI.monitor], ["tablet", "Tablet · 768", BI.tablet], ["mobile", "Mobile · 390", BI.phone]] as const).map(([k, label, Ic]) => (
        <label key={k} className="hb-device">
          <Ic size={18} />
          <span className="grow"><b>{label}</b><small className={d[k] ? "" : "danger"}>{d[k] ? "Ko‘rsatiladi" : "Yashirin"}</small></span>
          <input type="checkbox" className="switch" checked={d[k]} onChange={(e) => put(k, e.target.checked)} />
        </label>
      ))}
      <F label="Mobil versiyada tartib" value={b.mobileOrder ? `${b.mobileOrder}-o‘rin` : "Avtomatik"} hint="Telefonda bloklar bitta ustunga tushadi. Raqam bersangiz, blok shu o‘ringa chiqadi (1 — eng yuqori).">
        <div className="hb-2">
          <input className="input input-sm" type="number" min={0} max={99} value={b.mobileOrder || ""} placeholder="Avtomatik" onChange={(e) => set({ mobileOrder: Math.max(0, Math.min(99, Number(e.target.value) || 0)) || undefined })} />
          <button className="btn btn-sm" onClick={() => set({ mobileOrder: undefined })} disabled={!b.mobileOrder}>Avtomatik</button>
        </div>
      </F>
    </>
  );
}

// ---------------- schedule ----------------

const BEFORE = [30, 60, 180, 1440];
const AFTER = [0, 60, 120, 1440];
const minLabel = (m: number) => (m === 1440 ? "Kun bo‘yi" : m === 0 ? "Darhol" : m < 60 ? `${m} daq` : `${m / 60} soat`);

function ScheduleTab({ b }: { b: Block }) {
  const { layout, commit, select, refs, now } = useBuilder();
  const s: Schedule = b.schedule || { mode: "always" };
  const put = (patch: Partial<Schedule>) => {
    const next = { ...s, ...patch };
    commit(updateBlock(layout, b.id, (x) => ({ ...x, schedule: next.mode === "always" ? undefined : next, alt: next.mode === "always" ? undefined : x.alt })));
  };
  const setMode = (mode: Schedule["mode"]) => {
    if (mode === s.mode) return;
    const base: Schedule = { mode, onEnd: s.onEnd };
    if (mode === "range") Object.assign(base, { start: toLocal(Date.now()), end: toLocal(Date.now() + 7 * 86400_000).slice(0, 11) + "23:59" });
    if (mode === "weekly") Object.assign(base, { days: [5, 6], from: "18:00", to: "23:00" });
    if (mode === "match") Object.assign(base, { before: 60, after: 120 });
    // a new mode starts clean (no leftover fields of the old one)
    commit(updateBlock(layout, b.id, (x) => ({ ...x, schedule: mode === "always" ? undefined : base, alt: mode === "always" ? undefined : x.alt })));
  };
  const setAlt = (type: ModuleType | "") => {
    commit(updateBlock(layout, b.id, (x) => {
      if (!type) return { ...x, alt: undefined, schedule: { ...s, onEnd: "hide" } };
      const alt = x.alt && x.alt.type === type ? x.alt : { ...newBlock(type), span: 0, variant: x.variant };
      return { ...x, alt, schedule: { ...s, onEnd: "replace" } };
    }));
  };
  const endTs = () => (s.end ? Date.parse(`${s.end}:00+05:00`) : Date.now());
  const quick = (ms: number) => put({ end: toLocal(Math.max(Date.now(), endTs()) + ms) });
  const finalMatch = refs.matches.filter((m) => m.status === "scheduled").sort((x, y) => Date.parse(y.kickoff_at) - Date.parse(x.kickoff_at))[0];
  const st = scheduleState(s, now, refs.matches);

  return (
    <>
      <F label="Ko‘rsatish rejimi">
        <Seg full value={s.mode} onChange={setMode} options={[{ key: "always", label: "Doim" }, { key: "range", label: "Muddat" }, { key: "weekly", label: "Takroriy" }, { key: "match", label: "Matchga" }]} />
      </F>
      {s.mode === "always" && <p className="muted small">Blok har doim ko‘rinadi. Muayyan sanagacha, haftaning kunlarida yoki faqat match paytida ko‘rsatish uchun rejimni tanlang.</p>}

      {s.mode === "range" && (
        <>
          <F label="Boshlanishi" hint="Bo‘sh — darhol.">
            <div className="hb-2"><input className="input input-sm" type="datetime-local" value={s.start || ""} onChange={(e) => put({ start: e.target.value || undefined })} />
              <button className="btn btn-sm" onClick={() => put({ start: undefined })} disabled={!s.start}>Hozirdan</button></div>
          </F>
          <F label="Tugashi" hint="Bo‘sh — muddatsiz.">
            <div className="hb-2"><input className="input input-sm" type="datetime-local" value={s.end || ""} onChange={(e) => put({ end: e.target.value || undefined })} />
              <button className="btn btn-sm" onClick={() => put({ end: undefined })} disabled={!s.end}>Muddatsiz</button></div>
          </F>
          <div className="hb-pills">
            <button className="hb-pill" onClick={() => quick(86400_000)}>+1 kun</button>
            <button className="hb-pill" onClick={() => quick(7 * 86400_000)}>+1 hafta</button>
            {finalMatch && <button className="hb-pill" title="Oxirgi rejalashtirilgan match kuni oxirigacha" onClick={() => put({ end: toLocal(Date.parse(finalMatch.kickoff_at)).slice(0, 11) + "23:59" })}>So‘nggi match kunigacha</button>}
          </div>
        </>
      )}

      {s.mode === "weekly" && (
        <>
          <F label="Kunlar">
            <div className="hb-days">
              {DAYS.map((d, i) => {
                const on = (s.days || []).includes(i);
                return <button key={d} type="button" aria-pressed={on} onClick={() => put({ days: on ? (s.days || []).filter((x) => x !== i) : [...(s.days || []), i].sort() })}>{d}</button>;
              })}
            </div>
          </F>
          <F label="Vaqt oralig‘i" hint="Masalan, 22:00 — 02:00 kechasi ham ishlaydi.">
            <div className="hb-2">
              <input className="input input-sm" type="time" value={s.from || ""} onChange={(e) => put({ from: e.target.value })} />
              <input className="input input-sm" type="time" value={s.to || ""} onChange={(e) => put({ to: e.target.value })} />
            </div>
          </F>
        </>
      )}

      {s.mode === "match" && (
        <>
          <p className="muted small" style={{ margin: 0 }}>Blok mavsumning har bir matchi atrofida ko‘rinadi: jonli match paytida doim.</p>
          <F label="Ko‘rsatishni boshlash" hint="match boshlanishidan oldin">
            <Seg full value={s.before ?? 60} onChange={(v) => put({ before: v })} options={BEFORE.map((m) => ({ key: m, label: minLabel(m) }))} />
          </F>
          <F label="Yashirish" hint="hakam hushtagidan keyin">
            <Seg full value={s.after ?? 120} onChange={(v) => put({ after: v })} options={AFTER.map((m) => ({ key: m, label: m === 0 ? "Darhol" : m === 1440 ? "Kun oxiri" : `+${m / 60} soat` }))} />
          </F>
        </>
      )}

      {s.mode !== "always" && (
        <>
          <F label="Vaqt mintaqasi"><div className="input input-sm hb-static">Toshkent (UTC+5)</div></F>
          <F label={s.mode === "match" ? "Matchlar bo‘lmaganda" : "Ko‘rinmaydigan vaqtda"}>
            <Seg full value={s.onEnd === "replace" ? "replace" : "hide"} onChange={(v) => setAlt(v === "replace" ? (b.alt?.type || "partners") : "")} options={[{ key: "hide", label: "Yashirish" }, { key: "replace", label: "Almashtirish" }]} />
            {s.onEnd === "replace" && (
              <div className="hb-2" style={{ marginTop: 8 }}>
                <select className="select input-sm" value={b.alt?.type || ""} onChange={(e) => setAlt(e.target.value as ModuleType)}>
                  {MODULES.filter((x) => x.type !== "hero" && x.type !== "intro").map((x) => <option key={x.type} value={x.type}>{x.name}</option>)}
                </select>
                {b.alt && <button className="btn btn-sm" onClick={() => select({ kind: "block", id: b.alt!.id })}>Sozlash</button>}
              </div>
            )}
          </F>
          <div className={`hb-status ${st.active ? "on" : "off"}`}>
            <i />
            <div><b>{st.text}</b><small>{st.active ? "Jadval o‘z-o‘zidan ishlaydi — qayta nashr qilish shart emas." : s.onEnd === "replace" && b.alt ? `Hozir o‘rnida «${blockLabel(b.alt)}» ko‘rinadi.` : "Hozir saytda ko‘rinmaydi."}</small></div>
          </div>
        </>
      )}
    </>
  );
}

// ---------------- module settings ----------------

function Count({ value, onChange, min = 1, max = 12, label = "Elementlar soni" }: { value: unknown; onChange: (n: number) => void; min?: number; max?: number; label?: string }) {
  const n = typeof value === "number" ? value : min;
  return (
    <F label={label} value={n}>
      <input type="range" className="hb-range" min={min} max={max} value={n} onChange={(e) => onChange(Number(e.target.value))} />
    </F>
  );
}

function PropsEditor({ b, setProps, set }: { b: Block; setProps: (p: Record<string, unknown>) => void; set: (p: Partial<Block>) => void }) {
  const { refs, layout, commit, select, toast } = useBuilder();
  const p = b.props || {};
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  const text = (k: string, label: string, ph = "", max = 200) => (
    <F label={label}><input className="input input-sm" value={str(k)} placeholder={ph} maxLength={max} onChange={(e) => setProps({ [k]: e.target.value })} /></F>
  );

  switch (b.type) {
    case "hero":
      return <p className="hb-note">Slaydlar «Hero-bannerlar» bo‘limida boshqariladi. <Link to="/banners">Bannerlarni ochish →</Link></p>;
    case "intro":
      return (
        <>
          {text("title", "Sarlavha (H1)", "United MFL — media futbol ligasi", 120)}
          <F label="Matn" hint="Bo‘sh — avtomatik matn (mavsum, jamoalar soni va bo‘limlarga havolalar)."><textarea className="textarea" rows={4} value={str("text")} maxLength={600} onChange={(e) => setProps({ text: e.target.value })} /></F>
        </>
      );
    case "fmatch":
      return (
        <F label="Match" hint="Avtomatik: jonli → keyingi → so‘nggi o‘ynalgan.">
          <select className="select input-sm" value={String(p.matchId || 0)} onChange={(e) => setProps({ matchId: Number(e.target.value) })}>
            <option value="0">Avtomatik</option>
            {refs.matches.map((m) => <option key={m.id} value={m.id}>{matchName(m)}</option>)}
          </select>
        </F>
      );
    case "live":
      return <Count value={p.count} max={8} onChange={(n) => setProps({ count: n })} />;
    case "upcoming":
      return (
        <>
          <Count value={p.count} onChange={(n) => setProps({ count: n })} />
          <Switch label="Jonli matchlar boshida" checked={p.withLive !== false} onChange={(v) => setProps({ withLive: v })} />
          <Switch label="Natijalarni ham qo‘shish" hint="Yaqin matchlar kam bo‘lsa, so‘nggi natijalar bilan to‘ldiriladi" checked={!!p.withResults} onChange={(v) => setProps({ withResults: v })} />
        </>
      );
    case "results":
    case "video":
    case "shop":
      return <Count value={p.count} onChange={(n) => setProps({ count: n })} />;
    case "scorers":
      return <Count value={p.count} max={20} onChange={(n) => setProps({ count: n })} />;
    case "stats":
      return <Count label="To‘purarlar ro‘yxati" min={0} max={10} value={p.scorers ?? 0} onChange={(n) => setProps({ scorers: n })} />;
    case "standings":
      return (
        <F label="Guruh">
          <select className="select input-sm" value={str("group")} onChange={(e) => setProps({ group: e.target.value })}>
            <option value="">Birinchi guruh</option>
            <option value="all">Barcha guruhlar</option>
            {refs.groups.map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}
          </select>
        </F>
      );
    case "news": {
      const cats = [...new Set(refs.news.map((n) => n.category).filter(Boolean))];
      const shown = refs.news.filter((n) => !str("category") || n.category === str("category")).slice(0, typeof p.count === "number" ? p.count : 5);
      const extract = (n: (typeof refs.news)[number]) => {
        const f = findBlock(layout, b.id);
        if (!f) return;
        const fb = { ...newBlock("fnews", 8), props: { slug: n.slug } };
        const next = clone(layout);
        next.rows.splice(f.ri, 0, { id: uid("r"), blocks: [fb] });
        commit(next);
        select({ kind: "block", id: fb.id });
        toast("Yangilik alohida blokka chiqarildi", "ok");
      };
      return (
        <>
          <Count value={p.count} onChange={(n) => setProps({ count: n })} />
          <F label="Rukn">
            <select className="select input-sm" value={str("category")} onChange={(e) => setProps({ category: e.target.value })}>
              <option value="">Barcha ruknlar</option>
              {cats.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </F>
          <F label="Ichki elementlar" hint="↗ — yangilikni alohida katta blokka chiqarish (Featured News). Lentada u takrorlanmaydi.">
            <div className="hb-items">
              {shown.map((n) => (
                <div key={n.slug} className="hb-item">
                  <I.news size={14} /><span className="grow">{n.title}</span>
                  <button className="btn btn-ghost btn-sm btn-icon" title="Alohida blokka chiqarish" onClick={() => extract(n)}><BI.extract size={14} /></button>
                </div>
              ))}
              {!shown.length && <span className="muted small">Yangiliklar yo‘q</span>}
            </div>
          </F>
        </>
      );
    }
    case "fnews":
      return (
        <F label="Yangilik" hint="Avtomatik — eng so‘nggi yangilik.">
          <select className="select input-sm" value={str("slug")} onChange={(e) => setProps({ slug: e.target.value })}>
            <option value="">Avtomatik (so‘nggi)</option>
            {refs.news.map((n) => <option key={n.slug} value={n.slug}>{n.title}</option>)}
          </select>
        </F>
      );
    case "gallery":
      return (
        <>
          <F label="Match" hint="Avtomatik — fotolari bor so‘nggi match.">
            <select className="select input-sm" value={String(p.matchId || 0)} onChange={(e) => setProps({ matchId: Number(e.target.value) })}>
              <option value="0">Avtomatik</option>
              {refs.matches.filter((m) => m.status === "finished").map((m) => <option key={m.id} value={m.id}>{matchName(m)}</option>)}
            </select>
          </F>
          <Count label="Fotolar soni" value={p.count} onChange={(n) => setProps({ count: n })} />
        </>
      );
    case "social":
      return (
        <>
          <Count label="Instagram postlari" min={0} value={p.count ?? 6} onChange={(n) => setProps({ count: n })} />
          <Switch label="Ijtimoiy tarmoq tugmalari" checked={p.links !== false} onChange={(v) => setProps({ links: v })} />
        </>
      );
    case "player":
      return <PlayerPick value={Number(p.playerId) || 0} onChange={(id) => setProps({ playerId: id })} label={str("label")} setLabel={(v) => setProps({ label: v })} />;
    case "team":
      return (
        <F label="Jamoa">
          <select className="select input-sm" value={str("slug")} onChange={(e) => setProps({ slug: e.target.value })}>
            <option value="">Birinchi jamoa</option>
            {refs.teams.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
          </select>
        </F>
      );
    case "partners":
      return <PartnersEditor b={b} setProps={setProps} />;
    case "banner":
      return (
        <>
          {text("eyebrow", "Ustki yozuv", "REKLAMA · HAMKOR", 60)}
          {text("title", "Sarlavha", "Finalga chiptalar sotuvda", 120)}
          <F label="Matn"><textarea className="textarea" rows={2} value={str("text")} maxLength={300} onChange={(e) => setProps({ text: e.target.value })} /></F>
          <F label="Rasm (desktop)"><ImageInput wide value={str("image")} onChange={(v) => setProps({ image: v })} /></F>
          <F label="Rasm (telefon, ixtiyoriy)"><ImageInput value={str("imageMobile")} onChange={(v) => setProps({ imageMobile: v })} /></F>
          <div className="hb-2">{text("ctaLabel", "Tugma", "Chipta olish", 40)}{text("ctaUrl", "Havola", "https://…", 500)}</div>
        </>
      );
    case "custom":
      return (
        <>
          <p className="muted small" style={{ margin: 0 }}>Sarlavha — «Ko‘rinish» bo‘limida.</p>
          <F label="Matn" hint="Bo‘sh qator — yangi xatboshi."><textarea className="textarea" rows={6} value={str("text")} maxLength={4000} onChange={(e) => setProps({ text: e.target.value })} /></F>
          <F label="Rasm"><ImageInput wide value={str("image")} onChange={(v) => setProps({ image: v })} /></F>
          <div className="hb-2">{text("ctaLabel", "Tugma", "Batafsil", 40)}{text("ctaUrl", "Havola", "/biz-haqimizda", 500)}</div>
        </>
      );
  }
  void set;
  return null;
}

const matchName = (m: { round: string; home: { name: string } | null; away: { name: string } | null; kickoff_at: string }) =>
  `${m.home?.name || "?"} — ${m.away?.name || "?"} · ${m.kickoff_at ? new Date(m.kickoff_at).toLocaleDateString("uz-UZ", { day: "numeric", month: "short", timeZone: "Asia/Tashkent" }) : ""}`;

function PlayerPick({ value, onChange, label, setLabel }: { value: number; onChange: (id: number) => void; label: string; setLabel: (v: string) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<{ id: number; full_name: string }[]>([]);
  const [name, setName] = useState("");
  useEffect(() => {
    if (!value) return setName("");
    api.get<{ id: number; full_name: string }>(`/admin/players/${value}`).then((p) => setName(p.full_name)).catch(() => setName(`#${value}`));
  }, [value]);
  useEffect(() => {
    if (q.trim().length < 2) return setList([]);
    const t = setTimeout(() => api.get<{ items: { id: number; full_name: string }[] }>(`/admin/players?q=${encodeURIComponent(q.trim())}&limit=8`).then((r) => setList(r.items)).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <>
      <F label="O‘yinchi" value={value ? name : "Avtomatik"} hint="Avtomatik — eng ko‘p gol urgan o‘yinchi.">
        <div className="hb-2">
          <input className="input input-sm" value={q} placeholder="Ism bo‘yicha qidirish" onChange={(e) => setQ(e.target.value)} />
          <button className="btn btn-sm" disabled={!value} onClick={() => onChange(0)}>Avtomatik</button>
        </div>
        {list.length > 0 && (
          <div className="hb-items" style={{ marginTop: 6 }}>
            {list.map((p) => <button key={p.id} className="hb-item" onClick={() => { onChange(p.id); setQ(""); setList([]); }}><I.user size={14} /><span className="grow">{p.full_name}</span></button>)}
          </div>
        )}
      </F>
      <F label="Sarlavha ustidagi yozuv"><input className="input input-sm" value={label} placeholder="Masalan: Tur o‘yinchisi" maxLength={60} onChange={(e) => setLabel(e.target.value)} /></F>
    </>
  );
}

type Partner = { name?: string; logo?: string; url?: string };
function PartnersEditor({ b, setProps }: { b: Block; setProps: (p: Record<string, unknown>) => void }) {
  const items = useMemo(() => (Array.isArray(b.props?.items) ? (b.props!.items as Partner[]) : []), [b.props]);
  const put = (list: Partner[]) => setProps({ items: list });
  const edit = (i: number, patch: Partner) => put(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const l = items.slice();
    [l[i], l[j]] = [l[j], l[i]];
    put(l);
  };
  return (
    <>
      <F label="Hamkorlar" value={items.length}>
        <div className="stack" style={{ gap: 10 }}>
          {items.map((it, i) => (
            <div key={i} className="hb-partner">
              <div className="hb-2">
                <input className="input input-sm" value={it.name || ""} placeholder="Nomi" maxLength={60} onChange={(e) => edit(i, { name: e.target.value })} />
                <div className="row" style={{ gap: 2 }}>
                  <button className="btn btn-ghost btn-sm btn-icon" title="Yuqoriga" onClick={() => move(i, -1)} disabled={i === 0}><I.up size={14} /></button>
                  <button className="btn btn-ghost btn-sm btn-icon" title="Pastga" onClick={() => move(i, 1)} disabled={i === items.length - 1}><I.down size={14} /></button>
                  <button className="btn btn-ghost btn-sm btn-icon" title="O‘chirish" onClick={() => put(items.filter((_, j) => j !== i))}><I.trash size={14} /></button>
                </div>
              </div>
              <input className="input input-sm" value={it.url || ""} placeholder="Sayt havolasi (ixtiyoriy)" maxLength={500} onChange={(e) => edit(i, { url: e.target.value })} />
              <ImageInput value={it.logo || ""} onChange={(v) => edit(i, { logo: v })} />
            </div>
          ))}
          <button className="btn btn-sm" onClick={() => put([...items, { name: "" }])} disabled={items.length >= 24}><I.plus size={14} /> Hamkor qo‘shish</button>
        </div>
      </F>
      <Switch label="«+ Sizning brendingiz» kartasi" checked={b.props?.cta !== false} onChange={(v) => setProps({ cta: v })} />
    </>
  );
}

// ---------------- row ----------------

function RowInspector({ row, index }: { row: Row; index: number }) {
  const { layout, commit, select, toast } = useBuilder();
  const set = (patch: Partial<Row>) => commit(updateRow(layout, row.id, (r) => ({ ...r, ...patch })));
  const preset = PRESETS.find((p) => p.spans.length === row.blocks.length && p.spans.every((s, i) => row.blocks[i].span === s))?.key || "";
  const hero = row.blocks.some((b) => b.type === "hero");
  const next = layout.rows[index + 1];

  const ungroup = () => {
    const l = clone(layout);
    const r = l.rows[index];
    const rows: Row[] = r.blocks.map((b, i) => ({ ...(i === 0 ? r : { id: uid("r") }), blocks: [b] }));
    l.rows.splice(index, 1, ...rows);
    commit(l);
    toast(`${rows.length} ta alohida qator`, "ok");
  };
  const merge = () => {
    if (!next) return;
    if (row.blocks.length + next.blocks.length > 4 || hero || next.blocks.some((b) => b.type === "hero")) return toast("Birlashtirib bo‘lmaydi: qatorda ko‘pi bilan 4 blok, Hero alohida turadi", "error");
    const l = clone(layout);
    const merged = fitRow({ ...l.rows[index], blocks: [...l.rows[index].blocks, ...l.rows[index + 1].blocks] });
    l.rows.splice(index, 2, merged);
    commit(l);
  };
  const dupRow = () => {
    const l = clone(layout);
    l.rows.splice(index + 1, 0, { ...clone(row), id: uid("r"), blocks: row.blocks.map(copyBlock) });
    commit(l);
  };
  const delRow = () => {
    if (row.blocks.some((b) => b.locked)) return toast("Qatorda qulflangan blok bor", "error");
    commit({ ...layout, rows: layout.rows.filter((r) => r.id !== row.id) });
    select(null);
  };

  return (
    <>
      <div className="hb-insp-head">
        <span className="overline-s">QATOR</span>
        <h3>{index + 1} · {row.blocks.map((b) => blockLabel(b)).join(" + ")}</h3>
      </div>
      <div className="hb-insp-body">
        <F label="Ustunlar" hint={hero ? "Hero qatori doim to‘liq kenglikda." : row.blocks.length < 4 ? "Ko‘proq ustun uchun qatorga yana blok sudrang." : undefined}>
          <div className="hb-presets">
            {PRESETS.map((p) => (
              <button key={p.key} type="button" aria-pressed={preset === p.key} disabled={hero || p.spans.length !== row.blocks.length} onClick={() => commit(applyPreset(layout, row.id, p.spans))} title={p.key}>
                <span>{p.spans.map((s, i) => <i key={i} style={{ flex: s }} />)}</span>{p.key}
              </button>
            ))}
          </div>
        </F>
        <F label="Bloklar orasidagi masofa" value={`${row.gap || 24} px`}>
          <Seg full value={row.gap || 24} onChange={(v) => set({ gap: v === 24 ? undefined : v })} options={[16, 24, 40, 64].map((g) => ({ key: g, label: g }))} />
        </F>
        <F label="Qator foni">
          <Seg full value={row.bg || ""} onChange={(v) => set({ bg: (v || undefined) as Row["bg"] })} options={[{ key: "", label: "Yo‘q" }, { key: "subtle", label: "Kulrang" }, { key: "dark", label: "Qora" }]} />
        </F>
        <F label="Yuqori / pastki ichki chegara" value={{ S: "32 / 32", M: "64 / 64", L: "96 / 96" }[row.pad || "M"]}>
          <Seg full value={row.pad || "M"} onChange={(v) => set({ pad: v === "M" ? undefined : v })} options={[{ key: "S", label: "S" }, { key: "M", label: "M" }, { key: "L", label: "L" }]} />
        </F>
        <Switch label="Balandlikni tenglashtirish" hint="Bloklar eng baland blok bo‘yicha cho‘ziladi" checked={!!row.equal} onChange={(v) => set({ equal: v || undefined })} />
        <Switch label="Qatorni yashirish" hint="Saytda ko‘rinmaydi, konstruktorda qoladi" checked={!!row.hidden} onChange={(v) => set({ hidden: v || undefined })} />
      </div>
      <div className="hb-insp-foot col">
        <button className="btn btn-sm" onClick={ungroup} disabled={row.blocks.length < 2}><BI.split size={14} /> Guruhni ajratish (Ungroup)</button>
        <button className="btn btn-sm" onClick={merge} disabled={!next}><BI.merge size={14} /> Keyingi qator bilan birlashtirish</button>
        <button className="btn btn-sm" onClick={dupRow}><I.copy size={14} /> Qatorni nusxalash</button>
        <button className="btn btn-sm btn-danger" onClick={delRow}><I.trash size={14} /> Qatorni o‘chirish</button>
      </div>
    </>
  );
}
