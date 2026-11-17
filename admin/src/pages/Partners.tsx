import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router";
import { api, ApiError, request, uploadWithProgress, type Page } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { FormFields, useForm, type FieldSpec, type Rec } from "@/components/Crud";
import { PageHead, SITE_URL } from "@/components/Layout";
import { Empty, ErrorBox, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { fmtBytes } from "@/components/MatchPhotos";
import { probe } from "@/components/VideoSource";

/* ---------- shared ---------- */

export type Kind = "main" | "official" | "media";
export type Partner = {
  id: number; name: string; url: string; kind: Kind; description: string;
  logo_url: string; logo_name: string; logo_size: number | null;
  video_url: string; video_name: string; video_size: number | null; video_duration_sec: number | null;
  show_video: boolean; is_active: boolean; ord: number;
};
type Settings = { title: string; show_cta: boolean; show_block: boolean };

export const KINDS: { value: Kind; label: string; note: string }[] = [
  { value: "main", label: "Bosh homiy", note: "yirik logotip, birinchi qatorda" },
  { value: "official", label: "Rasmiy hamkor", note: "oddiy logotip" },
  { value: "media", label: "Media hamkor", note: "kichik logotip, oxirida" },
];
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label || k;

const MAX_VIDEO_MB = 100; // partnerVideoMaxBytes on the server
const VIDEO_ACCEPT = "video/mp4,video/webm,video/quicktime,.mp4,.m4v,.webm,.mov";
const LOGO_ACCEPT = "image/svg+xml,image/png,image/jpeg,image/webp,.svg,.png,.jpg,.jpeg,.webp";

/** «realme.com/uz» from «https://www.realme.com/uz/». */
export function hostOf(url: string) {
  try {
    const u = new URL(url);
    return (u.host.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "")) || url;
  } catch {
    return url;
  }
}
export const fmtDur = (s?: number | null) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

function KindBadge({ kind }: { kind: string }) {
  return <span className={`kind-badge k-${kind}`}>{kindLabel(kind)}</span>;
}

/** Logo tile of the list (96×48): the uploaded logo or the name. */
function LogoBox({ p }: { p: Pick<Partner, "name" | "logo_url"> }) {
  return <span className="pt-logo">{p.logo_url ? <img src={p.logo_url} alt="" /> : <b>{p.name}</b>}</span>;
}

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <input type="checkbox" role="switch" className="switch lime" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
}

function SwitchRow({ title, hint, checked, onChange }: { title: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="pt-switch-row">
      <span className="grow"><b>{title}</b><small>{hint}</small></span>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </label>
  );
}

export function PartnersPage() {
  return (
    <Routes>
      <Route index element={<PartnerList />} />
      <Route path="new" element={<PartnerEdit />} />
      <Route path=":id" element={<PartnerEdit />} />
    </Routes>
  );
}

/* ---------- P1 · list ---------- */

type Tab = "all" | "active" | "hidden";

