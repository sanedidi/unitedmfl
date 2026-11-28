import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Route, Routes, useNavigate } from "react-router";
import { api, uploadImage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useDebounced, useLoad } from "@/lib/hooks";
import { fmtShort, fmtUZS } from "@/lib/format";
import { errText, wbLink, wbStatus, type WBChar, type WBCharc, type WBImportItem, type WBProduct, type WBState, type WBSubject, type WBVariant } from "@/lib/wb";
import { CrudEditPage, type CardCtx, type FieldSpec } from "@/components/Crud";
import { PageHead } from "@/components/Layout";
import { Empty, ErrorBox, Field, Loading, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

/* Merch: products sold on the site and in the Wildberries store (W1 list, W2 product page). */

const PRODUCT_STATUS = [{ value: "active", label: "Sotuvda" }, { value: "in_review", label: "Tekshiruvda" }, { value: "out_of_stock", label: "Tugagan" }, { value: "hidden", label: "Yashirin" }];

const FIELDS: FieldSpec[] = [
  { name: "name", label: "Nomi (saytda)", required: true, full: true },
  { name: "slug", label: "Slug", type: "slug", slugFrom: "name", required: true, hint: "Sahifa manzili: /merch/…" },
  { name: "category", label: "Toifa", placeholder: "Kiyim, Aksessuar…" },
  { name: "price_uzs", label: "Narx (saytda), so‘m", type: "number", required: true, hint: "WB ulangan bo‘lsa, saytda WB narxi ko‘rsatiladi" },
  { name: "sale_price_uzs", label: "Chegirma narxi (saytda)", type: "number", nullable: true },
  { name: "description", label: "Tavsif", type: "markdown" },
  { name: "external_url", label: "Boshqa sotib olish havolasi", type: "url", full: true, hint: "WB’da sotilmaydigan mahsulot uchun (ixtiyoriy)" },
  { name: "status", label: "Holat", type: "select", options: PRODUCT_STATUS, side: true },
  { name: "ord", label: "Tartib", type: "number", side: true },
  { name: "visible", label: "Do‘konda ko‘rsatish", type: "bool", side: true },
  { name: "featured", label: "Bosh sahifada (Merch bloki)", type: "bool", side: true },
  // edited by the cards below
  { name: "images", label: "Rasmlar", type: "tags", hidden: true },
  { name: "wb_enabled", label: "WB’da sotish", type: "bool", hidden: true },
  { name: "wb_subject_id", label: "Kategoriya", type: "number", nullable: true, hidden: true },
  { name: "wb_subject_name", label: "Kategoriya nomi", hidden: true },
  { name: "wb_brand", label: "Brend", hidden: true },
  { name: "wb_vendor_code", label: "Sotuvchi artikuli", hidden: true },
  { name: "wb_title", label: "Sarlavha (WB)", hidden: true },
  { name: "wb_description", label: "Tavsif (WB)", hidden: true },
  { name: "wb_desc_from_site", label: "Tavsifni saytdan olish", type: "bool", hidden: true },
  { name: "wb_chars", label: "Xususiyatlar", type: "json", hidden: true },
  { name: "wb_price", label: "WB narxi", type: "number", nullable: true, hidden: true },
  { name: "wb_discount", label: "Chegirma, %", type: "number", hidden: true },
  { name: "wb_show_button", label: "WB tugmasi", type: "bool", hidden: true },
  { name: "pkg_length", label: "Uzunlik", type: "number", nullable: true, hidden: true },
  { name: "pkg_width", label: "Kenglik", type: "number", nullable: true, hidden: true },
  { name: "pkg_height", label: "Balandlik", type: "number", nullable: true, hidden: true },
  { name: "pkg_weight_g", label: "Og‘irlik", type: "number", nullable: true, hidden: true },
];
const DEFAULTS = { status: "active", visible: true, ord: "0", wb_brand: "United MFL", wb_desc_from_site: true, wb_show_button: true, wb_discount: "0" };

export function ProductsPage() {
  const editProps = {
    base: "/products", title: "Merch", resource: "/admin/products", singular: "Mahsulot", titleField: "name",
    deleteText: "Saytdan o‘chiriladi. Wildberries’dagi kartochka qoladi — uni WB kabinetida o‘chiring.",
    fields: FIELDS, defaults: DEFAULTS, columns: [],
    cards: (c: CardCtx) => <><ImagesCard c={c} /><WBCardForm c={c} /><CharsCard c={c} /><SizesCard c={c} /><PackageCard c={c} /></>,
    sideCards: (c: CardCtx) => <><WBStatusCard c={c} /><WBPriceCard c={c} /></>,
    sideCardsAfter: (c: CardCtx) => <SiteButtonCard c={c} />,
  };
  return (
    <Routes>
      <Route index element={<MerchList />} />
      <Route path="new" element={<CrudEditPage {...editProps} />} />
      <Route path=":id" element={<CrudEditPage {...editProps} />} />
    </Routes>
  );
}

/* ---------- W1: list ---------- */

type Filter = "all" | "ready" | "pending" | "error" | "site";

function MerchList() {
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api.get<Page<WBProduct>>("/admin/products?limit=200"), []);
  const wb = useLoad(() => api.get<WBState>("/admin/wb").catch(() => null), []);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const s = wb.data;
  const items = data?.items || [];
  const rows = items.map((p) => ({ p, st: wbStatus(p, fmtShort) }));
  const moving = rows.some((r) => r.p.wb_state === "queued" || r.p.wb_state === "pending");
  // live progress while something is on its way to WB
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => { reload(); wb.reload(); }, 5000);
    return () => clearInterval(t);
  }, [moving, reload, wb.reload]);

  const count = (k: Filter) => (k === "all" ? rows.length : rows.filter((r) => r.st.key === k).length);
  const shown = rows.filter((r) => (filter === "all" || r.st.key === filter) && (!q.trim() || `${r.p.name} ${r.p.wb_vendor_code} ${r.p.wb_nm_id ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())));
  async function remove(p: WBProduct) {
    if (!(await confirm({ title: "Mahsulotni o‘chirish", text: "Saytdan o‘chiriladi. Wildberries’dagi kartochka qoladi — uni WB kabinetida o‘chiring.", ok: "O‘chirish", danger: true }))) return;
    try { await api.del(`/admin/products/${p.id}`); toast("O‘chirildi"); reload(); wb.reload(); } catch (e) { toast(errText(e), "error"); }
  }
  async function syncNow() {
    setBusy(true);
    try { wb.setData(await api.post<WBState>("/admin/wb/sync")); toast("Sinxronlash boshlandi"); setTimeout(() => { reload(); wb.reload(); }, 4000); }
    catch (e) { toast(errText(e), "error"); } finally { setBusy(false); }
  }
  const chips: [Filter, string][] = [["all", "Hammasi"], ["ready", "Sotuvda"], ["pending", "Moderatsiya / navbat"], ["error", "Xato"], ["site", "Faqat saytda"]];

  return (
    <>
      <PageHead title="Merch" sub="Mahsulotlar saytda va Wildberries do‘konida — bitta joydan boshqariladi" actions={<>
        {s?.connected && <button className="btn" onClick={() => setImportOpen(true)}><I.download size={16} /> WB’dan import</button>}
        <button className="btn btn-primary" onClick={() => navigate("/products/new")}><I.plus size={16} /> Mahsulot qo‘shish</button>
      </>} />
      {s && <WBBanners s={s} />}
      <div className="stk-cols">
        <div className="stack">
          <div className="card stk-stats">
            <div><b>{items.length}</b><small>Mahsulotlar</small></div>
            <div><b>{s?.counts.on_wb ?? "—"}</b><small>WB’da sotuvda</small></div>
            <div><b>{s ? s.counts.queued + s.counts.pending : "—"}</b><small>Moderatsiya / navbat</small></div>
            <div><b className={s && s.counts.error + s.counts.incomplete > 0 ? "danger-text" : ""}>{s ? s.counts.error + s.counts.incomplete : "—"}</b><small>Xato</small></div>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <div className="search" style={{ width: 240 }}><I.search size={16} /><input className="input" aria-label="Qidirish" placeholder="Mahsulot qidirish…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            {chips.map(([k, l]) => <button key={k} className={`stk-chip${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{l} <span>{count(k)}</span></button>)}
          </div>
          <div className="card">
            {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : !items.length ? (
              <Empty title="Mahsulotlar yo‘q" text="Birinchi mahsulotni qo‘shing yoki WB kabinetidan import qiling." action={<button className="btn btn-primary" onClick={() => navigate("/products/new")}><I.plus size={16} /> Qo‘shish</button>} />
            ) : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Mahsulot</th><th>Narx</th><th className="hide-mobile">Qoldiq</th><th>WB holati</th><th /></tr></thead>
                <tbody>
                  {shown.map(({ p, st }) => (
                    <tr key={p.id} className="clickable" onClick={() => navigate(`/products/${p.id}`)}>
                      <td><div className="wb-prod"><Thumb src={p.images?.[0]} /><div><b>{p.name}</b><span className="muted small">{p.category || "—"}</span></div></div></td>
                      <td className="nowrap"><div className="stk-status"><span>{fmtUZS(p.sale_price_uzs ?? p.price_uzs)}</span>{p.wb_cur_final != null && <small>WB: {fmtUZS(p.wb_cur_final)}</small>}</div></td>
                      <td className="hide-mobile">{p.wb_stock == null ? <span className="muted">—</span> : <span className={p.wb_stock === 0 ? "danger-text" : ""}>{p.wb_stock}</span>}</td>
                      <td><div className="stk-status"><span className="row" style={{ gap: 8 }}><i className={`stk-dot ${st.dot}`} />{st.label}</span>{st.sub && <small className={st.dot === "error" ? "danger-text" : ""} title={st.sub}>{st.sub}</small>}</div></td>
                      <td className="actions nowrap" onClick={(e) => e.stopPropagation()}>
                        {p.wb_nm_id && s && <a className="btn btn-ghost btn-sm btn-icon" title="WB’da ochish" aria-label="WB’da ochish" href={wbLink(p.wb_nm_id, s.link_domain)} target="_blank" rel="noreferrer"><I.link size={16} /></a>}
                        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Tahrirlash" onClick={() => navigate(`/products/${p.id}`)}><I.edit size={16} /></button>
                        <button className="btn btn-ghost btn-sm btn-icon" aria-label="O‘chirish" onClick={() => remove(p)}><I.trash size={16} /></button>
                      </td>
                    </tr>
                  ))}
                  {!shown.length && <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 32 }}>Hech narsa topilmadi</td></tr>}
                </tbody>
              </table></div>
            )}
          </div>
          {data && <span className="muted small">{items.length} mahsulotdan {shown.length} tasi ko‘rsatilmoqda</span>}
        </div>
        <aside className="stack">
          {s && (s.connected ? (
            <div className="card">
              <div className="card-head"><h2>Wildberries do‘koni</h2><span className="row small b" style={{ gap: 6 }}><i className={`stk-dot ${s.problem ? "error" : "ready"}`} />{s.problem ? "Muammo bor" : "Ulangan"}</span></div>
              <div className="stk-kv">
                <div><span>Do‘kon</span><b>{s.seller.trademark || s.seller.name || "—"}</b></div>
                <div><span>Valyuta</span><b>{s.currency || "—"}</b></div>
                <div><span>Kartochkalar</span><b>{s.counts.cards} / {s.counts.products}</b></div>
                <div><span>Qoldiq va narx</span><b>{s.pull_stocks ? "har 30 daqiqa" : "o‘chirilgan"}</b></div>
                <div><span>Oxirgi sinxronlash</span><b>{fmtShort(s.last_pull_at || s.last_sync_at)}</b></div>
              </div>
              <div className="card-pad stack" style={{ gap: 8 }}>
                <button className="btn btn-dark" disabled={busy} onClick={syncNow}><I.refresh size={16} /> Hozir sinxronlash</button>
                {can("wildberries") && <Link className="btn" to="/wildberries">Ulanish sozlamalari</Link>}
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-head"><h2>Wildberries</h2><span className="row small b muted" style={{ gap: 6 }}><i className="stk-dot waiting" />Ulanmagan</span></div>
              <div className="card-pad stack" style={{ gap: 12 }}>
                <p className="muted small" style={{ margin: 0 }}>Token qo‘shilgach, mahsulotlar adminkadan WB do‘koniga yuboriladi, narx va qoldiq saytga qaytadi.</p>
                {can("wildberries") ? <Link className="btn btn-primary" to="/wildberries">Wildberries’ni ulash</Link> : <span className="small muted">Administrator ulashi kerak.</span>}
              </div>
            </div>
          ))}
          {s?.connected && <WBLogCard log={s.log} />}
        </aside>
      </div>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); reload(); wb.reload(); }} />}
    </>
  );
}

