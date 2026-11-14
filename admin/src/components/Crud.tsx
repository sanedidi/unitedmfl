import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Route, Routes, useNavigate, useParams } from "react-router";
import { api, ApiError, type Page } from "@/lib/api";
import { useDebounced, useLoad } from "@/lib/hooks";
import { fromLocalInput, slugify, toLocalInput } from "@/lib/format";
import { Drawer, Empty, ErrorBox, Field, ImageInput, Loading, Pager, useConfirm, useToast } from "./ui";
import { I } from "./Icons";
import { PageHead } from "./Layout";
import { Markdown } from "./Markdown";

export type Opt = { value: string; label: string };
export type FieldSpec = {
  name: string;
  label: string;
  type?: "text" | "textarea" | "markdown" | "number" | "bool" | "select" | "image" | "date" | "datetime" | "tags" | "colors" | "slug" | "url";
  options?: Opt[];
  nullable?: boolean; // empty select / number → null
  numeric?: boolean; // select whose values are ids
  required?: boolean;
  full?: boolean;
  hint?: string;
  slugFrom?: string;
  placeholder?: string;
  show?: (v: Rec) => boolean;
  side?: boolean; // on the edit page: shown in the right-hand «Holat» column
  hidden?: boolean; // saved with the form but edited by a custom card
  requiredIf?: (v: Rec) => boolean; // required depending on other values (shown with *)
  hintFor?: (v: Rec) => string | undefined;
};
/** Extra cards on the edit page; they edit hidden fields through set(). */
export type CardCtx = { item: Rec | null; values: Rec; set: (k: string, v: any) => void; version: number };
export type Rec = Record<string, any>;
export type Col<T> = { label: string; render: (r: T) => ReactNode; className?: string };

export function fieldValueIn(f: FieldSpec, v: any) {
  if (f.type === "datetime") return toLocalInput(v);
  if (f.type === "date") return v ? String(v).slice(0, 10) : "";
  if (f.type === "tags" || f.type === "colors") return Array.isArray(v) ? v.join(", ") : "";
  if (f.type === "bool") return !!v;
  if (v == null) return "";
  return String(v);
}
export function fieldValueOut(f: FieldSpec, v: any) {
  switch (f.type) {
    case "bool": return !!v;
    case "number": return v === "" || v == null ? (f.nullable ? null : 0) : Number(v);
    case "datetime": return fromLocalInput(v);
    case "date": return v || null;
    case "tags":
    case "colors": return String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
    case "select": return v === "" ? (f.nullable ? null : "") : f.numeric ? Number(v) : v;
    default: return v ?? "";
  }
}

export function FormFields({ fields, values, set, errors }: { fields: FieldSpec[]; values: Rec; set: (k: string, v: any) => void; errors: Record<string, string> }) {
  return (
    <div className="form-grid">
      {fields.filter((f) => !f.hidden && (!f.show || f.show(values))).map((f) => {
        const v = values[f.name];
        const err = errors[f.name];
        const common = { id: `f-${f.name}`, "aria-invalid": !!err || undefined } as const;
        let input: ReactNode;
        switch (f.type) {
          case "textarea":
            input = <textarea {...common} className="textarea" value={v} placeholder={f.placeholder} onChange={(e) => set(f.name, e.target.value)} />;
            break;
          case "markdown":
            input = <Markdown value={v} onChange={(x) => set(f.name, x)} />;
            break;
          case "bool":
            return (
              <div key={f.name} className={`field${f.full ? " full" : ""}`} style={{ justifyContent: "flex-end" }}>
                <label className="check"><input type="checkbox" checked={!!v} onChange={(e) => set(f.name, e.target.checked)} /> {f.label}</label>
                {f.hint && <span className="hint">{f.hint}</span>}
              </div>
            );
          case "select":
            input = (
              <select {...common} className="select" value={v} onChange={(e) => set(f.name, e.target.value)}>
                {f.nullable && <option value="">—</option>}
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            );
            break;
          case "image":
            input = <ImageInput value={v} onChange={(x) => set(f.name, x)} wide />;
            break;
          case "number":
            input = <input {...common} className="input" type="number" inputMode="numeric" value={v} onChange={(e) => set(f.name, e.target.value)} />;
            break;
          case "date":
            input = <input {...common} className="input" type="date" value={v} onChange={(e) => set(f.name, e.target.value)} />;
            break;
          case "datetime":
            input = <input {...common} className="input" type="datetime-local" value={v} onChange={(e) => set(f.name, e.target.value)} />;
            break;
          default:
            input = <input {...common} className="input" type={f.type === "url" ? "url" : "text"} value={v} placeholder={f.placeholder} onChange={(e) => set(f.name, e.target.value)} />;
        }
        return (
          <Field key={f.name} label={f.label + (f.required || f.requiredIf?.(values) ? " *" : "")} error={err} hint={f.hintFor?.(values) ?? f.hint} full={f.full || f.type === "textarea" || f.type === "markdown" || f.type === "image"}>
            {input}
          </Field>
        );
      })}
    </div>
  );
}