function PartnerList() {
  const { data, error, loading, reload, setData } = useLoad(() => api.get<Page<Partner>>("/admin/partners?limit=200"), []);
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>("all");
  const [q, setQ] = useState("");
  const items = useMemo(() => data?.items || [], [data]);
  const counts = { all: items.length, active: items.filter((p) => p.is_active).length, hidden: items.filter((p) => !p.is_active).length };
  const term = q.trim().toLowerCase();
  const shown = items.filter((p) => (tab === "all" || (tab === "active") === p.is_active) && (!term || p.name.toLowerCase().includes(term)));
  const canDrag = tab === "all" && !term && items.length > 1;

  // drag & drop: the row follows the pointer, the order is saved on drop
  const dragId = useRef<number | null>(null);
  const before = useRef<Partner[] | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const setItems = (list: Partner[]) => setData({ items: list, total: list.length });
  function over(targetId: number) {
    const from = dragId.current;
    if (from == null || from === targetId) return;
    const list = items.slice();
    const i = list.findIndex((p) => p.id === from);
    const j = list.findIndex((p) => p.id === targetId);
    if (i < 0 || j < 0) return;
    list.splice(j, 0, list.splice(i, 1)[0]);
    setItems(list);
  }
  async function drop() {
    const was = before.current;
    dragId.current = null;
    before.current = null;
    setDragging(null);
    if (!was || was.map((p) => p.id).join() === items.map((p) => p.id).join()) return;
    try {
      await api.put("/admin/partners/order", items.map((p) => p.id));
      setItems(items.map((p, i) => ({ ...p, ord: i + 1 })));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
      reload();
    }
  }
  async function setActive(p: Partner, v: boolean) {
    setItems(items.map((x) => (x.id === p.id ? { ...x, is_active: v } : x)));
    try {
      await api.patch(`/admin/partners/${p.id}`, { is_active: v });
      toast(v ? `${p.name} saytda ko‘rsatiladi` : `${p.name} saytdan yashirildi`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
      reload();
    }
  }
  async function remove(p: Partner) {
    if (!(await confirm({ title: "Hamkorni o‘chirish", text: `${p.name} — logotip va video ham o‘chadi. Faqat yashirish uchun «Faol»ni o‘chiring.`, ok: "O‘chirish", danger: true }))) return;
    await api.del(`/admin/partners/${p.id}`).then(() => { toast("O‘chirildi"); reload(); }, (e) => toast(e.message, "error"));
  }

  const TABS: [Tab, string][] = [["all", "Barchasi"], ["active", "Faol"], ["hidden", "Yashirin"]];
  return (
    <>
      <PageHead title="Hamkorlar" sub="Homiylar va hamkorlar saytning bosh sahifasida logotip bilan chiqadi"
        actions={<>
          <a className="btn btn-dark" href={`${SITE_URL}/hamkorlar`} target="_blank" rel="noopener noreferrer">Saytda ko‘rish</a>
          <button className="btn btn-primary" onClick={() => navigate("/partners/new")}><I.plus size={16} /> Qo‘shish</button>
        </>} />
      <div className="pt-cols">
        <div className="stack" style={{ gap: 16, minWidth: 0 }}>
          <div className="pt-toolbar">
            <div className="tabs" role="tablist" style={{ margin: 0, borderBottom: 0 }}>
              {TABS.map(([k, label]) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label} · {counts[k]}</button>
              ))}
            </div>
            <div className="search pt-search">
              <I.search size={16} />
              <input className="input" type="search" placeholder="Hamkor nomi…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Hamkor nomi bo‘yicha qidirish" />
            </div>
          </div>
          <div className="card">
            {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : !shown.length ? (
              <Empty title={items.length ? "Hech narsa topilmadi" : "Hamkorlar yo‘q"} text={items.length ? undefined : "Birinchi homiyni qo‘shing — u bosh sahifada logotip bilan chiqadi."}
                action={!items.length && <button className="btn btn-primary" onClick={() => navigate("/partners/new")}><I.plus size={16} /> Qo‘shish</button>} />
            ) : (
              <div className="table-wrap"><table className="table pt-table">
                <thead><tr><th className="pt-c-drag" /><th className="pt-c-logo">Logotip</th><th>Nomi</th><th className="pt-c-kind">Turi</th><th className="pt-c-on center">Faol</th><th className="pt-c-act" /></tr></thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.id} className={`clickable${dragging === p.id ? " dragging" : ""}`} onClick={() => navigate(`/partners/${p.id}`)}
                      draggable={canDrag}
                      onDragStart={(e) => { dragId.current = p.id; before.current = items; setDragging(p.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(p.id)); }}
                      onDragOver={(e) => { if (dragId.current == null) return; e.preventDefault(); over(p.id); }}
                      onDrop={(e) => { e.preventDefault(); drop(); }}
                      onDragEnd={() => { if (dragId.current != null) drop(); }}>
                      <td className="pt-c-drag" onClick={(e) => e.stopPropagation()}>
                        <span className={`pt-handle${canDrag ? "" : " off"}`} title={canDrag ? "Sudrab tartibni o‘zgartiring" : "Tartib «Barchasi» ro‘yxatida, qidiruvsiz o‘zgaradi"}><I.menu size={16} /></span>
                      </td>
                      <td className="pt-c-logo"><LogoBox p={p} /></td>
                      <td>
                        <div className="pt-name"><b>{p.name}</b>
                          <span>{p.url ? hostOf(p.url) : "havola yo‘q"}{p.video_url && (p.show_video ? " · ▶ video" : " · video yashirin")}</span>
                        </div>
                      </td>
                      <td className="pt-c-kind"><KindBadge kind={p.kind} /></td>
                      <td className="pt-c-on center" onClick={(e) => e.stopPropagation()}><Toggle checked={p.is_active} onChange={(v) => setActive(p, v)} label={`${p.name} saytda`} /></td>
                      <td className="pt-c-act actions" onClick={(e) => e.stopPropagation()}>
                        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => navigate(`/partners/${p.id}`)} aria-label="Tahrirlash"><I.edit size={18} /></button>
                        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => remove(p)} aria-label="O‘chirish"><I.trash size={18} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
          {items.length > 1 && <p className="pt-note"><I.menu size={14} /> Tartibni o‘zgartirish uchun qatorni sudrang — saytda ham shu tartibda chiqadi</p>}
        </div>
        <aside className="stack" style={{ gap: 16 }}>
          <BlockSettingsCard />
          <div className="card">
            <div className="card-head pt-card-head"><h3>Turlar</h3></div>
            <div className="pt-kv">
              {KINDS.map((k) => <div key={k.value}><span>{k.label}</span><b>{k.note}</b></div>)}
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