function Thumb({ src }: { src?: string }) {
  return src ? <img className="wb-thumb" src={src} alt="" loading="lazy" /> : <span className="wb-thumb"><I.bag size={16} /></span>;
}

export function WBBanners({ s }: { s: WBState }) {
  const out: ReactNode[] = [];
  const { can } = useAuth();
  const fix = can("wildberries") ? <Link className="btn" to="/wildberries">Tokenni yangilash</Link> : undefined;
  if (s.token_broken) out.push(<Banner key="tb" danger text="Saqlangan WB tokenini ochib bo‘lmadi (serverdagi maxfiy kalit o‘zgargan). Tokenni qayta kiriting." action={fix} />);
  if (s.problem === "token_invalid") out.push(<Banner key="ti" danger text="WB tokeni muddati tugagan yoki bekor qilingan. Yuborish to‘xtatildi — yangi token qo‘shing, navbat davom etadi." action={fix} />);
  if (s.problem === "wb_down") out.push(<Banner key="wd" text={`Wildberries vaqtincha javob bermayapti. Navbatdagi vazifalar keyinroq qayta yuboriladi.${s.last_error ? ` (${s.last_error})` : ""}`} />);
  if (s.connected && s.site_url_missing) out.push(<Banner key="su" danger text="Sayt manzili (PUBLIC_BASE_URL) sozlanmagan: WB rasmlarni yuklab ololmaydi. Serverdagi .env faylida PUBLIC_BASE_URL=https://unitedmfl.uz qo‘ying." />);
  if (s.connected && s.currency && s.currency !== "UZS") out.push(<Banner key="cur" text={`WB kabinetidagi narxlar ${s.currency} da. Saytda o‘z narxingiz (so‘m) ko‘rsatiladi.`} />);
  return out.length ? <div className="stack" style={{ gap: 12, marginBottom: 16 }}>{out}</div> : null;
}

