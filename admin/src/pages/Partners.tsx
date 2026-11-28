import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Allowed } from "@/lib/auth";
import { Link, Route, Routes, useNavigate, useParams } from "react-router";
import { api, ApiError, request, uploadWithProgress, type Page } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { FormFields, useForm, type FieldSpec, type Rec } from "@/components/Crud";
import { PageHead, SITE_URL } from "@/components/Layout";
import { Empty, ErrorBox, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { fmtBytes } from "@/components/MatchPhotos";
import { probe } from "@/components/VideoSource";

import { tx } from "@/lib/i18n";
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
  { value: "main", label: tx("Bosh homiy"), note: tx("yirik logotip, birinchi qatorda") },
  { value: "official", label: tx("Rasmiy hamkor"), note: tx("oddiy logotip") },
  { value: "media", label: tx("Media hamkor"), note: tx("kichik logotip, oxirida") },
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
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
      reload();
    }
  }
  async function setActive(p: Partner, v: boolean) {
    setItems(items.map((x) => (x.id === p.id ? { ...x, is_active: v } : x)));
    try {
      await api.patch(`/admin/partners/${p.id}`, { is_active: v });
      toast(v ? tx("{0} saytda ko‘rsatiladi", p.name) : tx("{0} saytdan yashirildi", p.name));
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
      reload();
    }
  }
  async function remove(p: Partner) {
    if (!(await confirm({ title: tx("Hamkorni o‘chirish"), text: tx("{0} — logotip va video ham o‘chadi. Faqat yashirish uchun «Faol»ni o‘chiring.", p.name), ok: tx("O‘chirish"), danger: true }))) return;
    await api.del(`/admin/partners/${p.id}`).then(() => { toast(tx("O‘chirildi")); reload(); }, (e) => toast(e.message, "error"));
  }

  const TABS: [Tab, string][] = [["all", tx("Barchasi")], ["active", tx("Faol")], ["hidden", tx("Yashirin")]];
  return (
    <>
      <PageHead title={tx("Hamkorlar")} sub={tx("Homiylar va hamkorlar saytning bosh sahifasida logotip bilan chiqadi")}
        actions={<>
          <a className="btn btn-dark" href={`${SITE_URL}/hamkorlar`} target="_blank" rel="noopener noreferrer">{tx("Saytda ko‘rish")}</a>
          <Allowed to="create"><button className="btn btn-primary" onClick={() => navigate("/partners/new")}><I.plus size={16} />{" "}{tx("Qo‘shish")}</button></Allowed>
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
              <input className="input" type="search" placeholder={tx("Hamkor nomi…")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tx("Hamkor nomi bo‘yicha qidirish")} />
            </div>
          </div>
          <div className="card">
            {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : !shown.length ? (
              <Empty title={items.length ? tx("Hech narsa topilmadi") : tx("Hamkorlar yo‘q")} text={items.length ? undefined : tx("Birinchi homiyni qo‘shing — u bosh sahifada logotip bilan chiqadi.")}
                action={!items.length && <Allowed to="create"><button className="btn btn-primary" onClick={() => navigate("/partners/new")}><I.plus size={16} />{" "}{tx("Qo‘shish")}</button></Allowed>} />
            ) : (
              <div className="table-wrap"><table className="table pt-table">
                <thead><tr><th className="pt-c-drag" /><th className="pt-c-logo">{tx("Logotip")}</th><th>{tx("Nomi")}</th><th className="pt-c-kind">{tx("Turi")}</th><th className="pt-c-on center">{tx("Faol")}</th><th className="pt-c-act" /></tr></thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.id} className={`clickable${dragging === p.id ? " dragging" : ""}`} onClick={() => navigate(`/partners/${p.id}`)}
                      draggable={canDrag}
                      onDragStart={(e) => { dragId.current = p.id; before.current = items; setDragging(p.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(p.id)); }}
                      onDragOver={(e) => { if (dragId.current == null) return; e.preventDefault(); over(p.id); }}
                      onDrop={(e) => { e.preventDefault(); drop(); }}
                      onDragEnd={() => { if (dragId.current != null) drop(); }}>
                      <td className="pt-c-drag" onClick={(e) => e.stopPropagation()}>
                        <span className={`pt-handle${canDrag ? "" : " off"}`} title={canDrag ? tx("Sudrab tartibni o‘zgartiring") : tx("Tartib «Barchasi» ro‘yxatida, qidiruvsiz o‘zgaradi")}><I.menu size={16} /></span>
                      </td>
                      <td className="pt-c-logo"><LogoBox p={p} /></td>
                      <td>
                        <div className="pt-name"><b>{p.name}</b>
                          <span>{p.url ? hostOf(p.url) : tx("havola yo‘q")}{p.video_url && (p.show_video ? tx(" · ▶ video") : tx(" · video yashirin"))}</span>
                        </div>
                      </td>
                      <td className="pt-c-kind"><KindBadge kind={p.kind} /></td>
                      <td className="pt-c-on center" onClick={(e) => e.stopPropagation()}><Toggle checked={p.is_active} onChange={(v) => setActive(p, v)} label={tx("{0} saytda", p.name)} /></td>
                      <td className="pt-c-act actions" onClick={(e) => e.stopPropagation()}>
                        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => navigate(`/partners/${p.id}`)} aria-label={tx("Tahrirlash")}><I.edit size={18} /></button>
                        <Allowed to="delete"><button className="btn btn-ghost btn-sm btn-icon" onClick={() => remove(p)} aria-label={tx("O‘chirish")}><I.trash size={18} /></button></Allowed>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
          {items.length > 1 && <p className="pt-note"><I.menu size={14} />{" "}{tx("Tartibni o‘zgartirish uchun qatorni sudrang — saytda ham shu tartibda chiqadi")}</p>}
        </div>
        <aside className="stack" style={{ gap: 16 }}>
          <BlockSettingsCard />
          <div className="card">
            <div className="card-head pt-card-head"><h3>{tx("Turlar")}</h3></div>
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
      toast(tx("Saqlandi"));
    } catch (e) {
      if (e instanceof ApiError && e.fields.title) setErr(e.fields.title);
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <div className="card-head pt-card-head"><h3>{tx("Bosh sahifadagi blok")}</h3></div>
      <div className="card-pad stack" style={{ gap: 16 }}>
        {error ? <ErrorBox error={error} retry={reload} /> : !v ? <span className="muted small">{tx("Yuklanmoqda…")}</span> : (
          <>
            <div className="field">
              <label htmlFor="pt-title">{tx("Blok sarlavhasi")}</label>
              <input id="pt-title" className="input" value={v.title} maxLength={80} placeholder={tx("Hamkorlar")} aria-invalid={!!err || undefined} onChange={(e) => setV({ ...v, title: e.target.value })} />
              {err && <span className="err">{err}</span>}
            </div>
            <SwitchRow title={tx("«Sizning brendingiz» kartochkasi")} hint={tx("Hamkorlik formasiga olib boradi")} checked={v.show_cta} onChange={(x) => setV({ ...v, show_cta: x })} />
            <SwitchRow title={tx("Blokni ko‘rsatish")} hint={tx("O‘chirilsa, bosh sahifada blok chiqmaydi")} checked={v.show_block} onChange={(x) => setV({ ...v, show_block: x })} />
            <Allowed to="edit"><button className="btn btn-dark btn-block" onClick={save} disabled={busy}>{busy ? tx("Saqlanmoqda…") : tx("Saqlash")}</button></Allowed>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- P2 · add / edit (separate page) ---------- */

const MAIN: FieldSpec[] = [
  { name: "name", label: tx("Nomi"), required: true, full: true, hint: tx("Logotip yuklanmasa, saytda shu nom yoziladi") },
  { name: "url", label: tx("Havola"), type: "url", full: true, placeholder: "https://", hint: tx("Logotip bosilganda yangi oynada ochiladi (ixtiyoriy)") },
  { name: "kind", label: tx("Turi"), type: "select", options: KINDS.map((k) => ({ value: k.value, label: k.label })) },
  { name: "ord", label: tx("Tartib"), type: "number", hint: tx("Kichik raqam — oldinroq") },
  { name: "description", label: tx("Qisqa tavsif"), type: "textarea", full: true, placeholder: tx("Masalan: To‘lov tizimi"), hint: tx("«Hamkorlar» sahifasida nom ostida chiqadi (ixtiyoriy)") },
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
      toast(tx("Saqlandi"));
      setSaved(snapshot(values));
      if (!item) navigate(`/partners/${r.id}`, { replace: true });
    } catch (err) {
      form.fail(err);
      toast(err instanceof Error ? err.message : tx("Xato"), "error");
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (dirty && !(await confirm({ title: tx("O‘zgarishlar saqlanmagan"), text: tx("Sahifadan chiqsangiz, o‘zgarishlar yo‘qoladi."), ok: tx("Chiqish"), danger: true }))) return;
    navigate("/partners");
  }
  async function remove() {
    if (!item || !(await confirm({ title: tx("Hamkorni o‘chirish"), text: tx("{0} — logotip va video ham o‘chadi.", item.name), ok: tx("O‘chirish"), danger: true }))) return;
    try {
      await api.del(`/admin/partners/${item.id}`);
      toast(tx("O‘chirildi"));
      navigate("/partners", { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    }
  }

  const name = String(values.name || "").trim();
  const title = item ? name || item.name : name || tx("Yangi hamkor");
  const neighbour = list.filter((p) => p.is_active && p.id !== item?.id)[0];
  return (
    <form onSubmit={save}>
      <PageHead pre={<span className="crumbs"><Link to="/partners" onClick={(e) => { e.preventDefault(); cancel(); }}>{tx("Hamkorlar")}</Link> / <b>{item ? item.name : tx("Yangi")}</b>{dirty && <span className="muted">{" "}{tx("· saqlanmagan o‘zgarishlar")}</span>}</span>}
        title={title}
        actions={<>
          <button type="button" className="btn btn-ghost" onClick={cancel}>{tx("Bekor qilish")}</button>
          <Allowed to={item ? "edit" : "create"}><button type="submit" className="btn btn-primary" disabled={busy || uploading} title={uploading ? tx("Video yuklanmoqda…") : undefined}>{busy ? tx("Saqlanmoqda…") : tx("Saqlash")}</button></Allowed>
        </>} />
      <div className="edit-layout">
        <div className="stack" style={{ gap: 24, minWidth: 0 }}>
          <div className="card">
            <div className="card-head pt-card-head"><h3>{tx("Asosiy ma’lumotlar")}</h3></div>
            <div className="card-pad"><FormFields fields={MAIN} values={values} set={set} errors={form.errors} /></div>
          </div>
          <LogoCard values={values} set={set} error={form.errors.logo_url} />
          <VideoCard values={values} set={set} error={form.errors.video_url} />
        </div>
        <aside className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head pt-card-head"><h3>{tx("Holat")}</h3></div>
            <div className="card-pad">
              <SwitchRow title={tx("Saytda ko‘rsatish")} hint={tx("O‘chirilsa, hamkor saqlanadi, lekin saytda chiqmaydi")} checked={!!values.is_active} onChange={(v) => set("is_active", v)} />
            </div>
          </div>
          <div className="card">
            <div className="card-head pt-card-head"><h3>{tx("Saytda ko‘rinishi")}</h3></div>
            <div className="card-pad pt-preview">
              <span className="pt-overline">{settings?.title || tx("Hamkorlar")}</span>
              <div className="pt-preview-row">
                <PreviewTile name={name || "Nomi"} logo={values.logo_url} video={!!values.video_url && !!values.show_video} strong />
                {neighbour ? <PreviewTile name={neighbour.name} logo={neighbour.logo_url} /> : <span className="pt-tile dashed">{tx("+ Sizning brendingiz")}</span>}
              </div>
              <p className="pt-hint">{values.video_url && values.show_video ? tx("▶ — hamkorning videosi bor: plitka bosilganda video ochiladi") : values.url ? tx("Plitka bosilganda hamkor sayti yangi oynada ochiladi") : tx("Havola va video yo‘q — plitka bosilmaydi")}{!values.is_active && tx(" · hozir saytda yashirin")}</p>
            </div>
          </div>
          {item && <Allowed to="delete"><button type="button" className="pt-delete" onClick={remove}><I.trash size={16} />{" "}{tx("Hamkorni o‘chirish")}</button></Allowed>}
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
      toast(tx("Faqat SVG, PNG, JPG yoki WebP"), "error");
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      toast(tx("Logotip 5 MB dan katta bo‘lmasligi kerak"), "error");
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
      toast(tx("Logotip yuklandi — saqlashni unutmang"));
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Yuklashda xato"), "error");
    } finally {
      setBusy(false);
    }
  }
  const meta = [values.logo_name, values.logo_size ? fmtBytes(Number(values.logo_size)) : ""].filter(Boolean).join(" · ");
  return (
    <div className="card">
      <div className="card-head pt-card-head"><h3>{tx("Logotip")}</h3><span className="pt-head-note">{tx("SVG yoki PNG · shaffof fon · kamida 400 px kenglik")}</span></div>
      <div className="card-pad stack" style={{ gap: 8 }}>
        <b className="pt-label">{tx("Asosiy logotip")}</b>
        <DropZone onFile={pick} accept={LOGO_ACCEPT} disabled={busy}>
          {busy ? <span className="pt-sub">{tx("Yuklanmoqda…")}</span> : logo ? (
            <>
              <span className="pt-logo-chip"><img src={logo} alt={String(values.name || "")} /></span>
              <span className="pt-sub">{meta || tx("Yuklangan logotip")}{" "}{tx("· almashtirish uchun bosing")}</span>
            </>
          ) : (
            <>
              {values.name ? <span className="pt-logo-chip"><b>{values.name}</b></span> : <I.upload size={24} />}
              <b className="pt-drop-title">{tx("Logotipni shu yerga tashlang yoki tanlang")}</b>
              <span className="pt-sub">{tx("SVG, PNG, JPG yoki WebP · 5 MB gacha")}</span>
            </>
          )}
        </DropZone>
        <div className="pt-row-between">
          <span className="pt-sub">{tx("Saytda kulrang ko‘rinadi, kursor olib borilganda — rangli")}</span>
          {logo && (
            <span className="pt-links">
              <button type="button" onClick={() => picker.current?.click()}><I.refresh size={14} />{" "}{tx("Almashtirish")}</button>
              <button type="button" className="danger" onClick={() => { set("logo_url", ""); set("logo_name", ""); set("logo_size", ""); }}><I.trash size={14} />{" "}{tx("O‘chirish")}</button>
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
      toast(tx("Faqat MP4 yoki WebM video yuklash mumkin"), "error");
      return;
    }
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
      toast(tx("Video {0} MB dan katta bo‘lmasligi kerak", MAX_VIDEO_MB), "error");
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
      toast(tx("Video yuklandi — saqlashni unutmang"));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "aborted")) toast(e instanceof Error ? e.message : tx("Yuklashda xato"), "error");
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
  const meta = [values.video_name || tx("Yuklangan video"), fmtDur(Number(values.video_duration_sec)), values.video_size ? fmtBytes(Number(values.video_size)) : ""].filter(Boolean).join(" · ");
  const uploader = (
    <div className="stack" style={{ gap: 8, minWidth: 0 }}>
      <b className="pt-label">{url ? tx("Yangi video yuklash") : tx("Video yuklash")}</b>
      <DropZone onFile={pick} accept={VIDEO_ACCEPT} disabled={!!up}>
        <I.upload size={24} />
        <b className="pt-drop-title">{up ? up.name : tx("Videoni shu yerga tashlang yoki tanlang")}</b>
        <span className="pt-sub">{tx("MP4 yoki WebM · {0} MB gacha · 16:9 tavsiya", MAX_VIDEO_MB)}</span>
      </DropZone>
      {up && (
        <div className="pt-progress-row">
          <div className="pt-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
          <span className="pt-sub">{up.sent ? tx("Saqlanmoqda…") : tx("Yuklanmoqda {0}%", pct)}</span>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => abort.current?.abort()} aria-label={tx("Yuklashni bekor qilish")}><I.x size={14} /></button>
        </div>
      )}
    </div>
  );
  return (
    <div className="card">
      <div className="card-head pt-card-head"><h3>{tx("Video")}</h3><span className="pt-head-note">{tx("ixtiyoriy")}</span></div>
      <div className="pt-mode">
        <span className="grow"><b>{tx("Saytda nima ko‘rinadi")}</b><small>{tx("Video yuklangan bo‘lsa ham, «Faqat logotip» tanlansa sayt videoni ko‘rsatmaydi (video o‘chmaydi)")}</small></span>
        <div className="seg-soft" role="group" aria-label={tx("Saytda nima ko‘rinadi")}>
          <button type="button" aria-pressed={showVideo} onClick={() => set("show_video", true)}><I.play size={16} />{" "}{tx("Video")}</button>
          <button type="button" aria-pressed={!showVideo} onClick={() => set("show_video", false)}><I.image size={16} />{" "}{tx("Faqat logotip")}</button>
        </div>
      </div>
      <div className={`card-pad pt-video-grid${url ? "" : " single"}`}>
        {url && (
          <div className="stack" style={{ gap: 8, minWidth: 0 }}>
            <b className="pt-label">{tx("Yuklangan video")}</b>
            {playing
              ? <video className="pt-video" src={url} controls autoPlay playsInline />
              : (
                <button type="button" className="pt-video" onClick={() => setPlaying(true)} aria-label={tx("Videoni ko‘rish")}>
                  <video src={`${url}#t=0.1`} preload="metadata" muted playsInline aria-hidden tabIndex={-1} />
                  <i className="pt-play-big"><I.play size={22} /></i>
                  <span>{meta}</span>
                </button>
              )}
            <span className="pt-links">
              <button type="button" onClick={() => picker.current?.click()} disabled={!!up}><I.refresh size={14} />{" "}{tx("Almashtirish")}</button>
              <button type="button" className="danger" onClick={clear} disabled={!!up}><I.trash size={14} />{" "}{tx("O‘chirish")}</button>
            </span>
          </div>
        )}
        {uploader}
      </div>
      <p className="pt-foot">{error ? <span className="err">{error}</span> : tx("Saytda logotip plitkasida ▶ belgisi chiqadi; bosilganda video oynada ochiladi. Muqova — videoning birinchi kadri.")}</p>
      <input ref={picker} type="file" accept={VIDEO_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
    </div>
  );
}