function BlockSettingsCard() {
  const { data, error, reload } = useLoad(() => api.get<Settings>("/admin/partner-settings"), []);
  const [v, setV] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const toast = useToast();
  useEffect(() => { if (data) setV(data); }, [data]);
  async function save() {
    if (!v) return;
    setBusy(true);
    setErr("");
    try {
      setV(await api.put<Settings>("/admin/partner-settings", v));
      toast("Saqlandi");
    } catch (e) {
      if (e instanceof ApiError && e.fields.title) setErr(e.fields.title);
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <div className="card-head pt-card-head"><h3>Bosh sahifadagi blok</h3></div>
      <div className="card-pad stack" style={{ gap: 16 }}>
        {error ? <ErrorBox error={error} retry={reload} /> : !v ? <span className="muted small">Yuklanmoqda…</span> : (
          <>
            <div className="field">
              <label htmlFor="pt-title">Blok sarlavhasi</label>
              <input id="pt-title" className="input" value={v.title} maxLength={80} placeholder="Hamkorlar" aria-invalid={!!err || undefined} onChange={(e) => setV({ ...v, title: e.target.value })} />
              {err && <span className="err">{err}</span>}
            </div>
            <SwitchRow title="«Sizning brendingiz» kartochkasi" hint="Hamkorlik formasiga olib boradi" checked={v.show_cta} onChange={(x) => setV({ ...v, show_cta: x })} />
            <SwitchRow title="Blokni ko‘rsatish" hint="O‘chirilsa, bosh sahifada blok chiqmaydi" checked={v.show_block} onChange={(x) => setV({ ...v, show_block: x })} />
            <button className="btn btn-dark btn-block" onClick={save} disabled={busy}>{busy ? "Saqlanmoqda…" : "Saqlash"}</button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- P2 · add / edit (separate page) ---------- */

const MAIN: FieldSpec[] = [
  { name: "name", label: "Nomi", required: true, full: true, hint: "Logotip yuklanmasa, saytda shu nom yoziladi" },
  { name: "url", label: "Havola", type: "url", full: true, placeholder: "https://", hint: "Logotip bosilganda yangi oynada ochiladi (ixtiyoriy)" },
  { name: "kind", label: "Turi", type: "select", options: KINDS.map((k) => ({ value: k.value, label: k.label })) },
  { name: "ord", label: "Tartib", type: "number", hint: "Kichik raqam — oldinroq" },
  { name: "description", label: "Qisqa tavsif", type: "textarea", full: true, placeholder: "Masalan: To‘lov tizimi", hint: "«Hamkorlar» sahifasida nom ostida chiqadi (ixtiyoriy)" },
];
const HIDDEN: FieldSpec[] = ["logo_url", "logo_name", "video_url", "video_name"].map((name) => ({ name, label: name, hidden: true }));
const HIDDEN_NUM: FieldSpec[] = ["logo_size", "video_size", "video_duration_sec"].map((name) => ({ name, label: name, type: "number", nullable: true, hidden: true }));
const FLAGS: FieldSpec[] = [{ name: "show_video", label: "", type: "bool", hidden: true }, { name: "is_active", label: "", type: "bool", hidden: true }];
const FIELDS = [...MAIN, ...HIDDEN, ...HIDDEN_NUM, ...FLAGS];

function PartnerEdit() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const { data, error, loading, reload } = useLoad(async () => {
    const [item, list, settings] = await Promise.all([
      isNew ? Promise.resolve(null) : api.get<Partner>(`/admin/partners/${id}`),
      api.get<Page<Partner>>("/admin/partners?limit=200").catch(() => ({ items: [], total: 0 })),
      api.get<Settings>("/admin/partner-settings").catch(() => null),
    ]);
    return { item, list: list.items, settings };
  }, [id]);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  return <PartnerForm key={String(data.item?.id ?? "new")} item={data.item} list={data.list} settings={data.settings} />;
}

function PartnerForm({ item, list, settings }: { item: Partner | null; list: Partner[]; settings: Settings | null }) {
  const nextOrd = list.reduce((m, p) => Math.max(m, p.ord), 0) + 1;
  const form = useForm(FIELDS, item, { kind: "official", ord: nextOrd, show_video: true, is_active: true });
  const { values, set } = form;
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const snapshot = (v: Rec) => JSON.stringify({ ...v, __uploading: undefined });
  const [saved, setSaved] = useState(() => snapshot(values));
  const dirty = snapshot(values) !== saved;
  const uploading = !!values.__uploading;
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (uploading) return;
    setBusy(true);
    try {
      const body: Rec = form.payload();
      if (values.ord === "" || values.ord == null) delete body.ord; // the server puts it last
      const r = item ? await api.patch<Partner>(`/admin/partners/${item.id}`, body) : await api.post<Partner>("/admin/partners", body);
      toast("Saqlandi");
      setSaved(snapshot(values));
      if (!item) navigate(`/partners/${r.id}`, { replace: true });
    } catch (err) {
      form.fail(err);
      toast(err instanceof Error ? err.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (dirty && !(await confirm({ title: "O‘zgarishlar saqlanmagan", text: "Sahifadan chiqsangiz, o‘zgarishlar yo‘qoladi.", ok: "Chiqish", danger: true }))) return;
    navigate("/partners");
  }
  async function remove() {
    if (!item || !(await confirm({ title: "Hamkorni o‘chirish", text: `${item.name} — logotip va video ham o‘chadi.`, ok: "O‘chirish", danger: true }))) return;
    try {
      await api.del(`/admin/partners/${item.id}`);
      toast("O‘chirildi");
      navigate("/partners", { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }

  const name = String(values.name || "").trim();
  const title = item ? name || item.name : name || "Yangi hamkor";
  const neighbour = list.filter((p) => p.is_active && p.id !== item?.id)[0];
  return (
    <form onSubmit={save}>
      <PageHead pre={<span className="crumbs"><Link to="/partners" onClick={(e) => { e.preventDefault(); cancel(); }}>Hamkorlar</Link> / <b>{item ? item.name : "Yangi"}</b>{dirty && <span className="muted"> · saqlanmagan o‘zgarishlar</span>}</span>}
        title={title}
        actions={<>
          <button type="button" className="btn btn-ghost" onClick={cancel}>Bekor qilish</button>
          <button type="submit" className="btn btn-primary" disabled={busy || uploading} title={uploading ? "Video yuklanmoqda…" : undefined}>{busy ? "Saqlanmoqda…" : "Saqlash"}</button>
        </>} />
      <div className="edit-layout">
        <div className="stack" style={{ gap: 24, minWidth: 0 }}>
          <div className="card">
            <div className="card-head pt-card-head"><h3>Asosiy ma’lumotlar</h3></div>
            <div className="card-pad"><FormFields fields={MAIN} values={values} set={set} errors={form.errors} /></div>
          </div>
          <LogoCard values={values} set={set} error={form.errors.logo_url} />
          <VideoCard values={values} set={set} error={form.errors.video_url} />
        </div>
        <aside className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head pt-card-head"><h3>Holat</h3></div>
            <div className="card-pad">
              <SwitchRow title="Saytda ko‘rsatish" hint="O‘chirilsa, hamkor saqlanadi, lekin saytda chiqmaydi" checked={!!values.is_active} onChange={(v) => set("is_active", v)} />
            </div>
          </div>
          <div className="card">
            <div className="card-head pt-card-head"><h3>Saytda ko‘rinishi</h3></div>
            <div className="card-pad pt-preview">
              <span className="pt-overline">{settings?.title || "Hamkorlar"}</span>
              <div className="pt-preview-row">
                <PreviewTile name={name || "Nomi"} logo={values.logo_url} video={!!values.video_url && !!values.show_video} strong />
                {neighbour ? <PreviewTile name={neighbour.name} logo={neighbour.logo_url} /> : <span className="pt-tile dashed">+ Sizning brendingiz</span>}
              </div>
              <p className="pt-hint">{values.video_url && values.show_video ? "▶ — hamkorning videosi bor: plitka bosilganda video ochiladi" : values.url ? "Plitka bosilganda hamkor sayti yangi oynada ochiladi" : "Havola va video yo‘q — plitka bosilmaydi"}{!values.is_active && " · hozir saytda yashirin"}</p>
            </div>
          </div>
          {item && <button type="button" className="pt-delete" onClick={remove}><I.trash size={16} /> Hamkorni o‘chirish</button>}
        </aside>
      </div>
    </form>
  );
}

function PreviewTile({ name, logo, video, strong }: { name: string; logo?: string; video?: boolean; strong?: boolean }) {
  return (
    <span className={`pt-tile${strong ? " strong" : ""}`}>
      {logo ? <img src={logo} alt="" /> : <b>{name}</b>}
      {video && <i className="pt-play-badge"><I.play size={12} /></i>}
    </span>
  );
}

type CardProps = { values: Rec; set: (k: string, v: any) => void; error?: string };

/** Drop target that also opens the file picker on click / Enter. */
function DropZone({ onFile, accept, disabled, className, children }: { onFile: (f: File) => void; accept: string; disabled?: boolean; className?: string; children: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const open = () => !disabled && input.current?.click();
  return (
    <div className={`pt-drop${over ? " over" : ""}${disabled ? " disabled" : ""} ${className || ""}`} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined}
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f && !disabled) onFile(f); }}>
      {children}
      <input ref={input} type="file" accept={accept} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </div>
  );
}

function LogoCard({ values, set, error }: CardProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const logo: string = values.logo_url || "";
  async function pick(f: File) {
    if (!/\.(svg|png|jpe?g|webp)$/i.test(f.name) && !/^image\/(svg\+xml|png|jpeg|webp)$/.test(f.type)) {
      toast("Faqat SVG, PNG, JPG yoki WebP", "error");
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      toast("Logotip 5 MB dan katta bo‘lmasligi kerak", "error");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await request<{ url: string; size: number }>("POST", "/admin/partner-logos", fd);
      set("logo_url", r.url);
      set("logo_name", f.name.slice(-200));
      set("logo_size", String(r.size));
      toast("Logotip yuklandi — saqlashni unutmang");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Yuklashda xato", "error");
    } finally {
      setBusy(false);
    }
  }
  const meta = [values.logo_name, values.logo_size ? fmtBytes(Number(values.logo_size)) : ""].filter(Boolean).join(" · ");
  return (
    <div className="card">
      <div className="card-head pt-card-head"><h3>Logotip</h3><span className="pt-head-note">SVG yoki PNG · shaffof fon · kamida 400 px kenglik</span></div>
      <div className="card-pad stack" style={{ gap: 8 }}>
        <b className="pt-label">Asosiy logotip</b>
        <DropZone onFile={pick} accept={LOGO_ACCEPT} disabled={busy}>
          {busy ? <span className="pt-sub">Yuklanmoqda…</span> : logo ? (
            <>
              <span className="pt-logo-chip"><img src={logo} alt={String(values.name || "")} /></span>
              <span className="pt-sub">{meta || "Yuklangan logotip"} · almashtirish uchun bosing</span>
            </>
          ) : (
            <>
              {values.name ? <span className="pt-logo-chip"><b>{values.name}</b></span> : <I.upload size={24} />}
              <b className="pt-drop-title">Logotipni shu yerga tashlang yoki tanlang</b>
              <span className="pt-sub">SVG, PNG, JPG yoki WebP · 5 MB gacha</span>
            </>
          )}
        </DropZone>
        <div className="pt-row-between">
          <span className="pt-sub">Saytda kulrang ko‘rinadi, kursor olib borilganda — rangli</span>
          {logo && (
            <span className="pt-links">
              <button type="button" onClick={() => picker.current?.click()}><I.refresh size={14} /> Almashtirish</button>
              <button type="button" className="danger" onClick={() => { set("logo_url", ""); set("logo_name", ""); set("logo_size", ""); }}><I.trash size={14} /> O‘chirish</button>
            </span>
          )}
        </div>
        {error && <span className="err small">{error}</span>}
        <input ref={picker} type="file" accept={LOGO_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
      </div>
    </div>
  );
}

type Up = { name: string; size: number; share: number; sent: boolean };

function VideoCard({ values, set, error }: CardProps) {
  const toast = useToast();
  const abort = useRef<AbortController | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [up, setUp] = useState<Up | null>(null);
  const [playing, setPlaying] = useState(false);
  const url: string = values.video_url || "";
  const showVideo = !!values.show_video;
  useEffect(() => () => abort.current?.abort(), []); // leaving the page stops the upload
  useEffect(() => setPlaying(false), [url]);

  async function pick(file: File) {
    if (up) return;
    if (!/\.(mp4|m4v|webm|mov)$/i.test(file.name) && !/^video\/(mp4|webm|quicktime)$/.test(file.type)) {
      toast("Faqat MP4 yoki WebM video yuklash mumkin", "error");
      return;
    }
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
      toast(`Video ${MAX_VIDEO_MB} MB dan katta bo‘lmasligi kerak`, "error");
      return;
    }
    const ctl = new AbortController();
    abort.current = ctl;
    setUp({ name: file.name, size: file.size, share: 0, sent: false });
    set("__uploading", true);
    const probing = probe(file);
    try {
      const r = await uploadWithProgress<{ url: string; size: number }>("/admin/video-uploads/partner", file,
        (share) => setUp((u) => u && { ...u, share }),
        () => setUp((u) => u && { ...u, sent: true }),
        ctl.signal);
      const { duration } = await probing;
      set("video_url", r.url);
      set("video_name", file.name.slice(-200));
      set("video_size", String(r.size));
      set("video_duration_sec", duration ? String(duration) : "");
      toast("Video yuklandi — saqlashni unutmang");
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "aborted")) toast(e instanceof Error ? e.message : "Yuklashda xato", "error");
    } finally {
      abort.current = null;
      setUp(null);
      set("__uploading", false);
    }
  }
  function clear() {
    set("video_url", "");
    set("video_name", "");
    set("video_size", "");
    set("video_duration_sec", "");
  }

  const pct = up ? Math.round(up.share * 100) : 0;
  const meta = [values.video_name || "Yuklangan video", fmtDur(Number(values.video_duration_sec)), values.video_size ? fmtBytes(Number(values.video_size)) : ""].filter(Boolean).join(" · ");
  const uploader = (
    <div className="stack" style={{ gap: 8, minWidth: 0 }}>
      <b className="pt-label">{url ? "Yangi video yuklash" : "Video yuklash"}</b>
      <DropZone onFile={pick} accept={VIDEO_ACCEPT} disabled={!!up}>
        <I.upload size={24} />
        <b className="pt-drop-title">{up ? up.name : "Videoni shu yerga tashlang yoki tanlang"}</b>
        <span className="pt-sub">MP4 yoki WebM · {MAX_VIDEO_MB} MB gacha · 16:9 tavsiya</span>
      </DropZone>
      {up && (
        <div className="pt-progress-row">
          <div className="pt-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
          <span className="pt-sub">{up.sent ? "Saqlanmoqda…" : `Yuklanmoqda ${pct}%`}</span>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => abort.current?.abort()} aria-label="Yuklashni bekor qilish"><I.x size={14} /></button>
        </div>
      )}
    </div>
  );
  return (
    <div className="card">
      <div className="card-head pt-card-head"><h3>Video</h3><span className="pt-head-note">ixtiyoriy</span></div>
      <div className="pt-mode">
        <span className="grow"><b>Saytda nima ko‘rinadi</b><small>Video yuklangan bo‘lsa ham, «Faqat logotip» tanlansa sayt videoni ko‘rsatmaydi (video o‘chmaydi)</small></span>
        <div className="seg-soft" role="group" aria-label="Saytda nima ko‘rinadi">
          <button type="button" aria-pressed={showVideo} onClick={() => set("show_video", true)}><I.play size={16} /> Video</button>
          <button type="button" aria-pressed={!showVideo} onClick={() => set("show_video", false)}><I.image size={16} /> Faqat logotip</button>
        </div>
      </div>
      <div className={`card-pad pt-video-grid${url ? "" : " single"}`}>
        {url && (
          <div className="stack" style={{ gap: 8, minWidth: 0 }}>
            <b className="pt-label">Yuklangan video</b>
            {playing
              ? <video className="pt-video" src={url} controls autoPlay playsInline />
              : (
                <button type="button" className="pt-video" onClick={() => setPlaying(true)} aria-label="Videoni ko‘rish">
                  <video src={`${url}#t=0.1`} preload="metadata" muted playsInline aria-hidden tabIndex={-1} />
                  <i className="pt-play-big"><I.play size={22} /></i>
                  <span>{meta}</span>
                </button>
              )}
            <span className="pt-links">
              <button type="button" onClick={() => picker.current?.click()} disabled={!!up}><I.refresh size={14} /> Almashtirish</button>
              <button type="button" className="danger" onClick={clear} disabled={!!up}><I.trash size={14} /> O‘chirish</button>
            </span>
          </div>
        )}
        {uploader}
      </div>
      <p className="pt-foot">{error ? <span className="err">{error}</span> : "Saytda logotip plitkasida ▶ belgisi chiqadi; bosilganda video oynada ochiladi. Muqova — videoning birinchi kadri."}</p>
      <input ref={picker} type="file" accept={VIDEO_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
    </div>
  );
}
