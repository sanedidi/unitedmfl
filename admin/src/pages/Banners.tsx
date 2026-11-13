import { useState } from "react";
import { api, type Page } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import { CrudDrawer, type FieldSpec, type Rec } from "@/components/Crud";
import { PageHead } from "@/components/Layout";
import { Badge, Empty, ErrorBox, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

const FIELDS: FieldSpec[] = [
  { name: "title", label: "Sarlavha", required: true, full: true },
  { name: "badge", label: "Belgi", placeholder: "FINAL, YARIM FINAL…" },
  { name: "badge_type", label: "Belgi rangi", type: "select", options: [
    { value: "accent", label: "Yashil (aksent)" }, { value: "stage", label: "To‘q ko‘k (bosqich)" }, { value: "category", label: "Kulrang (rukn)" }, { value: "live", label: "Pushti (jonli)" }, { value: "demo", label: "Demo" },
  ] },
  { name: "event_date", label: "Sana", type: "date" },
  { name: "event_time", label: "Vaqt", placeholder: "20:00" },
  { name: "venue", label: "Joy", full: true },
  { name: "cta_label", label: "Tugma matni", placeholder: "Chipta sotib olish" },
  { name: "cta_url", label: "Tugma havolasi", type: "url" },
  { name: "image_desktop", label: "Fon rasmi — desktop (2400×1100, muhim qismi markazda)", type: "image" },
  { name: "image_mobile", label: "Fon rasmi — mobil, ixtiyoriy (1080×1920, vertikal)", type: "image" },
  { name: "show_from", label: "Ko‘rsatish boshlanishi", type: "datetime" },
  { name: "show_until", label: "Ko‘rsatish tugashi", type: "datetime" },
  { name: "status", label: "Holat", type: "select", options: [{ value: "published", label: "Nashr etilgan" }, { value: "draft", label: "Qoralama" }] },
  { name: "is_active", label: "Faol", type: "bool" },
  { name: "note", label: "Ichki izoh", type: "textarea" },
];

export function BannersPage() {
  const { data, error, loading, reload, setData } = useLoad(() => api.get<Page<Rec>>("/admin/banners?limit=100"), []);
  const [edit, setEdit] = useState<Rec | null | undefined>(undefined);
  const toast = useToast();
  const confirm = useConfirm();
  const items = data?.items || [];

  async function move(i: number, d: -1 | 1) {
    const next = [...items];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setData({ items: next, total: next.length });
    try {
      await api.put("/admin/banners/order", next.map((b) => b.id));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
      reload();
    }
  }
  async function remove(b: Rec) {
    if (!(await confirm({ title: "Bannerni o‘chirish", text: b.title, ok: "O‘chirish", danger: true }))) return;
    await api.del(`/admin/banners/${b.id}`).then(() => { toast("O‘chirildi"); reload(); }, (e) => toast(e.message, "error"));
  }

  return (
    <>
      <PageHead title="Hero-bannerlar" sub="Bosh sahifadagi karusel. Tartib — saytdagi ketma-ketlik; avtoaylanish 5 soniya." actions={<button className="btn btn-primary" onClick={() => setEdit(null)}><I.plus size={16} /> Banner qo‘shish</button>} />
      <div className="card">
        {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : !items.length ? <Empty title="Bannerlar yo‘q" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Tartib</th><th>Banner</th><th className="hide-mobile">Sana</th><th>Holat</th><th /></tr></thead>
            <tbody>
              {items.map((b, i) => (
                <tr key={b.id} className="clickable" onClick={() => setEdit(b)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="row" style={{ gap: 2 }}>
                      <button className="btn btn-ghost btn-sm btn-icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Yuqoriga"><I.up size={16} /></button>
                      <button className="btn btn-ghost btn-sm btn-icon" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Pastga"><I.down size={16} /></button>
                    </div>
                  </td>
                  <td>
                    <div className="row">
                      <div className="img-preview wide" style={{ width: 96, height: 54, ...(b.image_desktop ? { backgroundImage: `url("${b.image_desktop}")` } : {}) }}>{!b.image_desktop && "—"}</div>
                      <div><b>{b.title}</b><div className="muted small">{b.badge}</div></div>
                    </div>
                  </td>
                  <td className="hide-mobile nowrap">{b.event_date ? fmtDate(b.event_date) : "—"} {b.event_time}</td>
                  <td>{b.status === "draft" ? <Badge>Qoralama</Badge> : b.is_active ? <Badge tone="ok">Faol</Badge> : <Badge tone="warn">O‘chirilgan</Badge>}</td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}><button className="btn btn-ghost btn-sm btn-icon" onClick={() => remove(b)} aria-label="O‘chirish"><I.trash size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
      {edit !== undefined && (
        <CrudDrawer title="Banner" resource="/admin/banners" fields={FIELDS} item={edit} defaults={{ badge_type: "accent", status: "draft", is_active: true }}
          onClose={() => setEdit(undefined)} onSaved={() => { setEdit(undefined); reload(); }} />
      )}
    </>
  );
}
