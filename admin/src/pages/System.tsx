import { useState } from "react";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { ROLE_LABEL, fmtDateTime } from "@/lib/format";
import { PageHead } from "@/components/Layout";
import { FormFields, useForm, type FieldSpec } from "@/components/Crud";
import { Badge, Drawer, ErrorBox, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

type U = { id: number; name: string; email: string; phone: string; telegram_linked: boolean; role: string; status: string; last_login_at: string | null; created_at: string };

// 998901234567 → +998 90 123 45 67
const fmtPhone = (p: string) => (p.length === 12 ? `+${p.slice(0, 3)} ${p.slice(3, 5)} ${p.slice(5, 8)} ${p.slice(8, 10)} ${p.slice(10)}` : `+${p}`);
const ROLES = Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }));

export function UsersPage() {
  const { data, error, loading, reload } = useLoad(() => api.get<U[]>("/admin/users"), []);
  const [edit, setEdit] = useState<U | null | undefined>(undefined);
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  async function remove(u: U) {
    if (!(await confirm({ title: "Foydalanuvchini o‘chirish", text: `${u.name} (${u.email})`, ok: "O‘chirish", danger: true }))) return;
    await api.del(`/admin/users/${u.id}`).then(() => { toast("O‘chirildi"); reload(); }, (e) => toast(e.message, "error"));
  }
  return (
    <>
      <PageHead title="Foydalanuvchilar" sub="Admin panelga kirish huquqiga ega xodimlar" actions={<button className="btn btn-primary" onClick={() => setEdit(null)}><I.plus size={16} /> Foydalanuvchi qo‘shish</button>} />
      <div className="card">
        {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading || !data ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Foydalanuvchi</th><th>Rol</th><th>Holat</th><th className="hide-mobile">Oxirgi kirish</th><th /></tr></thead>
            <tbody>{data.map((u) => (
              <tr key={u.id} className="clickable" onClick={() => setEdit(u)}>
                <td><span className="row"><span className="avatar">{u.name.slice(0, 2).toUpperCase()}</span><span><b>{u.name}</b>{u.id === user?.id && <span className="muted small"> (siz)</span>}<div className="muted small">{u.email}</div>{u.phone && <div className="muted small row" style={{ gap: 6 }}>{fmtPhone(u.phone)}{u.telegram_linked && <Badge tone="ok">Telegram</Badge>}</div>}</span></span></td>
                <td>{ROLE_LABEL[u.role] || u.role}</td>
                <td>{u.status === "active" ? <Badge tone="ok">Faol</Badge> : <Badge tone="danger">Bloklangan</Badge>}</td>
                <td className="hide-mobile nowrap">{u.last_login_at ? fmtDateTime(u.last_login_at) : "—"}</td>
                <td className="actions" onClick={(e) => e.stopPropagation()}>{u.id !== user?.id && <button className="btn btn-ghost btn-sm btn-icon" onClick={() => remove(u)} aria-label="O‘chirish"><I.trash size={16} /></button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {edit !== undefined && <UserDrawer item={edit} onClose={() => setEdit(undefined)} onSaved={() => { setEdit(undefined); reload(); }} />}
    </>
  );
}

function UserDrawer({ item, onClose, onSaved }: { item: U | null; onClose: () => void; onSaved: () => void }) {
  const fields: FieldSpec[] = [
    { name: "name", label: "Ism", required: true, full: true },
    { name: "email", label: "Email", required: true, full: true },
    { name: "role", label: "Rol", type: "select", options: ROLES },
    { name: "status", label: "Holat", type: "select", options: [{ value: "active", label: "Faol" }, { value: "blocked", label: "Bloklangan" }] },
    { name: "phone", label: "Telefon (Telegram Live-pult)", full: true, placeholder: "+998 90 123 45 67", hint: "Shu raqamli Telegram akkaunti Live-pult botiga kira oladi (operator va administrator). Bo‘sh qoldirilsa — botga kirish yo‘q." },
    { name: "password", label: item ? "Yangi parol (ixtiyoriy)" : "Parol", required: !item, full: true, hint: "Kamida 8 belgi" },
  ];
  const form = useForm(fields, item ? { ...item, phone: item.phone ? fmtPhone(item.phone) : "", password: "" } : null, { role: "editor", status: "active", phone: "" });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function save() {
    const body: Record<string, unknown> = form.payload();
    if (!body.password) delete body.password;
    setBusy(true);
    try {
      if (item) await api.patch(`/admin/users/${item.id}`, body);
      else await api.post("/admin/users", body);
      toast("Saqlandi");
      onSaved();
    } catch (e) {
      form.fail(e);
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer title={item ? item.name : "Yangi foydalanuvchi"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Bekor qilish</button><button className="btn btn-primary" onClick={save} disabled={busy}>Saqlash</button></>}>
      <FormFields fields={fields} values={form.values} set={form.set} errors={form.errors} />
      <div className="alert info" style={{ marginTop: 20 }}><I.alert size={16} /> Parolni xodimga xavfsiz kanal orqali yuboring va birinchi kirishdan so‘ng almashtirishni so‘rang.</div>
    </Drawer>
  );
}

const PERM: Record<string, string> = {
  dashboard: "Dashboard", "matches:read": "Matchlarni ko‘rish", "matches:edit": "Matchlarni tahrirlash", live: "Live-pult", protocols: "Protokollar",
  teams: "Jamoalar va o‘yinchilar", standings: "Turnir jadvali", seasons: "Mavsumlar", news: "Yangiliklar", banners: "Bannerlar", videos: "Videolar",
  merch: "Merch", requests: "Murojaatlar", users: "Foydalanuvchilar", uploads: "Fayl yuklash",
};
export function RolesPage() {
  const { data, error, loading, reload } = useLoad(() => api.get<{ role: string; permissions: string[] }[]>("/admin/roles"), []);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  const perms = Object.keys(PERM);
  return (
    <>
      <PageHead title="Rollar va huquqlar" sub="Huquqlar matritsasi serverda belgilangan (o‘zgartirish dasturchi orqali)" />
      <div className="card"><div className="table-wrap"><table className="table">
        <thead><tr><th>Huquq</th>{data.map((r) => <th key={r.role} className="center">{ROLE_LABEL[r.role] || r.role}</th>)}</tr></thead>
        <tbody>{perms.map((p) => (
          <tr key={p}><td>{PERM[p]}</td>{data.map((r) => <td key={r.role} className="center">{r.permissions.includes(p) ? <span style={{ color: "var(--text-accent)" }}><I.check size={18} /></span> : <span className="muted">—</span>}</td>)}</tr>
        ))}</tbody>
      </table></div></div>
    </>
  );
}

type A = { id: number; action: string; entity: string; entity_id: number | null; data: unknown; created_at: string; user_name: string | null };
export function AuditPage() {
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useLoad(() => api.get<A[]>(`/admin/audit?limit=50&page=${page}`), [page]);
  return (
    <>
      <PageHead title="Audit jurnali" sub="Admin paneldagi barcha o‘zgarishlar" />
      <div className="card">
        {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading || !data ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Vaqt</th><th>Foydalanuvchi</th><th>Amal</th><th>Obyekt</th><th className="hide-mobile">Ma’lumot</th></tr></thead>
            <tbody>{data.map((a) => (
              <tr key={a.id}>
                <td className="nowrap">{fmtDateTime(a.created_at)}</td><td>{a.user_name || "Tizim"}</td><td><Badge plain>{a.action}</Badge></td>
                <td>{a.entity}{a.entity_id ? ` #${a.entity_id}` : ""}</td>
                <td className="hide-mobile"><code className="small muted ellipsis" style={{ display: "inline-block", maxWidth: 420 }}>{a.data ? JSON.stringify(a.data) : ""}</code></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <div className="row" style={{ justifyContent: "flex-end", padding: 12, gap: 8 }}>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>←</button>
          <span className="small">{page}</span>
          <button className="btn btn-sm" disabled={(data?.length || 0) < 50} onClick={() => setPage(page + 1)}>→</button>
        </div>
      </div>
    </>
  );
}
