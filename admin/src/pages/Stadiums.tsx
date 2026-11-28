import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Allowed } from "@/lib/auth";
import { Link, Route, Routes, useNavigate, useParams } from "react-router";
import { PageHead } from "@/components/Layout";
import { Empty, ErrorBox, Field, Loading, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { StadiumCanvas, type Sel } from "@/components/StadiumCanvas";
import { SeatEditor } from "@/components/SeatEditor";
import { api, ApiError } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import {
  ZONE_COLORS, PITCH_MAX, PITCH_MIN, addZone, buildStand, cleanRowZones, dropZoneSeats, hasCategories, seatZone, cloneStand, resizePitch, freeKey, mergeZones, newRow, newSection, nextLetter, seatCount, sectionSize, standBox, standSeats, stats,
  type Layout, type LayoutView, type Rect, type LibraryStand, type Section, type Stand, type StandDraft, type Template, type Venue, type Zone,
} from "@/lib/tickets";
import { tx } from "@/lib/i18n";
import "@/tickets.css";

export function StadiumsSection() {
  return (
    <Routes>
      <Route index element={<StadiumsList />} />
      <Route path="new" element={<VenueNew />} />
      <Route path=":id" element={<StadiumEditor />} />
    </Routes>
  );
}

/* ================= S1 · list ================= */
function StadiumsList() {
  const { data, error, loading, reload } = useLoad(() => api.get<{ items: Venue[] }>("/admin/venues"), []);
  const nav = useNavigate();
  if (error) return <ErrorBox error={error} retry={reload} />;
  return (
    <>
      <PageHead title={tx("Stadionlar")} sub={tx("Tribunalar, sektorlar va o‘rinlar sxemasi. Bitta sxema ko‘p matchlarda ishlatiladi")}
        actions={<Allowed to="create"><Link className="btn" to="new?from=templates">{tx("Shablondan yaratish")}</Link><Link className="btn btn-primary" to="new"><I.plus />{" "}{tx("Yangi stadion")}</Link></Allowed>} />
      {loading && !data ? <Loading /> : (
        <div className="st-cards">
          {data!.items.map((v) => (
            <div key={v.id} className={`card st-card${v.archived ? " archived" : ""}`}>
              <div className="st-thumb">{v.preview ? <StadiumCanvas layout={v.preview} height={180} /> : <span className="muted">{tx("Sxema yo‘q")}</span>}</div>
              <div className="card-pad stack" style={{ gap: 8 }}>
                <h3>{v.name}</h3>
                <div className="muted small">{v.city || "—"}{" "}{tx("· {0} o‘rin · {1} sektor · {2} zona", v.stats?.seats ?? 0, v.stats?.sections ?? 0, v.preview?.zones.length ?? 0)}</div>
                <div className="row small">
                  {v.published && <span className="badge ok">{tx("Nashr: v")}{v.published.version}</span>}
                  {v.draft && <span className="badge warn">{tx("Qoralama: v")}{v.draft.version}</span>}
                </div>
                <div className="muted small">{v.published?.matches ? tx("{0} ta matchda ishlatilmoqda", v.published.matches) : tx("Hali matchga ulanmagan")}</div>
                <button className={`btn ${v.draft || !v.published ? "btn-primary" : ""}`} onClick={() => nav(String(v.id))}>{tx("Konstruktorni ochish")}</button>
              </div>
            </div>
          ))}
          <Allowed to="create"><Link to="new" className="st-card st-new"><I.plus size={24} /><b>{tx("Yangi stadion")}</b><span className="muted small">{tx("Bo‘sh maydon, mavjud sxemadan nusxa yoki shablonlar")}</span></Link></Allowed>
        </div>
      )}
    </>
  );
}

/* ================= S8 · new venue ================= */
function VenueNew() {
  const nav = useNavigate();
  const toast = useToast();
  const params = new URLSearchParams(location.search);
  const venues = useLoad(() => api.get<{ items: Venue[] }>("/admin/venues"), []);
  const lib = useLoad(() => api.get<{ templates: Template[] }>("/admin/layout-library"), []);
  const [name, setName] = useState("");
  const [city, setCity] = useState(tx("Toshkent"));
  const [from, setFrom] = useState<"empty" | "layout" | "templates">((params.get("from") as "templates") || "layout");
  const [layoutId, setLayoutId] = useState<number | null>(null);
  const [tpl, setTpl] = useState<number[]>([]);
  const [copy, setCopy] = useState({ zones: true, blocked: true, gates: true, links: false });
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const versions = useMemo(() => (venues.data?.items || []).flatMap((v) => (v.published ? [{ v, ver: v.published }] : []).concat(v.draft ? [{ v, ver: v.draft }] : [])), [venues.data]);
  useEffect(() => { if (layoutId == null && versions[0]) setLayoutId(versions[0].ver.id); }, [versions, layoutId]);
  const preview = useLoad(() => (from === "layout" && layoutId ? api.get<LayoutView>(`/admin/layouts/${layoutId}`) : Promise.resolve(null)), [from, layoutId]);
  const create = async () => {
    setBusy(true); setErr({});
    try {
      const v = await api.post<Venue>("/admin/venues", { name, city, from: from === "empty" ? "" : from, layout_id: layoutId || 0, template_ids: tpl, copy });
      toast(tx("Stadion yaratildi"));
      nav(`/stadiums/${v.id}`, { replace: true });
    } catch (e) {
      if (e instanceof ApiError) { setErr(e.fields); toast(e.message, "error"); }
    } finally { setBusy(false); }
  };
  return (
    <>
      <PageHead pre={<Link to="/stadiums" className="muted"><I.back size={14} />{" "}{tx("Stadionlar")}</Link>} title={tx("Yangi stadion")} sub={tx("Noldan, avvalgi sxemadan yoki kutubxona shablonidan boshlang")}
        actions={<><Link className="btn" to="/stadiums">{tx("Bekor qilish")}</Link><button className="btn btn-primary" disabled={busy || !name.trim() || (from === "layout" && !layoutId)} onClick={create}>{tx("Yaratish va konstruktorga o‘tish")}</button></>} />
      <div className="tk-cols">
        <div className="stack">
          <div className="card card-pad stack">
            <h3>{tx("Asosiy")}</h3>
            <div className="form-grid">
              <Field label={tx("Nomi")} error={err.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("Jar stadioni — Kubok")} autoFocus /></Field>
              <Field label={tx("Shahar")}><input className="input" value={city} onChange={(e) => setCity(e.target.value)} /></Field>
            </div>
          </div>
          <div className="card card-pad stack">
            <h3>{tx("Qayerdan boshlaymiz?")}</h3>
            <div className="tk-opts">
              {([["empty", tx("Bo‘sh maydon"), tx("Faqat maydon, tribunalarni o‘zingiz qurasiz")], ["layout", tx("Mavjud sxemadan nusxa"), tx("Boshqa stadion yoki uning versiyasi")], ["templates", tx("Kutubxona shablonlaridan"), tx("Tribunalarni shablonlardan yig‘ish")]] as const).map(([k, t, d]) => (
                <button key={k} className={`tk-opt${from === k ? " on" : ""}`} onClick={() => setFrom(k)}><b>{t}</b><span>{d}</span></button>
              ))}
            </div>
            {from === "layout" && (
              <>
                <div className="label">{tx("Qaysi sxemadan?")}</div>
                {versions.length === 0 ? <Empty title={tx("Hali sxema yo‘q")} text={tx("«Bo‘sh maydon»dan boshlang")} /> : (
                  <div className="tk-radio-list">
                    {versions.map(({ v, ver }) => (
                      <label key={ver.id} className={layoutId === ver.id ? "on" : ""}>
                        <input type="radio" checked={layoutId === ver.id} onChange={() => setLayoutId(ver.id)} />
                        <span className="grow"><b>{v.name}</b><small>{ver.seats}{" "}{tx("o‘rin · v{0} ·", ver.version)}{" "}{ver.status === "published" ? tx("nashr qilingan") : tx("qoralama")}</small></span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="label">{tx("Nimalar ko‘chiriladi")}</div>
                <div className="row wrap">
                  <label className="row small"><input type="checkbox" checked disabled />{" "}{tx("Tribunalar, sektorlar, o‘rinlar")}</label>
                  {([["zones", tx("Zonalar")], ["blocked", tx("Bloklangan o‘rinlar")], ["gates", tx("Kirishlar")], ["links", tx("Shablon bog‘lanishlari")]] as const).map(([k, l]) => (
                    <label key={k} className="row small"><input type="checkbox" checked={copy[k]} onChange={(e) => setCopy({ ...copy, [k]: e.target.checked })} /> {l}</label>
                  ))}
                </div>
                <div className="tk-note">{tx("Nusxa mustaqil: asl sxema va unga ulangan matchlar o‘zgarmaydi. Narxlar ko‘chirilmaydi — ular har bir matchda alohida.")}</div>
              </>
            )}
            {from === "templates" && (
              <div className="tk-radio-list">
                {(lib.data?.templates || []).filter((t) => t.kind === "stand").map((t) => (
                  <label key={t.id} className={tpl.includes(t.id) ? "on" : ""}>
                    <input type="checkbox" checked={tpl.includes(t.id)} onChange={(e) => setTpl(e.target.checked ? [...tpl, t.id] : tpl.filter((x) => x !== t.id))} />
                    <span className="grow"><b>{t.name}</b><small>{t.seats}{" "}{tx("o‘rin ·")}{" "}{t.description || tx("tribuna")}</small></span>
                  </label>
                ))}
                {lib.data && !lib.data.templates.some((t) => t.kind === "stand") && <div className="muted small">{tx("Kutubxonada tribuna shablonlari yo‘q — konstruktorda tribunani «Shablon sifatida saqlash» mumkin.")}</div>}
              </div>
            )}
          </div>
        </div>
        <div className="card card-pad stack tk-side">
          <h3>{tx("Oldindan ko‘rish")}</h3>
          {from === "layout" && preview.data ? (
            <>
              <div className="st-thumb"><StadiumCanvas layout={preview.data.doc} height={200} /></div>
              <KV k={tx("O‘rinlar")} v={preview.data.stats.seats} /><KV k={tx("Sektorlar")} v={preview.data.stats.sections} />
              <KV k={tx("Zonalar")} v={preview.data.doc.zones.map((z) => z.name).join(", ") || "—"} />
              <KV k={tx("Bloklangan / o‘chirilgan")} v={`${preview.data.stats.blocked} / ${preview.data.stats.removed}`} />
            </>
          ) : <div className="muted small">{from === "empty" ? tx("Maydon va ikkita zona (Oddiy, VIP) bilan boshlanadi") : tx("Tanlangan shablonlar tribunalar bo‘lib qo‘yiladi")}</div>}
        </div>
      </div>
    </>
  );
}

const KV = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="tk-kv"><span>{k}</span><b>{v}</b></div>;

/* ================= S2–S9 · editor ================= */
type Mode = "structure" | "zones" | "preview";

function StadiumEditor() {
  const { id } = useParams();
  const venueId = Number(id);
  const toast = useToast();
  const confirm = useConfirm();
  const [venue, setVenue] = useState<Venue | null>(null);
  const [view, setView] = useState<LayoutView | null>(null);
  const [doc, setDoc] = useState<Layout | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [mode, setMode] = useState<Mode>("structure");
  const [left, setLeft] = useState<"tree" | "library">("tree");
  const [sel, setSel] = useState<Sel>(null);
  const [seatEdit, setSeatEdit] = useState<{ stand: string; section: string } | null>(null);
  const [panel, setPanel] = useState<null | "newStand" | "versions">(null);
  const [saveTpl, setSaveTpl] = useState<null | { kind: "stand" | "section"; stand: string; section?: string }>(null);
  const [placing, setPlacing] = useState<null | { stand: Stand; zones: Zone[]; link?: { id: number; version: number }; name: string; prefix: string; linked: boolean; canLink: boolean }>(null);
  const [activeZone, setActiveZone] = useState<string>("");
  const [pushStands, setPushStands] = useState(true);
  const [diff, setDiff] = useState<Record<string, string> | null>(null);
  const [saveState, setSaveState] = useState<{ at?: string; busy?: boolean; error?: string }>({});
  const hist = useRef<{ past: Layout[]; future: Layout[] }>({ past: [], future: [] });
  const base = useRef<string | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const zoomRef = useRef<{ zoom: (f: number) => void; fit: () => void; pct: () => number } | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await api.get<Venue>(`/admin/venues/${venueId}`);
      const lid = v.draft?.id || v.published?.id;
      setVenue(v);
      if (lid) {
        const lv = await api.get<LayoutView>(`/admin/layouts/${lid}`);
        setView(lv); setDoc(lv.doc); base.current = lv.status === "draft" ? lv.updated_at : undefined;
        setActiveZone((z) => z || lv.doc.zones[0]?.key || "");
      }
    } catch (e) { setErr(e); }
  }, [venueId]);
  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (d: Layout) => {
    setSaveState((s) => ({ ...s, busy: true, error: undefined }));
    try {
      const lv = await api.put<LayoutView>(`/admin/venues/${venueId}/draft`, { doc: d, base: base.current });
      base.current = lv.updated_at;
      setView(lv);
      setSaveState({ at: lv.updated_at });
      if (venue && !venue.draft) setVenue(await api.get<Venue>(`/admin/venues/${venueId}`));
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : tx("Saqlab bo‘lmadi");
      setSaveState({ error: msg });
      toast(msg, "error");
    }
  }, [venueId, venue, toast]);

  const docRef = useRef<Layout | null>(null);
  docRef.current = doc;
  const commit = useCallback((next: Layout, delay: number) => {
    docRef.current = next;
    setDoc(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(next), delay);
  }, [save]);
  // fn may mutate its argument (a deep copy) and must not call setState itself
  const change = useCallback((fn: (l: Layout) => Layout, record = true) => {
    const cur = docRef.current;
    if (!cur) return;
    const next = fn(structuredClone(cur));
    if (record) { hist.current.past.push(cur); if (hist.current.past.length > 60) hist.current.past.shift(); hist.current.future = []; }
    commit(next, 900);
  }, [commit]);
  const undo = () => { const p = hist.current.past.pop(); if (p && doc) { hist.current.future.push(doc); commit(p, 600); } };
  const redo = () => { const n = hist.current.future.pop(); if (n && doc) { hist.current.past.push(doc); commit(n, 600); } };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,select")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); (e.shiftKey ? redo : undo)(); }
      if (e.key === "Escape") { setPlacing(null); setSeatEdit(null); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  // drag moves: record history once per gesture (first move only)
  const moving = useRef(false);
  useEffect(() => { const u = () => (moving.current = false); window.addEventListener("pointerup", u); return () => window.removeEventListener("pointerup", u); }, []);
  const moveChange = (fn: (l: Layout) => Layout) => { change(fn, !moving.current); moving.current = true; };

  const st = useMemo(() => (doc ? stats(doc) : null), [doc]);
  const soldSecs = useMemo(() => new Set(view?.sold_sections || []), [view]);
  if (err) return <ErrorBox error={err} retry={load} />;
  if (!venue || !doc || !st) return <Loading />;

  const stand = sel?.stand ? doc.stands.find((s) => s.key === sel.stand) : undefined;
  const section = stand && sel?.section ? stand.sections.find((s) => s.key === sel.section) : undefined;
  const updStand = (key: string, fn: (s: Stand) => void) => change((l) => { const s = l.stands.find((x) => x.key === key); if (s) fn(s); return l; });
  const updSection = (sk: string, key: string, fn: (s: Section) => void) => change((l) => { const s = l.stands.find((x) => x.key === sk)?.sections.find((x) => x.key === key); if (s) fn(s); return l; });

  const publish = async () => {
    if (!(await confirm({ title: tx("Sxemani nashr qilish?"), text: tx("Nashr qilingan versiya matchlarga tanlanadi. Allaqachon sotilgan matchlar o‘z versiyasida qoladi."), ok: tx("Nashr qilish") }))) return;
    window.clearTimeout(timer.current);
    try {
      await api.put(`/admin/venues/${venueId}/draft`, { doc, base: base.current });
      const v = await api.post<Venue>(`/admin/venues/${venueId}/publish`, {});
      setVenue(v); toast(tx("v{0} nashr qilindi", v.published?.version)); load();
    } catch (e) { toast(e instanceof ApiError ? e.message : tx("Xato"), "error"); }
  };

  const seatSection = seatEdit && doc.stands.find((s) => s.key === seatEdit.stand)?.sections.find((s) => s.key === seatEdit.section);
  const isPublishedView = view?.status === "published" && !venue.draft;

  return (
    <div className="st-editor">
      <header className="st-top">
        <Link to="/stadiums" className="btn btn-icon" aria-label={tx("Orqaga")}><I.back size={16} /></Link>
        <div className="st-title"><small>{tx("Stadionlar /")}{" "}{venue.name}</small><b>{venue.name}{" "}{tx("— sxema")}</b></div>
        <span className={`badge ${venue.draft ? "warn" : "ok"}`} role="button" onClick={() => setPanel(panel === "versions" ? null : "versions")} title={tx("Versiyalar")}>
          {venue.draft ? tx("Qoralama · v{0}", venue.draft.version) : venue.published ? tx("Nashr · v{0}", venue.published.version) : tx("Yangi")}
        </span>
        <span className="muted small st-save grow">{saveState.busy ? tx("Saqlanmoqda…") : saveState.error ? <span className="danger-text">{saveState.error}</span> : saveState.at ? tx("Avto-saqlandi {0}", fmtDateTime(saveState.at).slice(-5)) : isPublishedView ? tx("Tahrirlash yangi qoralama ochadi") : ""}</span>
        <div className="seg">
          {([["structure", tx("Tuzilma")], ["zones", tx("Zonalar")], ["preview", tx("Ko‘rinish (sayt)")]] as const).map(([k, l]) => <button key={k} className={mode === k ? "on" : ""} onClick={() => { setMode(k); setSeatEdit(null); }}>{l}</button>)}
        </div>
        <button className="btn btn-ghost btn-icon" onClick={undo} disabled={!hist.current.past.length} title={tx("Bekor (Ctrl+Z)")}><I.back size={16} /></button>
        <button className="btn btn-ghost btn-icon flip" onClick={redo} disabled={!hist.current.future.length} title={tx("Qaytarish (Ctrl+Shift+Z)")}><I.back size={16} /></button>
        <button className="btn" onClick={() => setPanel(panel === "versions" ? null : "versions")}>{tx("Versiyalar")}</button>
        <button className="btn btn-primary" onClick={publish} disabled={!venue.draft && !hist.current.past.length}>{tx("Nashr qilish")}</button>
      </header>

      <div className={`st-body${seatEdit ? " seat-mode" : ""}`}>
        {/* ---------- left ---------- */}
        <aside className="st-left">
          <div className="seg block"><button className={left === "tree" ? "on" : ""} onClick={() => setLeft("tree")}>{tx("Tuzilma")}{" "}<small className="muted">{st.sections}</small></button><button className={left === "library" ? "on" : ""} onClick={() => setLeft("library")}>{tx("Kutubxona")}</button></div>
          {left === "tree" ? (
            <>
              <div className="st-tree">
                <button className={`st-node${sel?.pitch ? " on" : ""}`} onClick={() => setSel({ pitch: true })}>
                  <i style={{ background: "#2E6B45" }} /><span className="grow">{tx("Maydon")}</span><small>{Math.round(doc.pitch.w)}×{Math.round(doc.pitch.h)}</small>
                </button>
                {doc.stands.length === 0 && <div className="muted small" style={{ padding: 12 }}>{tx("Tribuna yo‘q. «Tribuna qo‘shish» yoki kutubxonadan qo‘ying.")}</div>}
                {doc.stands.map((s) => (
                  <div key={s.key}>
                    <button className={`st-node${sel?.stand === s.key && !sel.section ? " on" : ""}`} onClick={() => setSel({ stand: s.key })}>
                      <I.down size={12} /><span className="grow">{s.name || tx("Tribuna")}{s.template_id ? <I.link size={11} /> : null}</span><small>{standSeats(s)}</small>
                    </button>
                    {s.sections.map((x) => (
                      <button key={x.key} className={`st-node sub${sel?.section === x.key ? " on" : ""}`} onClick={() => setSel({ stand: s.key, section: x.key })} onDoubleClick={() => setSeatEdit({ stand: s.key, section: x.key })}>
                        <i style={{ background: doc.zones.find((z) => z.key === x.zone)?.color || "#D5D9DF" }} /><span className="grow">{tx("Sektor")}{" "}{x.name}</span><small>{seatCount(x)}</small>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              <div className="stack" style={{ gap: 8, padding: 16 }}>
                <button className="btn" onClick={() => setPanel("newStand")}><I.plus size={16} />{" "}{tx("Tribuna qo‘shish")}</button>
                <button className="btn" disabled={!stand} onClick={() => stand && change((l) => {
                  const s = l.stands.find((x) => x.key === stand.key)!;
                  const last = s.sections[s.sections.length - 1];
                  const k = freeKey(l, nextLetter(l) + "1");
                  s.sections.push(newSection(k, last?.rows.length || 6, last?.rows[0]?.seats || 10, last?.zone || "", last ? last.x + sectionSize(last).w + 14 : 0, last?.y || 0));
                  setTimeout(() => setSel({ stand: s.key, section: k }));
                  return l;
                })}><I.plus size={16} />{" "}{tx("Sektor qo‘shish")}</button>
              </div>
            </>
          ) : <Library venueId={venueId} layout={doc} onPick={(p) => { setPlacing(p); setSel(null); setSeatEdit(null); }} placingName={placing?.name} />}
        </aside>

        {/* ---------- canvas ---------- */}
        <main className="st-main">
          {seatEdit && seatSection ? (
            <SeatEditor section={seatSection} zones={doc.zones} sold={new Set(view?.sold_seats || [])}
              path={[doc.stands.find((s) => s.key === seatEdit.stand)?.name || "", `Sektor ${seatSection.name}`]}
              onBack={() => setSeatEdit(null)}
              onChange={(fn) => updSection(seatEdit.stand, seatEdit.section, fn)}
              onAddZone={(name) => { const l = structuredClone(doc); const key = addZone(l, name); change((x) => { x.zones = l.zones; return x; }); return key; }}
              onSplit={(rows) => change((l) => {
                const s = l.stands.find((x) => x.key === seatEdit.stand)!;
                const src = s.sections.find((x) => x.key === seatEdit.section)!;
                const k = freeKey(l, `${src.key}-2`);
                const right = Math.max(...s.sections.map((q) => q.x + sectionSize(q).w));
                // the new section takes the zone most of its seats had; the others keep theirs as categories
                const moved = rows.flatMap(([label, nums]) => { const r = src.rows.find((x) => x.label === label)!; return nums.map((n) => seatZone(src, r, n)); });
                const tally = moved.reduce<Record<string, number>>((m, z) => ({ ...m, [z]: (m[z] || 0) + 1 }), {});
                const main = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? src.zone;
                const ns = newSection(k, 0, 0, main, right + 14, src.y);
                ns.rotation = src.rotation; ns.gate = src.gate; ns.seat_mode = src.seat_mode;
                for (const [label, nums] of rows) {
                  const r = src.rows.find((x) => x.label === label)!;
                  const nr = newRow(label, nums.length);
                  nums.forEach((n, i) => { const z = seatZone(src, r, n); if (z !== main) (nr.zone_seats ??= {})[z] = [...(nr.zone_seats?.[z] || []), i + 1]; });
                  r.removed = [...new Set([...r.removed, ...nums])].sort((a, b) => a - b);
                  r.blocked = r.blocked.filter((n) => !nums.includes(n));
                  ns.rows.push(nr);
                }
                cleanRowZones(src); cleanRowZones(ns);
                s.sections.push(ns);
                setTimeout(() => toast(tx("Yangi sektor: {0} ({1} o‘rin)", k, ns.rows.reduce((n, r) => n + r.seats, 0))));
                return l;
              })} />
          ) : (
            <>
              <StadiumCanvas layout={doc} sel={sel} interactive={mode !== "preview"} colorBy={mode === "zones" || mode === "preview" ? "zone" : "structure"} diff={diff || undefined}
                sold={soldSecs} ghost={placing?.stand} zoomRef={zoomRef} fitKey={venueId}
                onSelect={(s) => {
                  if (mode === "zones" && s?.section && activeZone) updSection(s.stand!, s.section, (x) => { x.zone = activeZone; cleanRowZones(x); });
                  setSel(s);
                }}
                onMoveStand={(k, x, y) => moveChange((l) => { const s = l.stands.find((q) => q.key === k)!; s.x = x; s.y = y; return l; })}
                onResizePitch={mode === "structure" ? (r) => moveChange((l) => resizePitch(l, r, pushStands)) : undefined}
                onMoveSection={(sk, k, x, y) => moveChange((l) => { const s = l.stands.find((q) => q.key === sk)!.sections.find((q) => q.key === k)!; s.x = x; s.y = y; return l; })}
                onOpenSection={(sk, k) => mode === "structure" && setSeatEdit({ stand: sk, section: k })}
                onPlace={(x, y) => {
                  if (!placing) return;
                  change((l) => {
                    const ns = cloneStand(l, placing.stand, placing.prefix.trim(), { x, y }, placing.linked && placing.link ? placing.link : undefined);
                    ns.name = placing.name || ns.name;
                    l.zones = mergeZones(l, placing.zones);
                    for (const sec of ns.sections) if (sec.zone && !l.zones.some((z) => z.key === sec.zone)) sec.zone = "";
                    dropZoneSeats(l, (z) => l.zones.some((q) => q.key === z));
                    l.stands.push(ns);
                    setTimeout(() => setSel({ stand: ns.key }));
                    return l;
                  });
                  toast(tx("«{0}» qo‘yildi · +{1} o‘rin", placing.name, standSeats(placing.stand)));
                  setPlacing(null);
                }} />
              {!diff && <div className="st-toolhint">
                {placing ? tx("Sxemaga bosing — tribuna shu yerga qo‘yiladi · Esc — bekor") : mode === "zones" ? tx("Sektorni bosing — «{0}» biriktiriladi", doc.zones.find((z) => z.key === activeZone)?.name || "zona") : mode === "preview" ? tx("Saytda chipta tanlash sahifasida shunday ko‘rinadi") : sel?.pitch ? tx("Burchak yoki chetidagi tutqichni torting · Alt — markaz joyida qoladi") : tx("Sektorni sudrang · ikki marta bosing — o‘rinlarni tahrirlash · maydonni bosing — o‘lchami · g‘ildirak — masshtab")}
              </div>}
              <div className="st-zoom">
                <button onClick={() => zoomRef.current?.zoom(1.2)}>−</button>
                <button onClick={() => zoomRef.current?.fit()}>{tx("Sig‘dirish")}</button>
                <button onClick={() => zoomRef.current?.zoom(1 / 1.2)}>+</button>
              </div>
              {diff && <div className="st-diffbar"><I.alert size={14} />{" "}{tx("Solishtirish rejimi: sariq — o‘zgargan sektorlar")}{" "}<button className="btn btn-sm" onClick={() => setDiff(null)}>{tx("Yopish")}</button></div>}
            </>
          )}
        </main>

        {/* ---------- right ---------- */}
        {!seatEdit && <aside className="st-right">
          {panel === "versions" ? (
            <Versions venue={venue} current={view} onClose={() => setPanel(null)} onDiff={setDiff} onReload={load} />
          ) : panel === "newStand" ? (
            <NewStand layout={doc} onCancel={() => setPanel(null)} onCreate={(d) => {
              change((l) => {
                const at = { x: l.pitch.x + l.pitch.w + 60, y: l.pitch.y - 120 };
                const ns = buildStand(l, d, at);
                l.stands.push(ns);
                setTimeout(() => setSel({ stand: ns.key }));
                return l;
              });
              setPanel(null);
            }} />
          ) : placing ? (
            <PlaceSettings p={placing} onChange={setPlacing} total={st.seats} />
          ) : mode === "zones" ? (
            <ZonesPanel layout={doc} st={st} active={activeZone} setActive={setActiveZone} change={change} />
          ) : sel?.pitch ? (
            <PitchInspector layout={doc} push={pushStands} setPush={setPushStands} onChange={(r) => change((l) => resizePitch(l, r, pushStands))} />
          ) : section && stand ? (
            <SectionInspector key={section.key} layout={doc} stand={stand} s={section} sold={soldSecs.has(section.key)}
              upd={(fn) => updSection(stand.key, section.key, fn)}
              onRename={(k) => { updSection(stand.key, section.key, (x) => { if (x.name === x.key) x.name = k; x.key = k; }); setSel({ stand: stand.key, section: k }); }}
              onSeats={() => setSeatEdit({ stand: stand.key, section: section.key })}
              onSaveTpl={() => setSaveTpl({ kind: "section", stand: stand.key, section: section.key })}
              onDuplicate={() => change((l) => {
                const s = l.stands.find((x) => x.key === stand.key)!;
                const c: Section = structuredClone(section);
                c.key = freeKey(l, section.key.replace(/\d+$/, "") + (Number(section.key.match(/\d+$/)?.[0] || 1) + 1));
                c.name = c.key; c.x += sectionSize(section).w + 14;
                s.sections.push(c);
                setTimeout(() => setSel({ stand: s.key, section: c.key }));
                return l;
              })}
              onDelete={async () => {
                if (!(await confirm({ title: tx("Sektor {0}ni o‘chirish?", section.name), text: tx("{0} o‘rin o‘chiriladi.", seatCount(section)), ok: tx("O‘chirish"), danger: true }))) return;
                change((l) => { const s = l.stands.find((x) => x.key === stand.key)!; s.sections = s.sections.filter((x) => x.key !== section.key); return l; });
                setSel({ stand: stand.key });
              }} />
          ) : stand ? (
            <StandInspector s={stand} sold={stand.sections.some((x) => soldSecs.has(x.key))} upd={(fn) => updStand(stand.key, fn)}
              onSaveTpl={() => setSaveTpl({ kind: "stand", stand: stand.key })}
              onDelete={async () => {
                if (!(await confirm({ title: tx("«{0}» tribunasini o‘chirish?", stand.name), text: tx("{0} sektor, {1} o‘rin o‘chiriladi.", stand.sections.length, standSeats(stand)), ok: tx("O‘chirish"), danger: true }))) return;
                change((l) => { l.stands = l.stands.filter((x) => x.key !== stand.key); return l; });
                setSel(null);
              }} />
          ) : (
            <div className="card-pad stack">
              <h3>{tx("Sxema")}</h3>
              <div className="muted small">{tx("Tribuna yoki sektorni tanlang. Yangi tribunani shablondan yaratish yoki kutubxonadan qo‘yish mumkin.")}</div>
              <KV k={tx("Jami o‘rin")} v={st.seats} /><KV k={tx("Sotiladigan")} v={st.sellable} /><KV k={tx("Tribunalar")} v={st.stands} /><KV k={tx("Sektorlar")} v={st.sections} />
              {(view?.warnings || []).length > 0 && <div className="tk-warn">{view!.warnings.slice(0, 6).map((w) => <div key={w}><I.alert size={13} /> {w}</div>)}</div>}
            </div>
          )}
        </aside>}
      </div>

      <footer className="st-status">
        <b>{tx("Jami: {0} o‘rin", st.seats.toLocaleString("ru-RU"))}</b>
        {doc.zones.map((z) => <span key={z.key}><i style={{ background: z.color }} />{z.name} {st.by_zone[z.key] || 0}</span>)}
        {st.by_zone[""] ? <span><i style={{ background: "#D5D9DF" }} />{tx("Zonasiz")}{" "}{st.by_zone[""]}</span> : null}
        <span><i style={{ background: "#D5D9DF" }} />{tx("Bloklangan")}{" "}{st.blocked}</span>
        <span>{tx("O‘chirilgan")}{" "}{st.removed}</span>
        <div className="grow" />
        {(view?.warnings || []).length > 0 && <span className="warn-text"><I.alert size={14} />{" "}{tx("{0} ogohlantirish:", view!.warnings.length)}{" "}{view!.warnings[0]}</span>}
      </footer>

      {saveTpl && <SaveTemplate layout={doc} target={saveTpl} onClose={() => setSaveTpl(null)} onSaved={(t, link) => {
        if (link && saveTpl.kind === "stand") updStand(saveTpl.stand, (s) => { s.template_id = t.id; s.template_version = 1; });
        setSaveTpl(null); setLeft("library");
      }} />}
    </div>
  );
}

/* ---------- inspectors ---------- */
function Num({ value, onChange, min = 0, max = 400, step = 1 }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <div className="num">
      <button onClick={() => onChange(Math.max(min, value - step))} aria-label={tx("Kamaytirish")}>−</button>
      <input value={value} inputMode="numeric" onChange={(e) => { const n = parseInt(e.target.value || "0", 10); if (!isNaN(n)) onChange(Math.min(max, Math.max(min, n))); }} />
      <button onClick={() => onChange(Math.min(max, value + step))} aria-label={tx("Ko‘paytirish")}>+</button>
    </div>
  );
}

/* ---------- pitch ---------- */
const PITCH_SHAPES: [string, string, number][] = [[tx("Mini-futbol"), "2 : 1", 2], [tx("Futbol"), "105 : 68", 105 / 68], [tx("Kvadrat"), "1 : 1", 1]];
function PitchInspector({ layout, push, setPush, onChange }: { layout: Layout; push: boolean; setPush: (b: boolean) => void; onChange: (r: Rect) => void }) {
  const p = layout.pitch;
  // number inputs keep the centre of the pitch in place
  const size = (w: number, h: number) => onChange({ x: p.x + (p.w - w) / 2, y: p.y + (p.h - h) / 2, w, h });
  const clamp = (v: number) => Math.round(Math.min(PITCH_MAX, Math.max(PITCH_MIN, v)));
  const scale = (k: number) => size(clamp(p.w * k), clamp(p.h * k));
  return (
    <div className="st-insp">
      <div className="st-insp-head"><h3>{tx("Maydon")}</h3><small>{tx("O‘lcham sxema birligida: bitta o‘rin qadami — 10")}</small></div>
      <div className="form-grid">
        <div className="field"><label>{tx("Uzunligi")}</label><Num value={Math.round(p.w)} onChange={(w) => size(w, p.h)} min={PITCH_MIN} max={PITCH_MAX} step={10} /></div>
        <div className="field"><label>{tx("Eni")}</label><Num value={Math.round(p.h)} onChange={(h) => size(p.w, h)} min={PITCH_MIN} max={PITCH_MAX} step={10} /></div>
      </div>
      <div className="label">{tx("Kattalashtirish")}</div>
      <div className="seg block">
        {[[0.8, "−20%"], [1.1, "+10%"], [1.25, "+25%"], [1.5, "+50%"]].map(([k, l]) => <button key={l} onClick={() => scale(k as number)}>{l}</button>)}
      </div>
      <div className="label">{tx("Proporsiya (uzunlik saqlanadi)")}</div>
      <div className="seg block wrap">
        {PITCH_SHAPES.map(([n, r, k]) => <button key={n} className={Math.abs(p.w / p.h - k) < 0.02 ? "on" : ""} onClick={() => size(p.w, clamp(p.w / k))}>{n} · {r}</button>)}
      </div>
      <label className="toggle-row"><span><b>{tx("Tribunalarni birga surish")}</b><small>{tx("Maydon kattalashsa, tribunalar chetlar bilan birga suriladi — oraliq saqlanadi")}</small></span>
        <input type="checkbox" className="switch lime" checked={push} onChange={(e) => setPush(e.target.checked)} /></label>
      <div className="tk-note">{tx("Sxemada maydonni bosing va burchak yoki chetidagi tutqichni torting. Alt tugmasi bilan — markaz joyida qoladi.")}</div>
    </div>
  );
}

function SectionInspector({ layout, stand, s, sold, upd, onRename, onSeats, onSaveTpl, onDuplicate, onDelete }: {
  layout: Layout; stand: Stand; s: Section; sold: boolean; upd: (fn: (s: Section) => void) => void; onRename: (k: string) => void;
  onSeats: () => void; onSaveTpl: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const [key, setKey] = useState(s.key);
  const rows = s.rows.length, perRow = s.rows[0]?.seats ?? 0;
  const uniform = s.rows.every((r) => r.seats === perRow);
  const setRows = (n: number) => upd((x) => {
    while (x.rows.length < n) x.rows.push(newRow(String(x.rows.length + 1), x.rows[x.rows.length - 1]?.seats ?? 10));
    if (x.rows.length > n) x.rows = x.rows.slice(0, n);
  });
  return (
    <div className="st-insp">
      <div className="st-insp-head"><h3>{tx("Sektor")}{" "}{s.name}</h3><small>{stand.name}{" "}{tx("· {0} qator ·", s.rows.length)}{" "}{seatCount(s)}{" "}{tx("o‘rin")}</small></div>
      {sold && <div className="tk-note info">{tx("Bu sektorda sotilgan chiptalar bor: sotilgan o‘rinlarni o‘chirib bo‘lmaydi.")}</div>}
      <Field label={tx("Sektor nomi (kalit)")} hint={tx("Chiptada va saytda ko‘rinadi: A1, D2, VIP")}>
        <input className="input" value={key} maxLength={24} onChange={(e) => setKey(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))}
          onBlur={() => { if (key && key !== s.key && !layout.stands.some((st) => st.sections.some((x) => x.key.toLowerCase() === key.toLowerCase()))) onRename(key); else setKey(s.key); }} />
      </Field>
      <div className="label">{tx("Zona")}</div>
      <div className="seg block wrap">
        {layout.zones.map((z) => <button key={z.key} className={s.zone === z.key ? "on" : ""} onClick={() => upd((x) => { x.zone = z.key; cleanRowZones(x); })}><i style={{ background: z.color }} /> {z.name}</button>)}
      </div>
      <div className="form-grid">
        <div className="field"><label>{tx("Qatorlar")}</label><Num value={rows} onChange={setRows} min={1} max={200} /></div>
        <div className="field"><label>{tx("Har qatorda")}{!uniform && tx(" (har xil)")}</label><Num value={perRow} onChange={(n) => upd((x) => x.rows.forEach((r) => { r.seats = n; r.removed = r.removed.filter((q) => q <= n); r.blocked = r.blocked.filter((q) => q <= n); }))} min={1} /></div>
      </div>
      <div className="label">{tx("O‘rin turi")}</div>
      <div className="seg block"><button className={s.seat_mode === "numbered" ? "on" : ""} onClick={() => upd((x) => { x.seat_mode = "numbered"; })}>{tx("Raqamlangan")}</button><button className={s.seat_mode === "free" ? "on" : ""} disabled={hasCategories(s)} title={hasCategories(s) ? tx("Sektorda narx toifali o‘rinlar bor — ular faqat raqamlangan bo‘ladi") : undefined} onClick={() => upd((x) => { x.seat_mode = "free"; })}>{tx("Erkin")}</button></div>
      {hasCategories(s) && <div className="tk-note">{tx("Narx toifali o‘rinlar bor — sektor raqamlangan. Toifalar «O‘rinlarni tahrirlash»da.")}</div>}
      <div className="form-grid">
        <Field label={tx("Kirish (darvoza)")}><input className="input" value={s.gate} maxLength={12} placeholder={tx("3, V…")} onChange={(e) => upd((x) => { x.gate = e.target.value; })} /></Field>
        <Field label={tx("Raqamlash")}><select className="select" value={s.numbering} onChange={(e) => upd((x) => { x.numbering = e.target.value as "ltr" | "rtl"; })}><option value="ltr">{tx("Chapdan o‘ngga")}</option><option value="rtl">{tx("O‘ngdan chapga")}</option></select></Field>
      </div>
      <Field label={tx("Burilish: {0}°", s.rotation)}><input type="range" min={-180} max={180} step={5} value={s.rotation} onChange={(e) => upd((x) => { x.rotation = Number(e.target.value); })} /></Field>
      <label className="toggle-row"><span><b>{tx("O‘rtada yo‘lak")}</b><small>{s.aisle_after.length ? tx("{0}-o‘rindan keyin", s.aisle_after.join(", ")) : tx("Qatorni ikkiga bo‘ladi")}</small></span>
        <input type="checkbox" className="switch lime" checked={s.aisle_after.length > 0} onChange={(e) => upd((x) => { x.aisle_after = e.target.checked ? [Math.floor(maxOf(x) / 2)] : []; })} /></label>
      <button className="btn btn-primary" onClick={onSeats}>{tx("O‘rinlarni tahrirlash")}</button>
      <div className="row"><button className="btn grow" onClick={onDuplicate}>{tx("Nusxalash")}</button><button className="btn grow" onClick={onSaveTpl}>{tx("Shablon")}</button></div>
      <button className="btn btn-danger" disabled={sold} onClick={onDelete}><I.trash size={16} />{" "}{tx("O‘chirish")}</button>
    </div>
  );
}
const maxOf = (s: Section) => s.rows.reduce((m, r) => Math.max(m, r.seats), 0);

function StandInspector({ s, sold, upd, onSaveTpl, onDelete }: { s: Stand; sold: boolean; upd: (fn: (s: Stand) => void) => void; onSaveTpl: () => void; onDelete: () => void }) {
  const b = standBox(s);
  return (
    <div className="st-insp">
      <div className="st-insp-head"><h3>{s.name || tx("Tribuna")}</h3><small>{s.sections.length}{" "}{tx("sektor ·")}{" "}{standSeats(s)}{" "}{tx("o‘rin")}</small></div>
      {s.template_id ? <div className="tk-note"><I.link size={13} />{" "}{tx("Kutubxona shabloniga bog‘langan (v")}{s.template_version || 1})</div> : null}
      <Field label={tx("Nomi")}><input className="input" value={s.name} onChange={(e) => upd((x) => { x.name = e.target.value; })} /></Field>
      <div className="label">{tx("Joylashuvi")}</div>
      <div className="seg block wrap">{["N", "S", "W", "E", "NW", "NE", "SW", "SE"].map((p) => <button key={p} className={s.position === p ? "on" : ""} onClick={() => upd((x) => { x.position = p; })}>{POS[p]}</button>)}</div>
      <Field label={tx("Burilish: {0}°", s.rotation)}><input type="range" min={-180} max={180} step={5} value={s.rotation} onChange={(e) => upd((x) => { x.rotation = Number(e.target.value); })} /></Field>
      <div className="muted small">{tx("O‘lcham: {0} × {1} · sxemada sudrab joyini o‘zgartiring", Math.round(b.w), Math.round(b.h))}</div>
      <button className="btn" onClick={onSaveTpl}>{tx("Shablon sifatida saqlash")}</button>
      <button className="btn btn-danger" disabled={sold} onClick={onDelete}><I.trash size={16} />{" "}{tx("Tribunani o‘chirish")}</button>
    </div>
  );
}
const POS: Record<string, string> = { N: tx("Shimol"), S: tx("Janub"), W: tx("G‘arb"), E: tx("Sharq"), NW: tx("Sh-G‘"), NE: tx("Sh-Sh"), SW: tx("J-G‘"), SE: tx("J-Sh") };

/* ---------- S4 · new stand ---------- */
function NewStand({ layout, onCancel, onCreate }: { layout: Layout; onCancel: () => void; onCreate: (d: StandDraft) => void }) {
  const [d, setD] = useState<StandDraft>({ name: "Yangi tribuna", position: "N", shape: "straight", sections: 3, rows: 8, seats: 12, zone: layout.zones[0]?.key || "", aisle: true, prefix: nextLetter(layout) });
  const total = d.sections * d.rows * d.seats;
  return (
    <div className="st-insp">
      <div className="st-insp-head"><h3>{tx("Yangi tribuna")}</h3><small>{tx("Shablon tanlang — sektorlar avtomatik yaratiladi")}</small></div>
      <Field label={tx("Nomi")}><input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
      <div className="label">{tx("Joylashuvi")}</div>
      <div className="seg block wrap">{["N", "S", "W", "E", "NW", "NE", "SW", "SE"].map((p) => <button key={p} className={d.position === p ? "on" : ""} onClick={() => setD({ ...d, position: p, shape: p.length === 2 ? "corner" : d.shape === "corner" ? "straight" : d.shape })}>{POS[p]}</button>)}</div>
      <div className="label">{tx("Shakli")}</div>
      <div className="tk-shapes">
        {([["straight", tx("To‘g‘ri"), "M3 9h18M3 15h18"], ["arc", tx("Yoy"), "M3 16a9 9 0 0118 0M6 16a6 6 0 0112 0"], ["corner", tx("Burchak"), "M4 20V10a6 6 0 016-6h10M8 20v-8a4 4 0 014-4h8"]] as const).map(([k, l, p]) => (
          <button key={k} className={d.shape === k ? "on" : ""} onClick={() => setD({ ...d, shape: k })}><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d={p} /></svg>{l}</button>
        ))}
      </div>
      <div className="form-grid three">
        <div className="field"><label>{tx("Sektorlar")}</label><Num value={d.sections} onChange={(n) => setD({ ...d, sections: n })} min={1} max={20} /></div>
        <div className="field"><label>{tx("Qatorlar")}</label><Num value={d.rows} onChange={(n) => setD({ ...d, rows: n })} min={1} max={60} /></div>
        <div className="field"><label>{tx("O‘rin/qator")}</label><Num value={d.seats} onChange={(n) => setD({ ...d, seats: n })} min={1} max={60} /></div>
      </div>
      <Field label={tx("Sektor harfi")} hint={`${d.prefix}1, ${d.prefix}2…`}><input className="input" value={d.prefix} maxLength={4} onChange={(e) => setD({ ...d, prefix: e.target.value.replace(/[^A-Za-z0-9]/g, "") })} /></Field>
      <div className="label">{tx("Zona")}</div>
      <div className="seg block wrap">{layout.zones.map((z) => <button key={z.key} className={d.zone === z.key ? "on" : ""} onClick={() => setD({ ...d, zone: z.key })}>{z.name}</button>)}</div>
      <label className="toggle-row"><span><b>{tx("Sektorlar orasida yo‘lak")}</b><small>{tx("Har bir sektor alohida kirishga ega")}</small></span><input type="checkbox" className="switch lime" checked={d.aisle} onChange={(e) => setD({ ...d, aisle: e.target.checked })} /></label>
      <div className="tk-sum"><b>{tx("Natija: {0} sektor · {1} o‘rin", d.sections, total)}</b><small>{tx("Yaratgandan keyin har bir sektorni alohida tahrirlash mumkin")}</small></div>
      <button className="btn btn-primary" disabled={!d.prefix} onClick={() => onCreate(d)}>{tx("Tribunani yaratish")}</button>
      <button className="btn btn-ghost" onClick={onCancel}>{tx("Bekor qilish")}</button>
    </div>
  );
}

/* ---------- S5 · zones ---------- */
function ZonesPanel({ layout, st, active, setActive, change }: { layout: Layout; st: ReturnType<typeof stats>; active: string; setActive: (k: string) => void; change: (fn: (l: Layout) => Layout) => void }) {
  const add = () => change((l) => {
    let n = l.zones.length + 1, key = tx("zona{0}", n);
    while (l.zones.some((z) => z.key === key)) key = tx("zona{0}", ++n);
    l.zones.push({ key, name: `Zona ${n}`, kind: "oddiy", color: ZONE_COLORS[l.zones.length % ZONE_COLORS.length] });
    setTimeout(() => setActive(key));
    return l;
  });
  const upd = (key: string, fn: (z: Zone) => void) => change((l) => { const z = l.zones.find((x) => x.key === key); if (z) fn(z); return l; });
  return (
    <div className="st-insp">
      <div className="st-insp-head"><h3>{tx("Zonalar")}</h3><small>{tx("Zona — saytdagi chipta turi. Narxlar har bir match uchun «Chiptalar» bo‘limida qo‘yiladi")}</small></div>
      {layout.zones.map((z) => {
        const secs = layout.stands.flatMap((s) => s.sections.flatMap((x) => x.zone === z.key ? [x.name] : x.rows.some((r) => r.zone_seats?.[z.key]?.length) ? [tx("{0} (qisman)", x.name)] : []));
        return (
          <div key={z.key} className={`tk-zone${active === z.key ? " on" : ""}`} onClick={() => setActive(z.key)}>
            <div className="row">
              <input type="color" value={z.color || "#9AA1AB"} onChange={(e) => upd(z.key, (x) => { x.color = e.target.value; })} onClick={(e) => e.stopPropagation()} />
              <input className="input input-sm grow" value={z.name} onChange={(e) => upd(z.key, (x) => { x.name = e.target.value; })} />
              <b className="small">{st.by_zone[z.key] || 0}</b>
            </div>
            <div className="row small">
              <label className="row"><input type="checkbox" checked={z.kind === "vip"} onChange={(e) => upd(z.key, (x) => { x.kind = e.target.checked ? "vip" : "oddiy"; })} />{" "}{tx("VIP (grafit chipta)")}</label>
              <span className="grow muted">{secs.length ? secs.join(", ") : tx("sektor yo‘q")}</span>
              {!secs.length && <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); change((l) => { l.zones = l.zones.filter((x) => x.key !== z.key); dropZoneSeats(l, (k) => k !== z.key); return l; }); }}>{tx("O‘chirish")}</button>}
            </div>
          </div>
        );
      })}
      <button className="btn" onClick={add}><I.plus size={16} />{" "}{tx("Zona qo‘shish")}</button>
      <div className="tk-note">{tx("Nashr qilingan sxema faqat yangi sotuvlarga qo‘llanadi. Sotilgan o‘rinli sektorni o‘chirib yoki boshqa zonaga o‘tkazib bo‘lmaydi.")}</div>
    </div>
  );
}

/* ---------- S6 · library ---------- */
type PlaceState = { stand: Stand; zones: Zone[]; link?: { id: number; version: number }; name: string; prefix: string; linked: boolean; canLink: boolean };
function Library({ venueId, layout, onPick, placingName }: { venueId: number; layout: Layout; onPick: (p: PlaceState) => void; placingName?: string }) {
  const { data, reload } = useLoad(() => api.get<{ templates: Template[]; stands: LibraryStand[] }>(`/admin/layout-library?venue_id=${venueId}`), [venueId]);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "stand" | "section">("all");
  const toast = useToast();
  const confirm = useConfirm();
  if (!data) return <Loading />;
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  const tpls = data.templates.filter((t) => (kind === "all" || t.kind === kind) && match(t.name));
  const others = kind === "section" ? [] : data.stands.filter((s) => match(s.name + s.venue_name));
  const pick = (stand: Stand, zones: Zone[], name: string, link?: { id: number; version: number }) =>
    onPick({ stand, zones, link, name, prefix: nextLetter(layout), linked: false, canLink: !!link });
  const asStand = (t: Template): Stand => t.kind === "stand" ? (t.doc as Stand) : { key: "t", name: t.name, position: "N", shape: "straight", x: 0, y: 0, rotation: 0, sections: [{ ...(t.doc as Section), x: 0, y: 0 }] };
  return (
    <div className="st-lib">
      <input className="input" placeholder={tx("Shablon qidirish…")} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="row small">{(["all", "stand", "section"] as const).map((k) => <button key={k} className={`chip${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>{{ all: tx("Hammasi"), stand: tx("Tribuna"), section: tx("Sektor") }[k]}</button>)}</div>
      <div className="st-lib-group">{tx("Mening va jamoa shablonlari")}{" "}<small>{tpls.length}</small></div>
      {tpls.length === 0 && <div className="muted small">{tx("Tribuna yoki sektorni tanlab «Shablon sifatida saqlash».")}</div>}
      {tpls.map((t) => (
        <div key={t.id} className={`st-lib-item${placingName === t.name ? " on" : ""}`} onClick={() => pick(asStand(t), t.zones, t.name, t.kind === "stand" ? { id: t.id, version: t.version } : undefined)}>
          <Thumb stand={asStand(t)} />
          <span className="grow"><b>{t.name}</b><small>{t.kind === "stand" ? tx("Tribuna") : tx("Sektor")}{" "}{tx("· {0} o‘rin", t.seats)}{t.linked_in ? tx(" · {0} bog‘langan", t.linked_in) : ""}{t.visibility === "private" ? tx(" · faqat menga") : ""}</small></span>
          {t.mine && <button className="btn btn-ghost btn-icon btn-sm" title={tx("O‘chirish")} onClick={async (e) => {
            e.stopPropagation();
            if (!(await confirm({ title: tx("«{0}» shablonini o‘chirish?", t.name), ok: tx("O‘chirish"), danger: true }))) return;
            await api.del(`/admin/layout-templates/${t.id}`); toast(tx("O‘chirildi")); reload();
          }}><I.trash size={14} /></button>}
        </div>
      ))}
      {others.length > 0 && <div className="st-lib-group">{tx("Boshqa sxemalardan")}{" "}<small>{others.length}</small></div>}
      {others.map((s) => (
        <div key={`${s.layout_id}-${s.stand.key}`} className="st-lib-item" onClick={() => pick(s.stand, s.zones, s.name)}>
          <Thumb stand={s.stand} />
          <span className="grow"><b>{s.name || tx("Tribuna")}</b><small>{s.venue_name}{" "}{tx("v{0} · {1} o‘rin", s.version, s.seats)}</small></span>
        </div>
      ))}
      <div className="muted small" style={{ padding: "8px 4px" }}>{tx("Shablonni tanlang va sxemaga bosing")}</div>
    </div>
  );
}

function Thumb({ stand }: { stand: Stand }) {
  const l: Layout = { pitch: { x: 0, y: 0, w: 0, h: 0 }, zones: [], gates: [], stands: [{ ...stand, x: 0, y: 0, rotation: 0 }] };
  return <div className="st-lib-thumb"><StadiumCanvas layout={l} height={44} /></div>;
}

function PlaceSettings({ p, onChange, total }: { p: PlaceState; onChange: (p: PlaceState | null) => void; total: number }) {
  const n = standSeats(p.stand);
  return (
    <div className="st-insp">
      <div className="st-insp-head"><h3>{tx("Shablonni qo‘yish")}</h3><small>{p.name}{" "}{tx("· {0} sektor", p.stand.sections.length)}</small></div>
      <Field label={tx("Tribuna nomi")}><input className="input" value={p.name} onChange={(e) => onChange({ ...p, name: e.target.value })} /></Field>
      <Field label={tx("Sektor prefiksi")} hint={p.prefix ? `${p.prefix}1, ${p.prefix}2…` : tx("Asl nomlar saqlanadi (takrorlansa -2 qo‘shiladi)")}><input className="input" value={p.prefix} maxLength={4} onChange={(e) => onChange({ ...p, prefix: e.target.value.replace(/[^A-Za-z0-9]/g, "") })} /></Field>
      <Field label={tx("Burilish: {0}°", p.stand.rotation)}><input type="range" min={-180} max={180} step={5} value={p.stand.rotation} onChange={(e) => onChange({ ...p, stand: { ...p.stand, rotation: Number(e.target.value) } })} /></Field>
      <div className="label">{tx("Nusxa turi")}</div>
      <label className={`tk-choice${!p.linked ? " on" : ""}`}><input type="radio" checked={!p.linked} onChange={() => onChange({ ...p, linked: false })} /><span><b>{tx("Mustaqil nusxa")}</b><small>{tx("Bu sxemada erkin tahrirlanadi")}</small></span></label>
      <label className={`tk-choice${p.linked ? " on" : ""}${!p.canLink ? " off" : ""}`}><input type="radio" disabled={!p.canLink} checked={p.linked} onChange={() => onChange({ ...p, linked: true })} /><span><b>{tx("Bog‘langan nusxa")}</b><small>{p.canLink ? tx("Shablon raqami saqlanadi — keyin yangilashni ko‘rasiz") : tx("Faqat kutubxonadagi tribuna shablonlari uchun")}</small></span></label>
      <div className="tk-sum"><b>{tx("+{0} o‘rin → jami", n)}{" "}{(total + n).toLocaleString("ru-RU")}</b><small>{tx("Bloklangan o‘rinlar, yo‘laklar va kirishlar shablondan olinadi")}</small></div>
      <div className="muted small">{tx("Endi sxemaning kerakli joyiga bosing.")}</div>
      <button className="btn btn-ghost" onClick={() => onChange(null)}>{tx("Bekor qilish (Esc)")}</button>
    </div>
  );
}

/* ---------- S7 · save as template ---------- */
function SaveTemplate({ layout, target, onClose, onSaved }: { layout: Layout; target: { kind: "stand" | "section"; stand: string; section?: string }; onClose: () => void; onSaved: (t: { id: number }, link: boolean) => void }) {
  const toast = useToast();
  const st = layout.stands.find((s) => s.key === target.stand)!;
  const sec = target.section ? st.sections.find((x) => x.key === target.section) : undefined;
  const [name, setName] = useState(sec ? tx("Sektor {0}", sec.name) : st.name);
  const [desc, setDesc] = useState("");
  const [opt, setOpt] = useState({ zones: true, blocked: true, gates: true, link: false });
  const [vis, setVis] = useState<"all" | "private">("all");
  const [busy, setBusy] = useState(false);
  const seats = sec ? seatCount(sec) : standSeats(st);
  const save = async () => {
    setBusy(true);
    const strip = (s: Section): Section => ({ ...s, zone: opt.zones ? s.zone : "", gate: opt.gates ? s.gate : "", rows: s.rows.map((r) => ({ ...r, blocked: opt.blocked ? r.blocked : [], removed: opt.blocked ? r.removed : [], zone_seats: opt.zones ? r.zone_seats : undefined })) });
    const doc = sec ? { ...strip(sec), x: 0, y: 0 } : { ...st, x: 0, y: 0, template_id: null, sections: st.sections.map(strip) };
    const usedZones = new Set((sec ? [sec] : st.sections).flatMap((s) => [s.zone, ...s.rows.flatMap((r) => Object.keys(r.zone_seats || {}))]));
    try {
      const t = await api.post<{ id: number }>("/admin/layout-templates", { name, description: desc, kind: target.kind, doc, zones: opt.zones ? layout.zones.filter((z) => usedZones.has(z.key)) : [], visibility: vis });
      toast(tx("Kutubxonaga saqlandi"));
      onSaved(t, opt.link);
    } catch (e) { toast(e instanceof ApiError ? e.message : tx("Xato"), "error"); } finally { setBusy(false); }
  };
  return (
    <Modal title={tx("Shablon sifatida saqlash")} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>{tx("Bekor qilish")}</button><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>{tx("Kutubxonaga saqlash")}</button></>}>
      <div className="stack">
        <div className="tk-sum row"><Thumb stand={sec ? { ...st, sections: [sec] } : st} /><span><b>{sec ? tx("Sektor {0}", sec.name) : st.name}</b><small>{sec ? tx("1 sektor") : tx("{0} sektor", st.sections.length)}{" "}{tx("· {0} o‘rin", seats)}</small></span></div>
        <Field label={tx("Shablon nomi")}><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={tx("Izoh")} hint={tx("Kutubxonada nom ostida ko‘rinadi")}><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        <div className="label">{tx("Nimalar saqlanadi")}</div>
        <label className="toggle-row"><span><b>{tx("Zonalar")}</b></span><input type="checkbox" className="switch lime" checked={opt.zones} onChange={(e) => setOpt({ ...opt, zones: e.target.checked })} /></label>
        <label className="toggle-row"><span><b>{tx("Bloklangan va o‘chirilgan o‘rinlar")}</b></span><input type="checkbox" className="switch lime" checked={opt.blocked} onChange={(e) => setOpt({ ...opt, blocked: e.target.checked })} /></label>
        <label className="toggle-row"><span><b>{tx("Kirishlar")}</b></span><input type="checkbox" className="switch lime" checked={opt.gates} onChange={(e) => setOpt({ ...opt, gates: e.target.checked })} /></label>
        {target.kind === "stand" && <label className="toggle-row"><span><b>{tx("Joriy tribunani shablonga bog‘lash")}</b><small>{tx("Shablon keyin o‘zgarsa, shu yerda belgi ko‘rinadi")}</small></span><input type="checkbox" className="switch lime" checked={opt.link} onChange={(e) => setOpt({ ...opt, link: e.target.checked })} /></label>}
        <div className="label">{tx("Kimga ko‘rinadi")}</div>
        <div className="seg block"><button className={vis === "private" ? "on" : ""} onClick={() => setVis("private")}>{tx("Faqat menga")}</button><button className={vis === "all" ? "on" : ""} onClick={() => setVis("all")}>{tx("Barcha adminlarga")}</button></div>
      </div>
    </Modal>
  );
}

/* ---------- S9 · versions ---------- */
function Versions({ venue, current, onClose, onDiff, onReload }: { venue: Venue; current: LayoutView | null; onClose: () => void; onDiff: (d: Record<string, string> | null) => void; onReload: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const [cmp, setCmp] = useState<number | null>(null);
  const [summary, setSummary] = useState<string>("");
  const compare = async (id: number) => {
    if (!current) return;
    const d = await api.get<{ sections: { key: string; change: string; seats: number; note: string }[]; seats_delta: number }>(`/admin/layouts/${id}/diff?with=${current.id}`);
    setCmp(id);
    onDiff(Object.fromEntries(d.sections.map((x) => [x.key, x.change === "added" ? tx("yangi") : x.change === "removed" ? tx("o‘chirilgan") : [x.seats ? (x.seats > 0 ? `+${x.seats}` : `${x.seats}`) : "", x.note].filter(Boolean).join(" ")])));
    setSummary(tx("{0} sektor o‘zgargan · {1}{2} o‘rin", d.sections.length, d.seats_delta >= 0 ? "+" : "", d.seats_delta));
  };
  const restore = async (id: number, v: number) => {
    if (!(await confirm({ title: tx("v{0} ni tiklash?", v), text: tx("Qoralama shu versiya bilan almashtiriladi. Nashr qilingan versiyalar va matchlar o‘zgarmaydi."), ok: tx("Tiklash") }))) return;
    try { await api.post(`/admin/venues/${venue.id}/draft/restore/${id}`); toast(tx("v{0} qoralamaga tiklandi", v)); onDiff(null); onReload(); } catch (e) { toast(e instanceof ApiError ? e.message : tx("Xato"), "error"); }
  };
  return (
    <div className="st-insp">
      <div className="st-insp-head row"><span className="grow"><h3>{tx("Versiyalar")}</h3><small>{venue.name} · {venue.versions?.length || 0}{" "}{tx("versiya")}</small></span><button className="btn btn-ghost btn-icon" onClick={() => { onDiff(null); onClose(); }}><I.x size={16} /></button></div>
      {summary && <div className="tk-note warn">{summary}</div>}
      {(venue.versions || []).map((v) => (
        <div key={v.id} className={`tk-ver${cmp === v.id ? " on" : ""}`}>
          <div className="row"><b>v{v.version}</b><span className={`badge ${v.status === "published" ? "ok" : v.status === "draft" ? "warn" : ""}`}>{v.status === "published" ? tx("Nashr qilingan") : v.status === "draft" ? tx("Qoralama") : tx("Arxiv")}</span><span className="grow" />{current?.id === v.id && <small className="muted">{tx("hozir")}</small>}</div>
          <small className="muted">{fmtDateTime(v.published_at || v.updated_at)} · {v.created_by || "—"}{" "}{tx("· {0} o‘rin", v.seats)}</small>
          {v.note && <div className="small">{v.note}</div>}
          {v.matches > 0 && <small className="muted">{v.matches}{" "}{tx("ta match ishlatadi")}</small>}
          {current?.id !== v.id && (
            <div className="row">
              <button className="btn btn-sm grow" onClick={() => compare(v.id)}>{tx("Solishtirish")}</button>
              <button className="btn btn-sm grow" onClick={() => restore(v.id, v.version)}>{tx("Tiklash")}</button>
              <button className="btn btn-sm" title={tx("Shu versiyadan yangi stadion")} onClick={() => nav(`/stadiums/new?layout=${v.id}`)}>{tx("Nusxa")}</button>
            </div>
          )}
        </div>
      ))}
      <div className="muted small">{tx("Tiklash — qoralamani almashtiradi. Nashr qilingan versiyalar o‘zgarmaydi: matchlar o‘z versiyasida qoladi.")}</div>
    </div>
  );
}
