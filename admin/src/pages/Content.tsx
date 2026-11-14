import { CrudPage, CrudSection, type FieldSpec } from "@/components/Crud";
import { Badge, Crest } from "@/components/ui";
import { useRefs, invalidateRefs, activeSeason } from "@/lib/refs";
import { fmtDate, fmtDateTime, fmtUZS, POSITIONS } from "@/lib/format";
import { api, type Page } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { useState } from "react";
import { ImageInput, useToast } from "@/components/ui";
import type { Player, Team } from "@/lib/types";
import { SITE_URL } from "@/components/Layout";
import { TeamExtras } from "@/components/TeamExtras";
import { PlayerPhotoCard, TeamKitSection } from "@/components/Kit";

const GROUPS = ["A", "B", "C", "D", "E", "F", "G", "H"].map((g) => ({ value: g, label: `Guruh ${g}` }));

/* ---------- Teams ---------- */
export function TeamsPage() {
  const fields: FieldSpec[] = [
    { name: "name", label: "Nomi", required: true },
    { name: "slug", label: "Slug (URL)", type: "slug", slugFrom: "name", required: true, hint: "lotin harflari, raqamlar va «-»" },
    { name: "short_name", label: "Qisqa nomi", hint: "emblemada (3 belgigacha)" },
    { name: "group_label", label: "Guruh", type: "select", nullable: true, options: GROUPS, side: true },
    { name: "group_is_provisional", label: "Guruh taxminiy (rasman e’lon qilinmagan)", type: "bool", side: true },
    { name: "is_active", label: "Faol", type: "bool", side: true },
    { name: "crest_url", label: "Emblema", type: "image", side: true },
    { name: "colors", label: "Ranglar", type: "colors", hint: "#E5383B, #FFFFFF" },
    { name: "leader", label: "Sardor / yetakchi" },
    { name: "instagram", label: "Instagram", type: "url" },
    { name: "telegram", label: "Telegram", type: "url" },
    { name: "kit_url", label: "Forma", hidden: true },
  ];
  return (
    <CrudSection<Team & Record<string, any>> base="/teams" cards={(c) => <TeamKitSection c={c} />} onChanged={invalidateRefs} title="Jamoalar" resource="/admin/teams" singular="Jamoa" searchable fields={fields} defaults={{ is_active: true, group_is_provisional: true }}
      filters={[{ param: "group", label: "Guruh", options: GROUPS }]}
      columns={[
        { label: "Jamoa", render: (t) => <span className="row"><Crest team={t} /> <b>{t.name}</b></span> },
        { label: "Guruh", render: (t) => t.group_label ? <span>{t.group_label}{t.group_is_provisional && <span className="muted small"> · taxminiy</span>}</span> : <span className="muted">—</span> },
        { label: "Slug", render: (t) => <span className="muted">{t.slug}</span>, className: "hide-mobile" },
        { label: "Holat", render: (t) => t.is_active ? <Badge tone="ok">Faol</Badge> : <Badge>Arxiv</Badge> },
      ]}
      extra={(t) => <>
        <a className="btn btn-sm" style={{ marginTop: 20 }} href={`${SITE_URL}/jamoalar/${t.slug}`} target="_blank" rel="noreferrer">Saytda ko‘rish</a>
        <TeamExtras teamId={t.id} />
      </>}
    />
  );
}

