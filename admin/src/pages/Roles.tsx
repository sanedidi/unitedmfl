import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { Allowed, useAuth, usePage } from "@/lib/auth";
import { initials } from "@/lib/format";
import { NAV, PageHead } from "@/components/Layout";
import { Badge, ErrorBox, Field, Loading, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

// Rollar va huquqlar: roles are created here and each one opens only the admin
// pages ticked for it. The administrator role is fixed (every page).

export type Role = {
  id: number; slug: string; name: string; description: string; is_system: boolean;
  permissions: string[]; pages: number; users: number; updated_at: string;
  user_list?: { id: number; name: string; email: string; status: string }[];
};
type CatalogPage = { key: string; label: string; hint: string; actions: string[] };
type Catalog = { groups: { label: string; pages: CatalogPage[] }[]; actions: { key: string; label: string }[]; total: number };

const loadCatalog = () => api.get<Catalog>("/admin/permissions");
export const loadRoles = () => api.get<Role[]>("/admin/roles");

/** Menu icon of a page, taken from the side menu. */
const NAV_ITEMS = NAV.flatMap((g) => g.items);
const iconOf = (perm: string) => NAV_ITEMS.find((it) => it.perm === perm)?.icon;

const pageLabels = (cat: Catalog | undefined) => {
  const m: Record<string, string> = {};
  cat?.groups.forEach((g) => g.pages.forEach((p) => (m[p.key] = p.label)));
  return m;
};

// ---------- R1 · list ----------

export function RolesPage() {
  const roles = useLoad(loadRoles, []);
  const cat = useLoad(loadCatalog, []);
  const navigate = useNavigate();
  const [del, setDel] = useState<Role | null>(null);
  const labels = useMemo(() => pageLabels(cat.data), [cat.data]);
  const total = cat.data?.total ?? 27;
  const error = roles.error || cat.error;
  return (
    <>
      <PageHead title="Rollar va huquqlar" sub="Rol yarating va unga qaysi sahifalar ochiq bo‘lishini belgilang"
        actions={<Allowed to="create"><Link className="btn btn-primary" to="/roles/new"><I.plus size={16} /> Yangi rol</Link></Allowed>} />
      <div className="card">
        {error ? <div className="card-pad"><ErrorBox error={error} retry={() => { roles.reload(); cat.reload(); }} /></div> : !roles.data || !cat.data ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Rol</th><th>Ochiq sahifalar</th><th className="hide-mobile">Foydalanuvchilar</th><th className="hide-mobile">Turi</th><th /></tr></thead>
            <tbody>{roles.data.map((r) => {
              const pages = r.permissions.filter((p) => p.endsWith(":view")).map((p) => p.slice(0, -5)).filter((p) => labels[p]);
              return (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/roles/${r.id}`)}>
                  <td>
                    <b className="row" style={{ gap: 6 }}>{r.is_system && <I.lock size={14} />}{r.name}</b>
                    {r.description && <div className="muted small">{r.description}</div>}
                  </td>
                  <td>
                    <div className="role-pages">
                      <b className="nowrap" title={`${r.permissions.length} amal`}>{r.pages} / {total}</b>
                      {r.is_system ? <span className="chip-static">Hammasi</span> : <>
                        {pages.slice(0, 3).map((p) => <span key={p} className="role-chip">{labels[p]}</span>)}
                        {pages.length > 3 && <span className="muted small">+{pages.length - 3}</span>}
                      </>}
                    </div>
                  </td>
                  <td className="hide-mobile"><span className="row" style={{ gap: 6 }}><I.users size={15} /><span className={r.users ? "" : "muted"}>{r.users}</span></span></td>
                  <td className="hide-mobile">{r.is_system ? <Badge plain tone="dark">Tizim</Badge> : <Badge plain>Maxsus</Badge>}</td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}>
                    {r.is_system ? <span className="muted small nowrap">Faqat ko‘rish</span> : <>
                      <Allowed to="edit" otherwise={<Link className="btn btn-sm btn-icon" to={`/roles/${r.id}`} aria-label="Ko‘rish" title="Ko‘rish"><I.eye size={16} /></Link>}>
                        <Link className="btn btn-sm btn-icon" to={`/roles/${r.id}`} aria-label="Tahrirlash" title="Tahrirlash"><I.edit size={16} /></Link>
                      </Allowed>
                      <Allowed to="delete"><button className="btn btn-sm btn-icon" onClick={() => setDel(r)} aria-label="O‘chirish" title="O‘chirish"><I.trash size={16} /></button></Allowed>
                    </>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
      <div className="alert info" style={{ marginTop: 16 }}><I.lock size={16} /> Rol o‘zgarsa, shu roldagi barcha foydalanuvchilarda yangi huquqlar darhol ishlaydi — qayta kirish shart emas. Administrator roli doim barcha sahifalarni ko‘radi.</div>
      {del && roles.data && <DeleteRoleModal role={del} roles={roles.data} onClose={() => setDel(null)} onDone={() => { setDel(null); roles.reload(); }} />}
    </>
  );
}

// ---------- R5 · delete, moving the role's users ----------

function DeleteRoleModal({ role, roles, onClose, onDone }: { role: Role; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const others = roles.filter((r) => r.id !== role.id);
  const [moveTo, setMoveTo] = useState<number>(() => others.find((r) => !r.is_system)?.id ?? others[0]?.id ?? 0);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const detail = useLoad(() => (role.users ? api.get<Role>(`/admin/roles/${role.id}`) : Promise.resolve(role)), [role.id]);
  async function remove() {
    setBusy(true);
    try {
      await api.del(`/admin/roles/${role.id}${role.users ? `?move_to=${moveTo}` : ""}`);
      toast("Rol o‘chirildi");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`«${role.name}» rolini o‘chirish`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Bekor qilish</button><button className="btn btn-danger" onClick={remove} disabled={busy}>{busy ? "O‘chirilmoqda…" : role.users ? "Ko‘chirish va o‘chirish" : "O‘chirish"}</button></>}>
      {role.users ? (
        <div className="stack">
          <p style={{ margin: 0 }}>Bu rolda {role.users} ta foydalanuvchi bor. Rol o‘chirilishidan oldin ular boshqa rolga o‘tkaziladi.</p>
          <Field label="Foydalanuvchilarni qaysi rolga o‘tkazamiz?">
            <select className="select" value={moveTo} onChange={(e) => setMoveTo(Number(e.target.value))}>
              {others.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          {detail.data?.user_list && <div className="chips">{detail.data.user_list.map((u) => <span key={u.id} className="role-chip">{u.name}</span>)}</div>}
        </div>
      ) : <p style={{ margin: 0 }}>Bu rolda foydalanuvchi yo‘q. Rolni qaytarib bo‘lmaydi.</p>}
    </Modal>
  );
}

// ---------- R2.1 · create / edit: page × action matrix (separate page) ----------

export function RoleEditPage() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const cat = useLoad(loadCatalog, []);
  const role = useLoad(() => (isNew ? Promise.resolve(null) : api.get<Role>(`/admin/roles/${id}`)), [id]);
  const error = cat.error || role.error;
  if (error) return <ErrorBox error={error} retry={() => { cat.reload(); role.reload(); }} />;
  if (!cat.data || (!isNew && !role.data)) return <Loading />;
  return <RoleForm key={role.data?.id ?? "new"} catalog={cat.data} role={role.data ?? null} reload={role.reload} />;
}

const viewKey = (page: string) => `${page}:view`;

function RoleForm({ catalog, role, reload }: { catalog: Catalog; role: Role | null; reload: () => void }) {
  const { user, can } = useAuth();
  const pg = usePage();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const system = !!role?.is_system;
  // the administrator role is fixed; without the right to edit roles the page only shows
  const fixed = system || (role ? !pg.edit : !pg.create);
  const all = useMemo(() => catalog.groups.flatMap((g) => g.pages.flatMap((p) => p.actions.map((a) => `${p.key}:${a}`))), [catalog]);
  const initial = useMemo(() => ({ name: role?.name ?? "", description: role?.description ?? "", perms: [...(role?.permissions ?? [])].sort() }), [role]);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [perms, setPerms] = useState<Set<string>>(() => new Set(system ? all : initial.perms));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const allRoles = useLoad(() => (del ? loadRoles() : Promise.resolve(undefined)), [del]);
  const saved = useRef(JSON.stringify(initial));
  const state = JSON.stringify({ name, description, perms: [...perms].sort() });
  const dirty = !fixed && state !== saved.current;
  const own = role?.slug === user?.role;

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const pageCount = catalog.groups.reduce((n, g) => n + g.pages.filter((p) => perms.has(viewKey(p.key))).length, 0);

  /** Turns actions on or off: any action needs viewing its page; without viewing nothing else stays. */
  function change(keys: string[], on: boolean) {
    if (fixed) return;
    setPerms((cur) => {
      const next = new Set(cur);
      for (const k of keys) {
        const page = k.slice(0, k.lastIndexOf(":"));
        if (on) { next.add(k); next.add(viewKey(page)); }
        else if (k === viewKey(page)) { for (const x of [...next]) if (x.startsWith(page + ":")) next.delete(x); }
        else next.delete(k);
      }
      return next;
    });
    setErrors((e) => ({ ...e, permissions: "" }));
  }
  const preset = (keys: string[]) => { if (!fixed) { setPerms(new Set(keys)); setErrors((e) => ({ ...e, permissions: "" })); } };

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (fixed) return;
    setBusy(true);
    try {
      const body = { name, description, permissions: [...perms] };
      const r = role ? await api.patch<Role>(`/admin/roles/${role.id}`, body) : await api.post<Role>("/admin/roles", body);
      saved.current = state;
      setErrors({});
      toast("Saqlandi");
      if (role) reload();
      else navigate(`/roles/${r.id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields || {});
      toast(err instanceof Error ? err.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (dirty && !(await confirm({ title: "O‘zgarishlar saqlanmagan", text: "Sahifadan chiqsangiz, o‘zgarishlar yo‘qoladi.", ok: "Chiqish", danger: true }))) return;
    navigate("/roles");
  }

  const menu = NAV.map((g) => ({ group: g.group, items: g.items.filter((it) => perms.has(viewKey(it.perm))) })).filter((g) => g.items.length);
  const landing = perms.has("dashboard:view") ? "Dashboard" : menu[0]?.items[0]?.label;
  const title = role ? name || role.name : "Yangi rol";
  const sub = role
    ? `${system ? "Tizim roli" : "Maxsus rol"} · ${role.users} foydalanuvchi · ${pageCount} sahifa, ${perms.size} amal${dirty ? " · saqlanmagan o‘zgarishlar" : ""}`
    : "Nom bering va har bir sahifada nimalar mumkinligini belgilang";

  return (
    <form onSubmit={save}>
      <PageHead title={title} sub={sub}
        pre={<span className="crumbs"><a href="/roles" onClick={(e) => { e.preventDefault(); cancel(); }}><I.back size={14} /> Rollar va huquqlar</a></span>}
        actions={fixed ? <Link className="btn" to="/roles">Orqaga</Link> : <>
          <button type="button" className="btn" onClick={cancel}>Bekor qilish</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saqlanmoqda…" : "Saqlash"}</button>
        </>} />
      {system && <div className="alert info" style={{ marginBottom: 24 }}><I.lock size={16} /> Administrator — tizim roli: u doim barcha sahifalarda barcha amallarni bajaradi, uni o‘zgartirib yoki o‘chirib bo‘lmaydi.</div>}
      <div className="edit-layout">
        <div className="stack" style={{ gap: 24 }}>
          <div className="card">
            <div className="card-head"><h3>Asosiy ma’lumot</h3></div>
            <div className="card-pad"><div className="form-grid">
              <Field label="Rol nomi *" error={errors.name} hint="Foydalanuvchilar ro‘yxatida shu nom ko‘rinadi">
                <input className="input" value={name} maxLength={60} disabled={fixed} placeholder="Masalan: SMM menejer" onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, name: "" })); }} />
              </Field>
              <Field label="Tavsif" error={errors.description} hint="Ixtiyoriy · rollar ro‘yxatida ko‘rinadi">
                <input className="input" value={description} maxLength={200} disabled={fixed} placeholder="Qisqacha: nima bilan ishlaydi" onChange={(e) => setDescription(e.target.value)} />
              </Field>
            </div></div>
          </div>

          <div className="card">
            <div className="card-head perm-head">
              <div>
                <h3>Sahifalar va amallar</h3>
                <p className="muted small">Har bir sahifa uchun nimalar mumkinligini belgilang. Ko‘rish yopiq bo‘lsa, sahifa menyuda ham ko‘rinmaydi.</p>
              </div>
              <span className="chip-static nowrap">{pageCount} sahifa · {perms.size} amal</span>
            </div>
            <div className="card-pad stack" style={{ gap: 16 }}>
              {!fixed && (
                <div className="row wrap" style={{ gap: 8 }}>
                  <span className="muted small">Hammasiga:</span>
                  <button type="button" className="btn btn-sm" onClick={() => preset(all.filter((k) => k.endsWith(":view")))}>Faqat ko‘rish</button>
                  <button type="button" className="btn btn-sm" onClick={() => preset(all)}>To‘liq huquq</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => preset([])}>Tozalash</button>
                </div>
              )}
              {errors.permissions && <div className="alert danger"><I.alert size={16} /> {errors.permissions}</div>}
              {own && !fixed && <div className="alert warn"><I.alert size={16} /> Bu sizning rolingiz. «Rollar va huquqlar» sahifasini tahrirlash huquqini olib tashlab bo‘lmaydi.</div>}
              <div className="table-wrap perm-matrix-wrap">
                <table className="perm-matrix">
                  <thead><tr><th>Sahifa</th>{catalog.actions.map((a) => <th key={a.key}>{a.label}</th>)}</tr></thead>
                  {catalog.groups.map((g) => {
                    const opened = g.pages.filter((p) => perms.has(viewKey(p.key))).length;
                    return (
                      <tbody key={g.label}>
                        <tr className="perm-group-row">
                          <th scope="rowgroup"><span className="overline">{g.label}</span> <span className={`small ${opened ? "accent-text" : "muted"}`}>{opened} / {g.pages.length}</span></th>
                          {catalog.actions.map((a) => {
                            const keys = g.pages.filter((p) => p.actions.includes(a.key)).map((p) => `${p.key}:${a.key}`);
                            if (!keys.length) return <td key={a.key} className="na">—</td>;
                            const on = keys.filter((k) => perms.has(k)).length;
                            return <td key={a.key}><Box checked={on === keys.length} some={on > 0} disabled={fixed} label={`${g.label}: ${a.label}`} onChange={(v) => change(keys, v)} /></td>;
                          })}
                        </tr>
                        {g.pages.map((p) => (
                          <tr key={p.key} className={perms.has(viewKey(p.key)) ? "on" : ""}>
                            <th scope="row"><span className="perm-name">{iconOf(p.key)}<span>{p.label}<small className="muted">{p.hint}</small></span></span></th>
                            {catalog.actions.map((a) => {
                              const k = `${p.key}:${a.key}`;
                              if (!p.actions.includes(a.key)) return <td key={a.key} className="na">—</td>;
                              return <td key={a.key}><Box checked={perms.has(k)} disabled={fixed} label={`${p.label}: ${a.label}`} onChange={(v) => change([k], v)} /></td>;
                            })}
                          </tr>
                        ))}
                      </tbody>
                    );
                  })}
                </table>
              </div>
              <div className="check-list perm-legend">
                <div><I.check size={14} /><span>Yaratish, tahrirlash yoki o‘chirish belgilansa, Ko‘rish o‘zi yoqiladi. Ko‘rish olib tashlansa, sahifaning barcha amallari ham o‘chadi.</span></div>
                <div><I.check size={14} /><span>«—» — bu sahifada bunday amal yo‘q (masalan, Audit jurnalini faqat ko‘rish mumkin).</span></div>
                <div><I.check size={14} /><span>Guruh qatoridagi belgi butun ustunni yoqadi yoki o‘chiradi.</span></div>
              </div>
            </div>
          </div>
        </div>

        <aside className="stack" style={{ gap: 24 }}>
          <div className="card nav-preview-card">
            <div className="card-pad stack" style={{ gap: 12 }}>
              <h3 className="h4">Menyu ko‘rinishi</h3>
              <p className="muted small" style={{ margin: 0 }}>{name.trim() ? `«${name.trim()}» roli bilan kirgan foydalanuvchi` : "Bu roldagi foydalanuvchi"} yon menyuda faqat shularni ko‘radi:</p>
              <div className="nav-preview">
                {menu.length ? menu.map((g, i) => (
                  <div key={i}>
                    {g.group && <div className="sb-group">{g.group}</div>}
                    {g.items.map((it, j) => <div key={it.to} className={`sb-link${i === 0 && j === 0 ? " active" : ""}`}>{it.icon}<span>{it.label}</span></div>)}
                  </div>
                )) : <div className="muted small" style={{ padding: 8 }}>Hali birorta sahifa belgilanmagan</div>}
              </div>
              {landing && <div className="row small" style={{ alignItems: "flex-start", gap: 8 }}><I.check size={14} /><span className="muted">Kirgandan keyin birinchi ochiladigan sahifa — {landing}{landing !== "Dashboard" ? " (Dashboard yopiq)" : ""}.</span></div>}
            </div>
          </div>

          {role && (
            <div className="card">
              <div className="card-head"><h3>Foydalanuvchilar</h3><span className="muted">{role.users}</span></div>
              <div className="card-pad stack" style={{ gap: 12 }}>
                {role.user_list?.length ? role.user_list.map((u) => (
                  <div key={u.id} className="row">
                    <span className="avatar">{initials(u.name)}</span>
                    <span className="grow"><b className="small">{u.name}</b><div className="muted small">{u.email}</div></span>
                    {u.status !== "active" && <Badge tone="danger">Bloklangan</Badge>}
                  </div>
                )) : <span className="muted small">Bu rolda hali foydalanuvchi yo‘q.</span>}
                {can("users:edit") && <Link className="btn" to="/users">Foydalanuvchiga rol berish</Link>}
              </div>
            </div>
          )}

          {role && !system && pg.del && (
            <div className="card danger-card">
              <div className="card-pad stack" style={{ gap: 12 }}>
                <h3 className="h4">Rolni o‘chirish</h3>
                <p className="muted small" style={{ margin: 0 }}>O‘chirishdan oldin bu roldagi foydalanuvchilarni boshqa rolga o‘tkazasiz. Administrator rolini o‘chirib bo‘lmaydi.</p>
                <button type="button" className="btn btn-danger" style={{ alignSelf: "flex-start" }} disabled={own} title={own ? "O‘z rolingizni o‘chira olmaysiz" : undefined} onClick={() => setDel(true)}><I.trash size={16} /> Rolni o‘chirish</button>
              </div>
            </div>
          )}
        </aside>
      </div>
      {del && role && allRoles.data && <DeleteRoleModal role={role} roles={allRoles.data} onClose={() => setDel(false)} onDone={() => navigate("/roles", { replace: true })} />}
    </form>
  );
}

/** A matrix checkbox; dashed (indeterminate) when only some of a column is on. */
function Box({ checked, some = false, disabled, label, onChange }: { checked: boolean; some?: boolean; disabled: boolean; label: string; onChange: (v: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = some && !checked; }, [checked, some]);
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={() => onChange(!checked)} />;
}