/** Form state helper shared by the generic CRUD drawer and custom forms. */
export function useForm(fields: FieldSpec[], initial: Rec | null, defaults: Rec = {}) {
  const make = () => Object.fromEntries(fields.map((f) => [f.name, fieldValueIn(f, initial ? initial[f.name] : defaults[f.name] ?? (f.type === "bool" ? false : ""))]));
  const [values, setValues] = useState<Rec>(make);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [slugTouched, setSlugTouched] = useState(!!initial);
  const set = (k: string, v: any) => {
    setValues((prev) => {
      const next = { ...prev, [k]: v };
      for (const f of fields) if (f.type === "slug" && f.slugFrom === k && !slugTouched) next[f.name] = slugify(String(v));
      return next;
    });
    if (fields.find((f) => f.name === k)?.type === "slug") setSlugTouched(true);
    setErrors((e) => ({ ...e, [k]: "" }));
  };
  const payload = () => Object.fromEntries(fields.map((f) => [f.name, fieldValueOut(f, values[f.name])]));
  const fail = (e: unknown) => {
    if (e instanceof ApiError && Object.keys(e.fields).length) setErrors(e.fields);
  };
  return { values, set, errors, setErrors, payload, fail };
}

export function CrudDrawer({ title, resource, fields, item, defaults, onClose, onSaved, extra }: { title: string; resource: string; fields: FieldSpec[]; item: Rec | null; defaults?: Rec; onClose: () => void; onSaved: (r: Rec) => void; extra?: (item: Rec) => ReactNode }) {
  const form = useForm(fields, item, defaults);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    try {
      const body = form.payload();
      const r = item ? await api.patch<Rec>(`${resource}/${item.id}`, body) : await api.post<Rec>(resource, body);
      toast("Saqlandi");
      onSaved(r);
    } catch (err) {
      form.fail(err);
      toast(err instanceof Error ? err.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer title={item ? `${title}: tahrirlash` : `Yangi: ${title.toLowerCase()}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Bekor qilish</button>
      <button className="btn btn-primary" onClick={() => save()} disabled={busy}>{busy ? "Saqlanmoqda…" : "Saqlash"}</button>
    </>}>
      <form onSubmit={save}>
        <FormFields fields={fields} values={form.values} set={form.set} errors={form.errors} />
        <button hidden type="submit" />
      </form>
      {item && extra?.(item)}
    </Drawer>
  );
}

export type CrudProps<T extends Rec> = {
  title: string;
  sub?: ReactNode;
  resource: string;
  singular: string;
  columns: Col<T>[];
  fields: FieldSpec[];
  defaults?: Rec;
  filters?: { param: string; label: string; options: Opt[] }[];
  searchable?: boolean;
  limit?: number;
  headActions?: ReactNode;
  canCreate?: boolean;
  canDelete?: boolean;
  extra?: (item: Rec) => ReactNode;
  emptyText?: string;
  reloadKey?: unknown;
  onChanged?: () => void;
  /** Route of the list (e.g. "/players"). Create and edit open as pages at base/new and base/:id. */
  base?: string;
  /** Where «Bekor qilish» returns to (defaults to base). */
  listPath?: string;
  /** "drawer" keeps the old side panel (Mavsumlar, Bosqichlar). */
  edit?: "page" | "drawer";
  /** Field used as the page title on the edit page. */
  titleField?: string;
  /** Edit page: cards after the main card (left) and before the status card (right). */
  cards?: (c: CardCtx) => ReactNode;
  sideCards?: (c: CardCtx) => ReactNode;
};

export function CrudPage<T extends Rec>(p: CrudProps<T>) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [flt, setFlt] = useState<Record<string, string>>({});
  const [drawerItem, setDrawerItem] = useState<Rec | null | undefined>(undefined);
  const navigate = useNavigate();
  const asPage = p.edit !== "drawer" && !!p.base;
  // page mode: create / edit open on their own route; drawer mode keeps the side panel
  const setEdit = (r: Rec | null) => (asPage ? navigate(r ? `${p.base}/${r.id}` : `${p.base}/new`) : setDrawerItem(r));
  const toast = useToast();
  const confirm = useConfirm();
  const limit = p.limit || 25;
  useEffect(() => setPage(1), [dq, flt]);
  const qs = useMemo(() => {
    const s = new URLSearchParams({ limit: String(limit), page: String(page) });
    if (dq) s.set("q", dq);
    for (const [k, v] of Object.entries(flt)) if (v) s.set(k, v);
    return s.toString();
  }, [dq, flt, page, limit]);
  const { data, error, loading, reload } = useLoad(() => api.get<Page<T>>(`${p.resource}?${qs}`), [qs, p.resource, p.reloadKey]);

  async function remove(r: T) {
    if (!(await confirm({ title: `${p.singular}ni o‘chirish`, text: "Bu amalni qaytarib bo‘lmaydi.", ok: "O‘chirish", danger: true }))) return;
    try {
      await api.del(`${p.resource}/${r.id}`);
      toast("O‘chirildi");
      p.onChanged?.();
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }

  return (
    <>
      <PageHead title={p.title} sub={p.sub} actions={<>{p.headActions}{p.canCreate !== false && <button className="btn btn-primary" onClick={() => setEdit(null)}><I.plus size={16} /> Qo‘shish</button>}</>} />
      <div className="card">
        {(p.searchable || p.filters?.length) && (
          <div className="toolbar">
            {p.searchable && (
              <div className="search grow" style={{ maxWidth: 360 }}>
                <I.search size={16} />
                <input className="input" placeholder="Qidirish…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Qidirish" />
              </div>
            )}
            {p.filters?.map((f) => (
              <select key={f.param} className="select" style={{ width: "auto" }} value={flt[f.param] || ""} onChange={(e) => setFlt((x) => ({ ...x, [f.param]: e.target.value }))} aria-label={f.label}>
                <option value="">{f.label}: barchasi</option>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ))}
          </div>
        )}
        {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : !data?.items.length ? (
          <Empty title="Hech narsa topilmadi" text={p.emptyText} action={p.canCreate !== false ? <button className="btn btn-primary" onClick={() => setEdit(null)}><I.plus size={16} /> Qo‘shish</button> : undefined} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{p.columns.map((c) => <th key={c.label} className={c.className}>{c.label}</th>)}<th /></tr></thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => setEdit(r)}>
                    {p.columns.map((c) => <td key={c.label} className={c.className}>{c.render(r)}</td>)}
                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-ghost btn-sm btn-icon" aria-label="Tahrirlash" onClick={() => setEdit(r)}><I.edit size={16} /></button>
                      {p.canDelete !== false && <button className="btn btn-ghost btn-sm btn-icon" aria-label="O‘chirish" onClick={() => remove(r)}><I.trash size={16} /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={page} total={data.total} limit={limit} onPage={setPage} />}
      </div>
      {!asPage && drawerItem !== undefined && (
        <CrudDrawer title={p.singular} resource={p.resource} fields={p.fields} item={drawerItem} defaults={p.defaults} extra={p.extra}
          onClose={() => setDrawerItem(undefined)} onSaved={() => { setDrawerItem(undefined); p.onChanged?.(); reload(); }} />
      )}
    </>
  );
}

/** List at base, create at base/new, edit at base/:id (mount the route as "base/*"). */
export function CrudSection<T extends Rec>(p: CrudProps<T> & { base: string }) {
  return (
    <Routes>
      <Route index element={<CrudPage<T> {...p} />} />
      <Route path="new" element={<CrudEditPage {...p} />} />
      <Route path=":id" element={<CrudEditPage {...p} />} />
    </Routes>
  );
}

/** Full-page create / edit form: fields on the left, status fields and delete on the right. */
export function CrudEditPage<T extends Rec>(p: CrudProps<T> & { base: string }) {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const { data, error, loading, reload } = useLoad(() => (isNew ? Promise.resolve(null) : api.get<Rec>(`${p.resource}/${id}`)), [id, p.resource]);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading && !isNew) return <Loading />;
  return <CrudEditForm key={String(data?.id ?? "new")} p={p} item={data ?? null} />;
}

function CrudEditForm<T extends Rec>({ p, item }: { p: CrudProps<T> & { base: string }; item: Rec | null }) {
  const form = useForm(p.fields, item, p.defaults);
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(() => JSON.stringify(form.values));
  const [version, setVersion] = useState(0);
  const dirty = JSON.stringify(form.values) !== saved;
  const back = p.listPath || p.base;
  const ctx: CardCtx = { item, values: form.values, set: form.set, version };
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
  const titleField = p.titleField || p.fields.find((f) => !f.type || f.type === "text")?.name;
  const title = item ? String(form.values[titleField || ""] || item[titleField || ""] || p.singular) : `Yangi: ${p.singular.toLowerCase()}`;
  const main = p.fields.filter((f) => !f.side);
  const side = p.fields.filter((f) => f.side);

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    try {
      const body = form.payload();
      const r = item ? await api.patch<Rec>(`${p.resource}/${item.id}`, body) : await api.post<Rec>(p.resource, body);
      toast("Saqlandi");
      p.onChanged?.();
      setSaved(JSON.stringify(form.values));
      setVersion((v) => v + 1);
      if (!item) navigate(`${p.base}/${r.id}`, { replace: true });
    } catch (err) {
      form.fail(err);
      toast(err instanceof Error ? err.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (dirty && !(await confirm({ title: "O‘zgarishlar saqlanmagan", text: "Sahifadan chiqsangiz, o‘zgarishlar yo‘qoladi.", ok: "Chiqish", danger: true }))) return;
    navigate(back);
  }
  async function remove() {
    if (!item || !(await confirm({ title: `${p.singular}ni o‘chirish`, text: "Bu amalni qaytarib bo‘lmaydi.", ok: "O‘chirish", danger: true }))) return;
    try {
      await api.del(`${p.resource}/${item.id}`);
      toast("O‘chirildi");
      p.onChanged?.();
      navigate(back, { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }
  return (
    <form onSubmit={save}>
      <PageHead title={title} sub={<span className="crumbs"><a href={back} onClick={(e) => { e.preventDefault(); cancel(); }}>{p.title}</a> / <b>{item ? "Tahrirlash" : "Yangi"}</b>{dirty && <span className="muted small"> · saqlanmagan o‘zgarishlar</span>}</span>}
        actions={<>
          <button type="button" className="btn btn-ghost" onClick={cancel}>Bekor qilish</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saqlanmoqda…" : "Saqlash"}</button>
        </>} />
      <div className="edit-layout">
        <div className="stack" style={{ gap: 24 }}>
          {main.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Asosiy ma’lumotlar</h3></div>
              <div className="card-pad"><FormFields fields={main} values={form.values} set={form.set} errors={form.errors} /></div>
            </div>
          )}
          {p.cards?.(ctx)}
          {item && p.extra && <div className="card"><div className="card-pad">{p.extra(item)}</div></div>}
        </div>
        <aside className="stack" style={{ gap: 24 }}>
          {p.sideCards?.(ctx)}
          {side.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Holat</h3></div>
              <div className="card-pad side-fields"><FormFields fields={side} values={form.values} set={form.set} errors={form.errors} /></div>
            </div>
          )}
          {item && p.canDelete !== false && <button type="button" className="btn btn-ghost danger-text" style={{ alignSelf: "flex-start" }} onClick={remove}><I.trash size={16} /> {p.singular}ni o‘chirish</button>}
        </aside>
      </div>
    </form>
  );
}