/* ---------- Players ---------- */
export function PlayersPage() {
  const { teams } = useRefs();
  const teamOpts = teams.map((t) => ({ value: String(t.id), label: t.name }));
  const byId = new Map(teams.map((t) => [t.id, t]));
  const posOpts = Object.entries(POSITIONS).map(([value, label]) => ({ value, label }));
  const fields: FieldSpec[] = [
    { name: "full_name", label: "F.I.Sh.", required: true, full: true },
    { name: "team_id", label: "Jamoa", type: "select", nullable: true, numeric: true, options: teamOpts },
    { name: "number", label: "Raqam", type: "number", nullable: true,
      requiredIf: (v) => !!byId.get(Number(v.team_id))?.kit_has_number,
      hintFor: (v) => byId.get(Number(v.team_id))?.kit_has_number ? "Jamoa formasida raqam bor — AI rasmda shu raqamni chizadi" : undefined },
    { name: "position", label: "Amplua", type: "select", nullable: true, options: posOpts },
    { name: "is_active", label: "Faol", type: "bool", side: true },
    { name: "photo_url", label: "Rasm", hidden: true },
    { name: "instagram", label: "Instagram", type: "url" },
  ];
  return (
    <CrudSection<Player & Record<string, any>> base="/players" sideCards={(c) => <PlayerPhotoCard c={c} />} titleField="full_name" title="O‘yinchilar" resource="/admin/players" singular="O‘yinchi" searchable fields={fields} defaults={{ is_active: true }} reloadKey={teams.length}
      filters={[{ param: "team_id", label: "Jamoa", options: teamOpts }, { param: "position", label: "Amplua", options: posOpts }]}
      columns={[
        { label: "№", render: (p) => <b className="tnum">{p.number ?? "—"}</b> },
        { label: "O‘yinchi", render: (p) => <b>{p.full_name}</b> },
        { label: "Jamoa", render: (p) => { const t = p.team_id ? byId.get(p.team_id) : null; return t ? <span className="row"><Crest team={t} size={22} /> {t.name}</span> : <span className="muted">—</span>; } },
        { label: "Amplua", render: (p) => POSITIONS[p.position] || <span className="muted">—</span>, className: "hide-mobile" },
        { label: "Holat", render: (p) => p.is_active ? <Badge tone="ok">Faol</Badge> : <Badge>Nofaol</Badge>, className: "hide-mobile" },
      ]}
    />
  );
}

/* ---------- Seasons & stages ---------- */
const STAGE_KINDS = [
  { value: "group", label: "Guruh bosqichi" }, { value: "round_of_16", label: "1/8 final" }, { value: "quarter", label: "Chorak final" },
  { value: "semi", label: "Yarim final" }, { value: "final", label: "Final" }, { value: "other", label: "Boshqa" },
];
const STAGE_STATUS = [{ value: "scheduled", label: "Rejalashtirilgan" }, { value: "active", label: "Davom etmoqda" }, { value: "finished", label: "Yakunlangan" }];

export function SeasonsPage() {
  const { seasons } = useRefs();
  const seasonOpts = seasons.map((s) => ({ value: String(s.id), label: s.name }));
  return (
    <div className="stack" style={{ gap: 32 }}>
      <CrudPage edit="drawer" onChanged={invalidateRefs} title="Mavsumlar" resource="/admin/seasons" singular="Mavsum" defaults={{ is_active: false }}
        fields={[
          { name: "name", label: "Nomi", required: true },
          { name: "slug", label: "Slug", type: "slug", slugFrom: "name", required: true },
          { name: "teams_planned", label: "Jamoalar soni", type: "number", nullable: true },
          { name: "matches_planned", label: "Matchlar soni", type: "number", nullable: true },
          { name: "is_active", label: "Faol mavsum (saytda ko‘rsatiladi)", type: "bool", full: true },
        ]}
        columns={[
          { label: "Mavsum", render: (s) => <b>{s.name}</b> },
          { label: "Jamoalar", render: (s) => s.teams_planned ?? "—" },
          { label: "Matchlar", render: (s) => s.matches_planned ?? "—" },
          { label: "Holat", render: (s) => s.is_active ? <Badge tone="ok">Faol</Badge> : <Badge>Arxiv</Badge> },
        ]}
      />
      <CrudPage edit="drawer" onChanged={invalidateRefs} title="Bosqichlar" resource="/admin/stages" singular="Bosqich" limit={100} reloadKey={seasons.length}
        defaults={{ season_id: String(activeSeason(seasons)?.id || ""), kind: "group", status: "scheduled", ord: "1" }}
        filters={[{ param: "season_id", label: "Mavsum", options: seasonOpts }]}
        fields={[
          { name: "season_id", label: "Mavsum", type: "select", numeric: true, options: seasonOpts, required: true },
          { name: "name", label: "Nomi", required: true },
          { name: "kind", label: "Turi", type: "select", options: STAGE_KINDS },
          { name: "status", label: "Holat", type: "select", options: STAGE_STATUS },
          { name: "ord", label: "Tartib", type: "number" },
          { name: "note", label: "Izoh", type: "textarea" },
        ]}
        columns={[
          { label: "#", render: (s) => s.ord },
          { label: "Bosqich", render: (s) => <b>{s.name}</b> },
          { label: "Turi", render: (s) => STAGE_KINDS.find((k) => k.value === s.kind)?.label || s.kind },
          { label: "Holat", render: (s) => <Badge tone={s.status === "active" ? "live" : s.status === "finished" ? "" : "info"}>{STAGE_STATUS.find((k) => k.value === s.status)?.label}</Badge> },
          { label: "Izoh", render: (s) => <span className="muted small ellipsis" style={{ maxWidth: 320, display: "inline-block" }}>{s.note}</span>, className: "hide-mobile" },
        ]}
      />
    </div>
  );
}