function Banner({ text, action, danger }: { text: string; action?: ReactNode; danger?: boolean }) {
  return <div className={`stk-banner${danger ? " danger" : ""}`}>{danger ? <I.alert size={18} /> : <I.refresh size={18} />}<span className="grow">{text}</span>{action}</div>;
}

export function WBLogCard({ log }: { log: WBState["log"] }) {
  return (
    <div className="card">
      <div className="card-head"><h2>WB jurnali</h2></div>
      {!log.length ? <div className="card-pad muted small">Hali hech narsa yuborilmagan</div> : (
        <div className="wb-log">
          {log.map((l, i) => (
            <div key={i}><i className={`stk-dot ${l.level === "ok" ? "ready" : l.level === "warn" ? "queued" : "error"}`} /><span><b>{l.text}</b><small>{fmtShort(l.at)}</small></span></div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api.get<{ total: number; items: WBImportItem[] }>("/admin/wb/import"), []);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setSel(new Set(data.items.map((x) => x.nm_id))); }, [data]);
  async function go() {
    setBusy(true);
    try {
      const r = await api.post<{ created: number[] }>("/admin/wb/import", { nm_ids: [...sel] });
      toast(`${r.created.length} ta mahsulot qo‘shildi`);
      onDone();
    } catch (e) { toast(errText(e), "error"); } finally { setBusy(false); }
  }
  const toggle = (id: number) => setSel((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Modal title="WB kabinetidan import" onClose={onClose} wide footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Bekor qilish</button>
      <button className="btn btn-primary" disabled={busy || !sel.size} onClick={go}>{busy ? "Import qilinmoqda…" : `Import qilish (${sel.size})`}</button>
    </>}>
      {error ? <ErrorBox error={error} retry={reload} /> : loading ? <Loading /> : !data?.items.length ? (
        <Empty title="Yangi kartochka yo‘q" text={`WB kabinetidagi ${data?.total ?? 0} ta kartochkaning hammasi saytda bor.`} />
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <p className="muted small" style={{ margin: 0 }}>WB kabinetida {data.total} ta kartochka, ulardan {data.items.length} tasi saytda yo‘q. Artikul bo‘yicha moslanadi: bor mahsulotlar qayta yaratilmaydi.</p>
          <div className="wb-import">
            {data.items.map((x) => (
              <label key={x.nm_id} className="wb-import-row">
                <input type="checkbox" checked={sel.has(x.nm_id)} onChange={() => toggle(x.nm_id)} />
                <Thumb src={x.photo} />
                <span className="grow stack" style={{ gap: 2 }}><b>{x.title || x.vendor_code}</b><span className="muted small">nm {x.nm_id} · {x.vendor_code} · {x.subject_name}</span></span>
                <span className="muted small">{x.sizes} o‘lcham</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------- W2: product page cards ---------- */

const listOf = (v: unknown) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const numOrEmpty = (v: unknown) => (v === "" || v == null ? "" : String(v));

function useWB() {
  return useLoad(() => api.get<WBState>("/admin/wb").catch(() => null), []);
}

function Card({ title, right, children, pad = true, id }: { title: string; right?: ReactNode; children: ReactNode; pad?: boolean; id?: string }) {
  return (
    <div className="card" id={id}>
      <div className="card-head"><h3>{title}</h3>{right}</div>
      {pad ? <div className="card-pad">{children}</div> : children}
    </div>
  );
}

function ImagesCard({ c }: { c: CardCtx }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [small, setSmall] = useState<Record<string, boolean>>({});
  const imgs = listOf(c.values.images);
  const wbOn = !!c.values.wb_enabled;
  const setImgs = (l: string[]) => c.set("images", l.join(", "));
  async function pick(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const urls: string[] = [];
      for (const f of Array.from(files)) urls.push(await uploadImage(f));
      setImgs([...imgs, ...urls]);
    } catch (e) { toast(errText(e), "error"); } finally { setBusy(false); if (ref.current) ref.current.value = ""; }
  }
  const tooSmall = imgs.filter((u) => small[u]).length;
  return (
    <Card title="Rasmlar" right={<span className="muted small">{imgs.length} / 30 · 3:4 · kamida 900×1200 px</span>}>
      <div className="wb-tiles">
        {imgs.map((u, i) => (
          <div key={u + i} className={`wb-tile${small[u] && wbOn ? " warn" : ""}`}>
            <img src={u} alt="" onLoad={(e) => { const im = e.currentTarget; setSmall((x) => ({ ...x, [u]: im.naturalWidth < 900 || im.naturalHeight < 1200 })); }} />
            {i === 0 && <span className="wb-tile-tag">Asosiy</span>}
            {small[u] && wbOn && <span className="wb-tile-tag warn" title="WB uchun kamida 900×1200 px kerak">Kichik</span>}
            <div className="wb-tile-tools">
              {i > 0 && <button type="button" className="btn btn-sm btn-icon" title="Asosiy qilish" aria-label="Asosiy qilish" onClick={() => setImgs([u, ...imgs.filter((_, k) => k !== i)])}><I.up size={14} /></button>}
              <button type="button" className="btn btn-sm btn-icon" title="Olib tashlash" aria-label="Olib tashlash" onClick={() => setImgs(imgs.filter((_, k) => k !== i))}><I.x size={14} /></button>
            </div>
          </div>
        ))}
        <button type="button" className="wb-tile add" disabled={busy} onClick={() => ref.current?.click()}>
          <I.upload size={20} /><b>{busy ? "Yuklanmoqda…" : "Qo‘shish"}</b><small>JPG / PNG / WEBP</small>
        </button>
      </div>
      <input ref={ref} type="file" multiple accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pick(e.target.files)} />
      <p className="muted small" style={{ margin: "12px 0 0" }}>
        Saytga va WB’ga bir xil rasmlar ketadi. {wbOn && tooSmall > 0 ? <span className="danger-text">{tooSmall} ta rasm 900×1200 dan kichik — WB uni qabul qilmasligi mumkin.</span> : "Birinchi rasm — asosiy."}
      </p>
    </Card>
  );
}

function WBCardForm({ c }: { c: CardCtx }) {
  const wb = useWB();
  const { can } = useAuth();
  const on = !!c.values.wb_enabled;
  const title = String(c.values.wb_title || "");
  const connected = !!wb.data?.connected;
  return (
    <Card title="Wildberries kartochkasi" id="wb-card" right={
      <label className="toggle-row" style={{ gap: 10 }}><span><b className="small">WB’da sotish</b></span><input type="checkbox" className="switch lime" checked={on} onChange={(e) => c.set("wb_enabled", e.target.checked)} /></label>
    }>
      {!on ? <p className="muted small" style={{ margin: 0 }}>O‘chiq: mahsulot faqat saytda. Yoqsangiz, saqlashda kartochka Wildberries do‘koniga yuboriladi.</p> : (
        <div className="stack" style={{ gap: 16 }}>
          {wb.data && !connected && <div className="stk-note"><I.alert size={16} /><span>Wildberries ulanmagan — kartochka saqlanadi, token qo‘shilgach yuboriladi. {can("wildberries") && <Link to="/wildberries">Ulash →</Link>}</span></div>}
          <div className="stk-note"><I.alert size={16} /><span>Kartochka shu yerdan yaratiladi va yangilanadi. WB kabinetida qo‘lda o‘zgartirilgan maydonlar keyingi «Saqlash»da shu sahifadagi qiymat bilan qayta yoziladi.</span></div>
          <SubjectPicker c={c} disabled={!connected} />
          <div className="form-grid">
            <Field label="Brend *" hint="WB kabinetida tasdiqlangan brend" error={c.errors.wb_brand}><input className="input" value={c.values.wb_brand} onChange={(e) => c.set("wb_brand", e.target.value)} /></Field>
            <Field label="Sotuvchi artikuli (vendorCode)" hint="Bo‘sh qolsa slug’dan olinadi. Kartochka yaratilgach o‘zgartirmang" error={c.errors.wb_vendor_code}>
              <input className="input" value={c.values.wb_vendor_code} maxLength={72} placeholder={String(c.values.slug || "").toUpperCase()} onChange={(e) => c.set("wb_vendor_code", e.target.value.replace(/\s/g, ""))} disabled={!!c.item?.wb_nm_id} />
            </Field>
            <Field full label="Sarlavha (WB) *" error={c.errors.wb_title} hint={`${[...title].length} / 60 belgi · bo‘sh qolsa nomdan olinadi`}>
              <input className="input" value={title} maxLength={60} placeholder={String(c.values.name || "")} onChange={(e) => c.set("wb_title", e.target.value)} aria-invalid={[...title].length > 60 || undefined} />
            </Field>
          </div>
          <label className="toggle-row"><span><b>Tavsifni saytdan olish</b><small>WB tavsifi = sayt tavsifi (formatlashsiz matn)</small></span><input type="checkbox" className="switch lime" checked={!!c.values.wb_desc_from_site} onChange={(e) => c.set("wb_desc_from_site", e.target.checked)} /></label>
          {!c.values.wb_desc_from_site && (
            <Field label="Tavsif (WB)" hint={`${String(c.values.wb_description || "").length} / 5000 belgi`}>
              <textarea className="textarea" rows={6} value={c.values.wb_description} onChange={(e) => c.set("wb_description", e.target.value)} />
            </Field>
          )}
        </div>
      )}
    </Card>
  );
}

function SubjectPicker({ c, disabled }: { c: CardCtx; disabled: boolean }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q, 350);
  const [list, setList] = useState<WBSubject[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open || dq.trim().length < 2) { setList([]); return; }
    let live = true;
    api.get<WBSubject[]>(`/admin/wb/subjects?q=${encodeURIComponent(dq.trim())}`).then((r) => { if (live) { setList(r); setErr(""); } }).catch((e) => live && setErr(errText(e)));
    return () => { live = false; };
  }, [dq, open]);
  const id = c.values.wb_subject_id;
  return (
    <Field label="Kategoriya (WB predmet) *" error={c.errors.wb_subject_id || err} hint={id ? `${c.values.wb_subject_name} · ID ${id} — xususiyatlar ro‘yxati shu kategoriyadan olinadi` : "Ruscha yozing: «Футболки», «Шарфы», «Бейсболки»…"}>
      <div className="wb-subject">
        <div className="search"><I.search size={16} />
          <input className="input" disabled={disabled} value={open ? q : String(c.values.wb_subject_name || "")} placeholder={disabled ? "WB ulangach tanlanadi" : "Kategoriya qidirish…"}
            onFocus={() => { setOpen(true); setQ(""); }} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => setQ(e.target.value)} />
        </div>
        {open && list.length > 0 && (
          <div className="wb-subject-list">
            {list.map((x) => (
              <button type="button" key={x.subjectID} onMouseDown={(e) => e.preventDefault()} onClick={() => {
                c.set("wb_subject_id", String(x.subjectID)); c.set("wb_subject_name", x.subjectName); setOpen(false);
              }}><b>{x.subjectName}</b><span className="muted small">{x.parentName} · ID {x.subjectID}</span></button>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}

function CharsCard({ c }: { c: CardCtx }) {
  const subject = Number(c.values.wb_subject_id) || 0;
  const on = !!c.values.wb_enabled;
  const { data, error, loading, reload } = useLoad(() => (on && subject ? api.get<WBCharc[]>(`/admin/wb/subjects/${subject}/charcs`) : Promise.resolve([] as WBCharc[])), [subject, on]);
  const [all, setAll] = useState(false);
  const chars: WBChar[] = Array.isArray(c.values.wb_chars) ? c.values.wb_chars : [];
  const valueOf = (id: number) => {
    const v = chars.find((x) => x.id === id)?.value;
    return Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
  };
  const setValue = (ch: WBCharc, v: string) => {
    const rest = chars.filter((x) => x.id !== ch.id);
    c.set("wb_chars", v.trim() === "" ? rest : [...rest, { id: ch.id, name: ch.name, value: v }]);
  };
  if (!on || !subject) return null;
  const list = data || [];
  const req = list.filter((x) => x.required);
  const filled = req.filter((x) => valueOf(x.id).trim() !== "").length;
  const shown = all ? list : list.filter((x) => x.required || x.popular || valueOf(x.id) !== "").slice(0, Math.max(8, req.length));
  return (
    <Card title="Xususiyatlar" right={list.length ? <span className="row small b" style={{ gap: 6 }}><i className={`stk-dot ${filled === req.length ? "ready" : "error"}`} />Majburiy: {filled} / {req.length}</span> : undefined}>
      {error ? <ErrorBox error={error} retry={reload} /> : loading && !data ? <Loading /> : !list.length ? <p className="muted small" style={{ margin: 0 }}>Bu kategoriya uchun xususiyatlar yo‘q.</p> : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="form-grid">
            {shown.map((ch) => <CharInput key={ch.id} ch={ch} value={valueOf(ch.id)} onChange={(v) => setValue(ch, v)} />)}
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted small">Ro‘yxat WB’dan olinadi, qiymatlar ruscha. Bir nechta qiymat — vergul bilan. * — majburiy.</span>
            {list.length > shown.length || all ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAll(!all)}>{all ? "Qisqartirish" : `Barcha xususiyatlar (${list.length})`}</button> : null}
          </div>
        </div>
      )}
    </Card>
  );
}

const dirCache: Record<string, Promise<string[]>> = {};
function CharInput({ ch, value, onChange }: { ch: WBCharc; value: string; onChange: (v: string) => void }) {
  const [opts, setOpts] = useState<string[]>([]);
  useEffect(() => {
    if (!ch.dict) return;
    dirCache[ch.dict] ||= api.get<string[]>(`/admin/wb/directory/${ch.dict}`).catch(() => []);
    dirCache[ch.dict].then(setOpts);
  }, [ch.dict]);
  const listId = `wbdir-${ch.id}`;
  const label = `${ch.name}${ch.unit ? `, ${ch.unit}` : ""}${ch.required ? " *" : ""}`;
  return (
    <Field label={label} hint={ch.max_count > 1 ? `${ch.max_count} tagacha qiymat` : undefined}>
      <input className="input" value={value} inputMode={ch.number ? "decimal" : undefined} list={opts.length ? listId : undefined} aria-invalid={ch.required && !value.trim() ? true : undefined} onChange={(e) => onChange(e.target.value)} />
      {opts.length > 0 && <datalist id={listId}>{opts.slice(0, 400).map((o) => <option key={o} value={o} />)}</datalist>}
    </Field>
  );
}

function SizesCard({ c }: { c: CardCtx }) {
  const toast = useToast();
  const confirm = useConfirm();
  const id = c.item?.id as number | undefined;
  const on = !!c.values.wb_enabled;
  const { data, reload } = useLoad(() => (id ? api.get<Page<WBVariant>>(`/admin/product-variants?product_id=${id}&limit=100`) : Promise.resolve(null)), [id, c.version]);
  const [size, setSize] = useState("");
  const [wbSize, setWbSize] = useState("");
  const fail = (e: unknown) => toast(errText(e), "error");
  async function add() {
    if (!id || !size.trim()) return;
    try { await api.post("/admin/product-variants", { product_id: id, size: size.trim(), wb_size: wbSize.trim(), available: true }); setSize(""); setWbSize(""); reload(); } catch (e) { fail(e); }
  }
  async function patch(v: WBVariant, body: Partial<WBVariant>) {
    try { await api.patch(`/admin/product-variants/${v.id}`, body); reload(); } catch (e) { fail(e); }
  }
  async function del(v: WBVariant) {
    if (v.wb_chrt_id && !(await confirm({ title: "O‘lchamni o‘chirish", text: "Saytdan o‘chadi. WB kartochkasida bu o‘lcham qoladi (WB o‘lchamni o‘chirishga ruxsat bermaydi).", ok: "O‘chirish", danger: true }))) return;
    try { await api.del(`/admin/product-variants/${v.id}`); reload(); } catch (e) { fail(e); }
  }
  async function genBarcodes() {
    toast("Shtrix-kodlar saqlashda WB’dan avtomatik olinadi");
  }
  return (
    <Card title={on ? "O‘lchamlar, shtrix-kod va qoldiq" : "O‘lchamlar va qoldiq"} pad={false} right={on && id ? <button type="button" className="btn btn-ghost btn-sm" onClick={genBarcodes}>Shtrix-kod</button> : undefined}>
      {!id ? <div className="card-pad muted small">O‘lchamlar mahsulot saqlangandan keyin qo‘shiladi.</div> : (
        <>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>O‘lcham</th>{on && <th>RF o‘lchami (WB)</th>}{on && <th>Shtrix-kod</th>}<th>{on ? "Qoldiq (WB)" : "Qoldiq"}</th><th>Sotuvda</th><th /></tr></thead>
            <tbody>
              {data?.items.map((v) => (
                <tr key={v.id}>
                  <td><b>{v.size}</b></td>
                  {on && <td><input className="input input-sm" style={{ width: 90 }} defaultValue={v.wb_size} placeholder="44" onBlur={(e) => e.target.value !== v.wb_size && patch(v, { wb_size: e.target.value.trim() })} /></td>}
                  {on && <td className="mono small">{v.barcode || <span className="muted">saqlashda olinadi</span>}</td>}
                  <td>{on ? (v.wb_stock == null ? <span className="muted">—</span> : <span className={v.wb_stock === 0 ? "danger-text" : ""}>{v.wb_stock}</span>) : (v.stock ?? "—")}</td>
                  <td><input type="checkbox" className="switch lime" checked={v.available} onChange={() => patch(v, { available: !v.available })} aria-label="Sotuvda" /></td>
                  <td className="actions"><button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="O‘chirish" onClick={() => del(v)}><I.trash size={15} /></button></td>
                </tr>
              ))}
              <tr>
                <td><input className="input input-sm" style={{ width: 90 }} placeholder="M, L, Yagona" value={size} onChange={(e) => setSize(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /></td>
                {on && <td><input className="input input-sm" style={{ width: 90 }} placeholder="46-48" value={wbSize} onChange={(e) => setWbSize(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /></td>}
                <td colSpan={on ? 4 : 3} className="actions"><button type="button" className="btn btn-sm" onClick={add} disabled={!size.trim()}><I.plus size={15} /> Qo‘shish</button></td>
              </tr>
            </tbody>
          </table></div>
          {on && <div className="card-foot muted small">O‘lchamsiz mahsulot (butilka, sharf) uchun bitta «Yagona» qatori qo‘shing. Shtrix-kod bo‘sh bo‘lsa, saqlashda WB’dan olinadi. Qoldiq WB omboridan har 30 daqiqada yangilanadi.</div>}
        </>
      )}
    </Card>
  );
}

function PackageCard({ c }: { c: CardCtx }) {
  if (!c.values.wb_enabled) return null;
  const kg = c.values.pkg_weight_g === "" || c.values.pkg_weight_g == null ? "" : String(Number(c.values.pkg_weight_g) / 1000).replace(".", ",");
  const num = (k: string, label: string) => (
    <Field label={label}><input className="input" type="number" min={1} inputMode="numeric" value={numOrEmpty(c.values[k])} onChange={(e) => c.set(k, e.target.value)} /></Field>
  );
  return (
    <Card title="Qadoq o‘lchami" right={<span className="muted small">WB uchun majburiy</span>}>
      <div className="wb-pkg">
        {num("pkg_length", "Uzunlik, sm")}{num("pkg_width", "Kenglik, sm")}{num("pkg_height", "Balandlik, sm")}
        <Field label="Og‘irlik, kg">
          <input className="input" inputMode="decimal" defaultValue={kg} key={c.version} placeholder="0,3" onChange={(e) => {
            const v = e.target.value.replace(",", ".").trim();
            c.set("pkg_weight_g", v === "" || isNaN(Number(v)) ? "" : String(Math.round(Number(v) * 1000)));
          }} />
        </Field>
      </div>
    </Card>
  );
}

function WBStatusCard({ c }: { c: CardCtx }) {
  const toast = useToast();
  const wb = useWB();
  const id = c.item?.id as number | undefined;
  const [p, setP] = useState<WBProduct | null>((c.item as WBProduct) || null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id) return;
    let live = true;
    const load = () => api.get<WBProduct>(`/admin/products/${id}`).then((x) => live && setP(x)).catch(() => {});
    load();
    const moving = p?.wb_state === "queued" || p?.wb_state === "pending";
    const t = setInterval(load, moving ? 4000 : 30000);
    return () => { live = false; clearInterval(t); };
  }, [id, c.version, p?.wb_state]);
  if (!c.values.wb_enabled) return null;
  if (!id || !p) return <Card title="Wildberries"><p className="muted small" style={{ margin: 0 }}>Saqlangach kartochka WB’ga yuboriladi.</p></Card>;
  const st = wbStatus(p, fmtShort);
  async function push() {
    setBusy(true);
    try { setP(await api.post<WBProduct>(`/admin/wb/products/${id}/push`)); toast("Navbatga qo‘yildi"); } catch (e) { toast(errText(e), "error"); } finally { setBusy(false); }
  }
  const domain = wb.data?.link_domain || "wildberries.uz";
  const url = wbLink(p.wb_nm_id, domain);
  return (
    <div className="card">
      <div className="card-head"><h3>Wildberries</h3><span className="row small b" style={{ gap: 6 }}><i className={`stk-dot ${st.dot}`} />{st.label}</span></div>
      <div className="stk-kv">
        <div><span>nmID (WB artikul)</span><b>{p.wb_nm_id ?? "—"}</b></div>
        <div><span>Sotuvchi artikuli</span><b>{p.wb_vendor_code || "—"}</b></div>
        <div><span>Kartochka</span><b>{p.wb_state === "ready" ? "Tayyor" : p.wb_state === "pending" ? "WB tayyorlayapti" : st.label}</b></div>
        <div><span>Qoldiq (WB ombori)</span><b>{p.wb_stock ?? "—"}</b></div>
        <div><span>Oxirgi yuborish</span><b>{fmtShort(p.wb_sent_at)}</b></div>
      </div>
      {(p.wb_state === "error" || p.wb_state === "incomplete" || (p.wb_state === "queued" && p.wb_attempts > 0)) && p.wb_error && (
        <div className="wb-err"><I.alert size={14} /><span>{p.wb_error}</span></div>
      )}
      {p.wb_state === "pending" && <div className="wb-info"><I.refresh size={14} /><span>WB tekshiruvi odatda 15 daqiqadan 24 soatgacha. Holat har daqiqada tekshiriladi.</span></div>}
      {url && <a className="stk-link" href={url} target="_blank" rel="noreferrer"><span className="grow">{url.replace("https://", "")}</span><I.link size={16} /></a>}
      <div className="card-pad stack" style={{ gap: 8 }}>
        {wb.data?.connected === false ? <span className="muted small">Wildberries ulanmagan</span> : (
          <button type="button" className={`btn ${p.wb_nm_id ? "btn-dark" : "btn-primary"}`} disabled={busy || p.wb_state === "pending"} onClick={push}>
            <I.refresh size={16} /> {p.wb_state === "error" || p.wb_state === "incomplete" ? "Tuzatib qayta yuborish" : p.wb_nm_id ? "WB’ga qayta yuborish" : "WB’ga yuborish"}
          </button>
        )}
        {url && <a className="btn" href={url} target="_blank" rel="noreferrer">WB’da ochish</a>}
        <span className="muted small">Avval o‘zgarishlarni saqlang — WB’ga saqlangan holat yuboriladi.</span>
      </div>
    </div>
  );
}

function WBPriceCard({ c }: { c: CardCtx }) {
  if (!c.values.wb_enabled) return null;
  const price = Number(c.values.wb_price || c.values.price_uzs || 0);
  const disc = Math.min(99, Math.max(0, Number(c.values.wb_discount || 0)));
  const final = Math.round(price * (100 - disc) / 100);
  const cur = c.item as WBProduct | null;
  return (
    <Card title="WB narxi">
      <div className="stack" style={{ gap: 14 }}>
        <Field label="Narx, so‘m" hint="Bo‘sh qolsa sayt narxi olinadi" error={c.errors.wb_price}><input className="input" type="number" inputMode="numeric" placeholder={String(c.values.price_uzs || "")} value={numOrEmpty(c.values.wb_price)} onChange={(e) => c.set("wb_price", e.target.value)} /></Field>
        <Field label="Chegirma, %" error={c.errors.wb_discount}><input className="input" type="number" min={0} max={99} inputMode="numeric" value={numOrEmpty(c.values.wb_discount)} onChange={(e) => c.set("wb_discount", e.target.value)} /></Field>
        <div className="stk-kv" style={{ padding: 0 }}>
          <div><span>Xaridor ko‘radigan narx</span><b>{price ? fmtUZS(final) : "—"}</b></div>
          {cur?.wb_cur_final != null && <div><span>Hozir WB’da</span><b>{fmtUZS(cur.wb_cur_final)}{cur.wb_cur_discount ? ` (−${cur.wb_cur_discount}%)` : ""}</b></div>}
        </div>
        <span className="muted small">Saytda WB narxi chegirma bilan ko‘rsatiladi. WB o‘z aksiyalari bilan narxni qo‘shimcha kamaytirishi mumkin.</span>
      </div>
    </Card>
  );
}

function SiteButtonCard({ c }: { c: CardCtx }) {
  if (!c.values.wb_enabled) return null;
  return (
    <Card title="Saytda">
      <label className="toggle-row"><span><b>«Wildberries’da sotib olish» tugmasi</b><small>Mahsulot sahifasida WB kartochkasiga olib boradi</small></span>
        <input type="checkbox" className="switch lime" checked={!!c.values.wb_show_button} onChange={(e) => c.set("wb_show_button", e.target.checked)} /></label>
    </Card>
  );
}