/* ---------- News ---------- */
const NEWS_STATUS = [{ value: "draft", label: "Qoralama" }, { value: "published", label: "Nashr etilgan" }, { value: "scheduled", label: "Rejalashtirilgan" }];
export function NewsPage() {
  return (
    <CrudSection base="/news" title="Yangiliklar" resource="/admin/news" singular="Yangilik" searchable defaults={{ status: "draft", category: "LIGA" }}
      filters={[{ param: "status", label: "Holat", options: NEWS_STATUS }]}
      fields={[
        { name: "title", label: "Sarlavha", required: true, full: true },
        { name: "slug", label: "Slug (URL)", type: "slug", slugFrom: "title", required: true, full: true },
        { name: "category", label: "Rukn", placeholder: "LIGA, ANONS, NATIJA…" },
        { name: "status", label: "Holat", type: "select", options: NEWS_STATUS, side: true },
        { name: "published_at", label: "Nashr vaqti (Toshkent)", type: "datetime", hint: "Nashr/rejalashtirish uchun majburiy", side: true },
        { name: "on_home", label: "Bosh sahifada ko‘rsatish", type: "bool", side: true },
        { name: "excerpt", label: "Qisqa matn (lid)", type: "textarea" },
        { name: "body", label: "Matn", type: "markdown" },
        { name: "cover_url", label: "Muqova", type: "image", side: true },
        { name: "tags", label: "Teglar", type: "tags", hint: "vergul bilan" },
        { name: "match_id", label: "Bog‘langan match ID", type: "number", nullable: true },
        { name: "seo_description", label: "SEO tavsif (160 belgi)", type: "textarea" },
      ]}
      columns={[
        { label: "Sarlavha", render: (n) => <div><b>{n.title}</b><div className="muted small">{n.category}</div></div> },
        { label: "Holat", render: (n) => <Badge tone={n.status === "published" ? "ok" : n.status === "scheduled" ? "info" : ""}>{NEWS_STATUS.find((s) => s.value === n.status)?.label}</Badge> },
        { label: "Sana", render: (n) => <span className="nowrap">{n.published_at ? fmtDateTime(n.published_at) : "—"}</span>, className: "hide-mobile" },
        { label: "Ko‘rishlar", render: (n) => n.views, className: "hide-mobile" },
      ]}
      extra={(n) => n.status !== "draft" ? <a className="btn btn-sm" style={{ marginTop: 20 }} href={`${SITE_URL}/yangiliklar/${n.slug}`} target="_blank" rel="noreferrer">Saytda ko‘rish</a> : null}
    />
  );
}

/* ---------- Videos ---------- */
const VIDEO_KIND = [{ value: "highlight", label: "Sharh" }, { value: "interview", label: "Intervyu" }, { value: "announcement", label: "Anons" }, { value: "full", label: "To‘liq o‘yin" }];
export function VideosPage() {
  return (
    <CrudSection base="/videos" title="Videolar" resource="/admin/videos" singular="Video" defaults={{ kind: "highlight", status: "draft" }}
      filters={[{ param: "status", label: "Holat", options: [{ value: "draft", label: "Qoralama" }, { value: "published", label: "Nashr etilgan" }] }]}
      fields={[
        { name: "title", label: "Sarlavha", required: true, full: true },
        { name: "url", label: "Havola (YouTube)", type: "url", required: true, full: true },
        { name: "kind", label: "Turi", type: "select", options: VIDEO_KIND },
        { name: "status", label: "Holat", type: "select", options: [{ value: "draft", label: "Qoralama" }, { value: "published", label: "Nashr etilgan" }], side: true },
        { name: "match_id", label: "Match ID", type: "number", nullable: true },
        { name: "published_at", label: "Nashr vaqti", type: "datetime", side: true },
        { name: "duration_sec", label: "Davomiyligi (soniya)", type: "number", nullable: true },
        { name: "thumbnail_url", label: "Muqova (ixtiyoriy)", type: "image", hint: "Bo‘sh bo‘lsa YouTube muqovasi", side: true },
      ]}
      columns={[
        { label: "Video", render: (v) => <b>{v.title}</b> },
        { label: "Turi", render: (v) => VIDEO_KIND.find((k) => k.value === v.kind)?.label },
        { label: "Holat", render: (v) => v.status === "published" ? <Badge tone="ok">Nashr etilgan</Badge> : <Badge>Qoralama</Badge> },
        { label: "Sana", render: (v) => fmtDate(v.published_at), className: "hide-mobile" },
      ]}
    />
  );
}

/* ---------- Products ---------- */
const PRODUCT_STATUS = [{ value: "active", label: "Sotuvda" }, { value: "in_review", label: "Tekshiruvda" }, { value: "out_of_stock", label: "Tugagan" }, { value: "hidden", label: "Yashirin" }];
export function ProductsPage() {
  return (
    <CrudSection base="/products" title="Merch" resource="/admin/products" singular="Mahsulot" searchable defaults={{ status: "active", visible: true, ord: "0" }}
      filters={[{ param: "status", label: "Holat", options: PRODUCT_STATUS }]}
      fields={[
        { name: "name", label: "Nomi", required: true, full: true },
        { name: "slug", label: "Slug", type: "slug", slugFrom: "name", required: true },
        { name: "category", label: "Toifa", placeholder: "Kiyim, Aksessuar…" },
        { name: "price_uzs", label: "Narx (so‘m)", type: "number", required: true },
        { name: "sale_price_uzs", label: "Chegirma narxi", type: "number", nullable: true },
        { name: "status", label: "Holat", type: "select", options: PRODUCT_STATUS, side: true },
        { name: "ord", label: "Tartib", type: "number", side: true },
        { name: "visible", label: "Saytda ko‘rinadi", type: "bool", side: true },
        { name: "featured", label: "Bosh sahifada", type: "bool", side: true },
        { name: "external_url", label: "Sotib olish havolasi", type: "url", full: true },
        { name: "description", label: "Tavsif", type: "markdown" },
        { name: "images", label: "Rasmlar (URL, vergul bilan)", type: "tags", full: true, hint: "Birinchisi asosiy rasm. Rasm yuklash uchun «Rasm yuklash» maydonidan foydalaning." },
      ]}
      columns={[
        { label: "Mahsulot", render: (p) => <div><b>{p.name}</b><div className="muted small">{p.category}</div></div> },
        { label: "Narx", render: (p) => <span className="nowrap">{fmtUZS(p.sale_price_uzs ?? p.price_uzs)}</span> },
        { label: "Holat", render: (p) => <Badge tone={p.status === "active" ? "ok" : p.status === "in_review" ? "warn" : p.status === "out_of_stock" ? "danger" : ""}>{PRODUCT_STATUS.find((s) => s.value === p.status)?.label}</Badge> },
        { label: "Bosh sahifa", render: (p) => (p.featured ? "Ha" : "—"), className: "hide-mobile" },
      ]}
      extra={(p) => <ProductExtras productId={p.id} />}
    />
  );
}

function ProductExtras({ productId }: { productId: number }) {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get<Page<{ id: number; size: string; sku: string; stock: number | null; available: boolean }>>(`/admin/product-variants?product_id=${productId}&limit=100`), [productId]);
  const [size, setSize] = useState("");
  const [stock, setStock] = useState("");
  const [img, setImg] = useState("");
  async function add() {
    if (!size.trim()) return;
    try {
      await api.post("/admin/product-variants", { product_id: productId, size: size.trim(), stock: stock === "" ? null : Number(stock), available: true });
      setSize(""); setStock(""); reload();
    } catch (e) { toast(e instanceof Error ? e.message : "Xato", "error"); }
  }
  async function del(id: number) {
    try { await api.del(`/admin/product-variants/${id}`); reload(); } catch (e) { toast(e instanceof Error ? e.message : "Xato", "error"); }
  }
  async function toggle(v: { id: number; available: boolean }) {
    try { await api.patch(`/admin/product-variants/${v.id}`, { available: !v.available }); reload(); } catch (e) { toast(e instanceof Error ? e.message : "Xato", "error"); }
  }
  return (
    <div className="stack" style={{ marginTop: 28 }}>
      <hr className="sep" />
      <h3 style={{ fontSize: 15 }}>O‘lchamlar va qoldiq</h3>
      <table className="table">
        <thead><tr><th>O‘lcham</th><th>Qoldiq</th><th>Mavjud</th><th /></tr></thead>
        <tbody>
          {data?.items.map((v) => (
            <tr key={v.id}><td><b>{v.size}</b></td><td>{v.stock ?? "—"}</td><td><input type="checkbox" checked={v.available} onChange={() => toggle(v)} /></td><td className="actions"><button className="btn btn-ghost btn-sm" onClick={() => del(v.id)}>O‘chirish</button></td></tr>
          ))}
          <tr>
            <td><input className="input input-sm" placeholder="M, L, XL…" value={size} onChange={(e) => setSize(e.target.value)} /></td>
            <td><input className="input input-sm" type="number" value={stock} onChange={(e) => setStock(e.target.value)} /></td>
            <td colSpan={2} className="actions"><button className="btn btn-sm" onClick={add}>Qo‘shish</button></td>
          </tr>
        </tbody>
      </table>
      <h3 style={{ fontSize: 15, marginTop: 12 }}>Rasm yuklash</h3>
      <p className="muted small" style={{ margin: 0 }}>Yuklangan rasm havolasini nusxalab, «Rasmlar» maydoniga qo‘shing.</p>
      <ImageUploadHelper value={img} onChange={setImg} />
    </div>
  );
}
function ImageUploadHelper({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <ImageInput value={value} onChange={onChange} />;
}

/* ---------- Requests ---------- */
const REQ_STATUS = [{ value: "new", label: "Yangi" }, { value: "in_progress", label: "Jarayonda" }, { value: "closed", label: "Yopilgan" }];
const TOPIC: Record<string, string> = { partnership: "Hamkorlik", sponsorship: "Homiylik", team: "Jamoa", tickets: "Chiptalar", other: "Boshqa" };
export function RequestsPage() {
  return (
    <CrudSection base="/requests" titleField="name" title="Murojaatlar" sub="Saytdagi aloqa formasi orqali kelgan so‘rovlar" resource="/admin/requests" singular="Murojaat" searchable canCreate={false}
      filters={[{ param: "status", label: "Holat", options: REQ_STATUS }, { param: "topic", label: "Mavzu", options: Object.entries(TOPIC).map(([value, label]) => ({ value, label })) }]}
      fields={[
        { name: "status", label: "Holat", type: "select", options: REQ_STATUS, side: true },
        { name: "internal_note", label: "Ichki izoh", type: "textarea", side: true },
      ]}
      columns={[
        { label: "Sana", render: (r) => <span className="nowrap">{fmtDateTime(r.created_at)}</span> },
        { label: "Ism", render: (r) => <b>{r.name}</b> },
        { label: "Telefon", render: (r) => <a href={`tel:${r.phone.replace(/[^\d+]/g, "")}`} onClick={(e) => e.stopPropagation()}>{r.phone}</a> },
        { label: "Mavzu", render: (r) => TOPIC[r.topic] || r.topic, className: "hide-mobile" },
        { label: "Holat", render: (r) => <Badge tone={r.status === "new" ? "live" : r.status === "in_progress" ? "info" : ""}>{REQ_STATUS.find((s) => s.value === r.status)?.label}</Badge> },
      ]}
      extra={(r) => (
        <div className="stack" style={{ marginTop: 24, gap: 8 }}>
          <hr className="sep" />
          <div><span className="muted small">Ism</span><div className="b">{r.name}</div></div>
          <div><span className="muted small">Telefon</span><div className="b">{r.phone}</div></div>
          <div><span className="muted small">Mavzu</span><div>{TOPIC[r.topic] || r.topic}</div></div>
          <div><span className="muted small">Xabar</span><div style={{ whiteSpace: "pre-wrap" }}>{r.message || "—"}</div></div>
        </div>
      )}
    />
  );
}

