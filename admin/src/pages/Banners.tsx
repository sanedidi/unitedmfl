import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router";
import { api, ApiError, uploadImage, type Page } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { useRefs } from "@/lib/refs";
import { aiApi, PROVIDER_LABEL, QUALITY_LABEL, type AiGeneration, type AiSettings, type BannerText, type Improved, type ProviderView } from "@/lib/ai";
import { FormFields, useForm, type FieldSpec, type Rec } from "@/components/Crud";
import { PageHead, SITE_URL } from "@/components/Layout";
import { Badge, Empty, ErrorBox, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

// Same values as the `layout` column; every layout keeps the text readable on any photo.
const LAYOUTS = [
  { value: "shade", label: "Chapdagi soya — matn chapda pastda (standart)" },
  { value: "panel", label: "Pastki panel — matn pastdagi to‘q panelda" },
  { value: "glass", label: "Shisha karta — xira fonli karta" },
  { value: "split", label: "Diagonal — chapda qiya to‘q tekislik" },
  { value: "poster", label: "Afisha — matn markazda (final, maxsus voqea)" },
];

const MAIN: FieldSpec[] = [
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
  { name: "note", label: "Ichki izoh", type: "textarea", full: true },
];
const IMAGES: FieldSpec[] = [
  { name: "image_desktop", label: "Desktop (2400×1100)", type: "image" },
  { name: "image_mobile", label: "Mobil, ixtiyoriy (1080×1920)", type: "image" },
];
const LAYOUT_FIELD: FieldSpec[] = [{ name: "layout", label: "Matn joylashuvi", type: "select", full: true, options: LAYOUTS }];
const PUBLISH: FieldSpec[] = [
  { name: "status", label: "Holat", type: "select", full: true, options: [{ value: "published", label: "Nashr etilgan" }, { value: "draft", label: "Qoralama" }] },
  { name: "is_active", label: "Faol", type: "bool", full: true },
  { name: "show_from", label: "Ko‘rsatish boshlanishi", type: "datetime", full: true },
  { name: "show_until", label: "Ko‘rsatish tugashi", type: "datetime", full: true },
];
const FIELDS = [...MAIN, ...IMAGES, ...LAYOUT_FIELD, ...PUBLISH];
const DEFAULTS = { badge_type: "accent", layout: "shade", status: "draft", is_active: true };
// generated format → banner field it fills
const FORMAT_FIELD: Record<string, string> = { hero_desktop: "image_desktop", hero_mobile: "image_mobile" };

export function BannersPage() {
  return (
    <Routes>
      <Route index element={<BannerList />} />
      <Route path="new" element={<BannerEdit />} />
      <Route path=":id" element={<BannerEdit />} />
    </Routes>
  );
}

function BannerList() {
  const { data, error, loading, reload, setData } = useLoad(() => api.get<Page<Rec>>("/admin/banners?limit=100"), []);
  const navigate = useNavigate();
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
      <PageHead title="Hero-bannerlar" sub="Bosh sahifadagi karusel. Tartib — saytdagi ketma-ketlik; avtoaylanish 5 soniya." actions={<button className="btn btn-primary" onClick={() => navigate("/banners/new")}><I.plus size={16} /> Banner qo‘shish</button>} />
      <div className="card">
        {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : !items.length ? <Empty title="Bannerlar yo‘q" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Tartib</th><th>Banner</th><th className="hide-mobile">Sana</th><th>Holat</th><th /></tr></thead>
            <tbody>
              {items.map((b, i) => (
                <tr key={b.id} className="clickable" onClick={() => navigate(`/banners/${b.id}`)}>
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
    </>
  );
}

function BannerEdit() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const { data, error, loading, reload } = useLoad(() => (isNew ? Promise.resolve(null) : api.get<Rec>(`/admin/banners/${id}`)), [id]);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading && !isNew) return <Loading />;
  return <BannerForm key={String(data?.id ?? "new")} item={data ?? null} />;
}

function BannerForm({ item }: { item: Rec | null }) {
  const form = useForm(FIELDS, item, DEFAULTS);
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(() => JSON.stringify(form.values));
  const [source, setSource] = useState<"upload" | "ai">("upload");
  const dirty = JSON.stringify(form.values) !== saved;
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  async function persist(values: Rec) {
    setBusy(true);
    try {
      const body = Object.fromEntries(Object.keys(form.payload()).map((k) => [k, k in values ? values[k] : form.payload()[k]]));
      const r = item ? await api.patch<Rec>(`/admin/banners/${item.id}`, body) : await api.post<Rec>("/admin/banners", body);
      toast("Saqlandi");
      setSaved(JSON.stringify(form.values));
      if (!item) navigate(`/banners/${r.id}`, { replace: true });
      return true;
    } catch (err) {
      form.fail(err);
      toast(err instanceof Error ? err.message : "Xato", "error");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const save = (e?: React.FormEvent) => { e?.preventDefault(); persist({}); };
  async function cancel() {
    if (dirty && !(await confirm({ title: "O‘zgarishlar saqlanmagan", text: "Sahifadan chiqsangiz, o‘zgarishlar yo‘qoladi.", ok: "Chiqish", danger: true }))) return;
    navigate("/banners");
  }
  async function remove() {
    if (!item || !(await confirm({ title: "Bannerni o‘chirish", text: item.title, ok: "O‘chirish", danger: true }))) return;
    try {
      await api.del(`/admin/banners/${item.id}`);
      toast("O‘chirildi");
      navigate("/banners", { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }
  /** A generated variant was chosen: fill the image fields; an existing banner is saved right away. */
  async function applyImages(images: Record<string, string>) {
    for (const [k, v] of Object.entries(images)) form.set(k, v);
    setSource("upload");
    if (item) {
      const ok = await persist(images);
      if (ok) setSaved(JSON.stringify({ ...form.values, ...images }));
    } else toast("Rasm qo‘yildi — bannerni saqlang");
  }

  const title = item ? String(form.values.title || item.title || "Banner") : "Yangi banner";
  return (
    <form onSubmit={save}>
      <PageHead title={title}
        sub={<span className="crumbs"><Link to="/banners" onClick={(e) => { e.preventDefault(); cancel(); }}>Hero-bannerlar</Link> / <b>{item ? "Tahrirlash" : "Yangi"}</b>{dirty && <span className="muted small"> · saqlanmagan o‘zgarishlar</span>}</span>}
        actions={<>
          <button type="button" className="btn btn-ghost" onClick={cancel}>Bekor qilish</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saqlanmoqda…" : "Saqlash"}</button>
        </>} />
      <div className="edit-layout">
        <div className="stack" style={{ gap: 24 }}>
          <div className="card">
            <div className="card-head"><h3>Asosiy ma’lumotlar</h3></div>
            <div className="card-pad"><FormFields fields={MAIN} values={form.values} set={form.set} errors={form.errors} /></div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3>Fon rasmi</h3>
              <div className="seg" role="tablist" aria-label="Rasm manbai">
                <button type="button" role="tab" aria-pressed={source === "upload"} onClick={() => setSource("upload")}><I.upload size={15} /> Yuklash</button>
                <button type="button" role="tab" aria-pressed={source === "ai"} onClick={() => setSource("ai")}><I.sparkles size={15} /> AI bilan yaratish</button>
              </div>
            </div>
            <div className="card-pad">
              {source === "upload"
                ? <FormFields fields={IMAGES} values={form.values} set={form.set} errors={form.errors} />
                : <AiGenerator bannerId={item ? Number(item.id) : null} title={String(form.values.title || "")} layout={String(form.values.layout || "shade")} onApply={applyImages}
                    banner={{ title: String(form.values.title || ""), badge: String(form.values.badge || ""), meta: !!(form.values.event_date || form.values.venue), cta: !!form.values.cta_label }} />}
            </div>
          </div>
        </div>
        <aside className="stack" style={{ gap: 24 }}>
          <div className="card">
            <div className="card-head"><h3>Ko‘rinish</h3><a className="small" href={`${SITE_URL}/internal/hero`} target="_blank" rel="noopener noreferrer">Saytda solishtirish</a></div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              <HeroPreview values={form.values} />
              <FormFields fields={LAYOUT_FIELD} values={form.values} set={form.set} errors={form.errors} />
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Nashr</h3></div>
            <div className="card-pad side-fields"><FormFields fields={PUBLISH} values={form.values} set={form.set} errors={form.errors} /></div>
          </div>
          {item && <button type="button" className="btn btn-ghost danger-text" style={{ alignSelf: "flex-start" }} onClick={remove}><I.trash size={16} /> Bannerni o‘chirish</button>}
        </aside>
      </div>
    </form>
  );
}

function HeroPreview({ values }: { values: Rec }) {
  const img = values.image_desktop as string;
  return (
    <div className={`hero-mini l-${values.layout || "shade"}`} style={img ? { backgroundImage: `url("${img}")` } : undefined}>
      {!img && <span className="hero-mini-empty">Rasm yo‘q</span>}
      <div className="hero-mini-text">
        {values.badge && <span className="hero-mini-badge">{values.badge}</span>}
        <b>{values.title || "Sarlavha"}</b>
        {(values.event_date || values.venue) && <small>{[values.event_date ? fmtDate(values.event_date) : "", values.event_time, values.venue].filter(Boolean).join(" · ")}</small>}
      </div>
    </div>
  );
}

/* ---------- AI generator: describe → improve (required) → confirm → generate → pick a variant ---------- */
type Asset = { key: string; kind: "logo" | "url"; url: string; label: string; thumb: string };
type Step = "input" | "review" | "run";

function AiGenerator({ bannerId, title, layout, banner, onApply }: { bannerId: number | null; title: string; layout: string; banner: BannerText; onApply: (images: Record<string, string>) => void }) {
  const { can } = useAuth();
  const { teams } = useRefs();
  const toast = useToast();
  const prov = useLoad(() => aiApi.providers(), []);
  const st = useLoad(() => aiApi.settings(), []);
  const [step, setStep] = useState<Step>("input");
  const [text, setText] = useState("");
  const [improving, setImproving] = useState(false);
  const [improved, setImproved] = useState<Improved | null>(null);
  const [prompt, setPrompt] = useState("");
  const [withAssets, setWithAssets] = useState(true);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [formats, setFormats] = useState<string[] | null>(null);
  const [gen, setGen] = useState<AiGeneration | null>(null);
  const [variant, setVariant] = useState(0);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const settings = st.data;

  // preselect assets and formats once settings and teams are known
  useEffect(() => {
    if (!settings || assets) return;
    const list: Asset[] = [];
    if (settings.default_assets.logo) list.push(logoAsset());
    if (settings.default_assets.crests && title) {
      const t = title.toLowerCase();
      for (const team of teams) if (team.crest_url && t.includes(team.name.toLowerCase())) list.push(crestAsset(team.name, team.crest_url));
    }
    setAssets(list);
  }, [settings, teams, title, assets]);
  useEffect(() => {
    if (!settings || formats) return;
    const enabled = settings.format_order.filter((k) => settings.formats[k]?.enabled);
    setFormats(enabled.filter((k) => k in FORMAT_FIELD).length ? enabled.filter((k) => k in FORMAT_FIELD) : enabled.slice(0, 1));
  }, [settings, formats]);

  // poll the running job
  useEffect(() => {
    if (!gen || gen.status !== "running") return;
    const t = setInterval(async () => {
      try {
        const g = await aiApi.get(gen.id);
        if (g.status !== "running") setGen(g);
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(t);
  }, [gen]);

  const offError = (prov.error instanceof ApiError && prov.error.status === 503) || (st.error instanceof ApiError && st.error.status === 503);
  if (offError) return <div className="alert warn"><I.alert size={16} /><div><b>AI-servis o‘chirilgan.</b> Serverda AI_SERVICE_URL sozlanmagan yoki servis ishlamayapti. Hozircha rasmni «Yuklash» orqali qo‘shing.</div></div>;
  if (prov.error || st.error) return <ErrorBox error={prov.error || st.error} retry={() => { prov.reload(); st.reload(); }} />;
  if (!prov.data || !settings || !assets || !formats) return <Loading />;

  const connected = prov.data.filter((p) => p.connected && p.status !== "error");
  const active: ProviderView | undefined = prov.data.find((p) => p.provider === settings.provider && p.connected) || connected[0];
  const ready = !!active;
  const model = active ? settings.image_model[active.provider] : "";
  const used = withAssets ? assets : [];
  const enabledFormats = settings.format_order.filter((k) => settings.formats[k]?.enabled);
  const max = settings.max_assets;

  function logoAsset(): Asset { return { key: "logo", kind: "logo", url: "", label: "Liga logotipi", thumb: `${SITE_URL}/icon.png` }; }
  function crestAsset(name: string, url: string): Asset { return { key: `crest:${url}`, kind: "url", url, label: `${name} gerbi`, thumb: url }; }
  function addAsset(a: Asset) {
    if (assets!.some((x) => x.key === a.key)) return;
    if (assets!.length >= max) { toast(`Ko‘pi bilan ${max} ta asset`, "error"); return; }
    setAssets([...assets!, a]);
  }
  async function uploadAsset(f?: File) {
    if (!f) return;
    try {
      const url = await uploadImage(f);
      addAsset({ key: `url:${url}`, kind: "url", url, label: f.name.replace(/\.[a-z0-9]+$/i, ""), thumb: url });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Yuklashda xato", "error");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function improve() {
    setImproving(true);
    setErr("");
    try {
      const r = await aiApi.improve({ prompt: text.trim(), layout, assets: used.map((a) => a.label), banner });
      setImproved(r);
      setPrompt(r.prompt);
      setStep("review");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Xato");
    } finally {
      setImproving(false);
    }
  }
  async function generate() {
    setBusy("start");
    setErr("");
    try {
      const g = await aiApi.start({
        prompt_original: text.trim(), prompt: prompt.trim(), layout, formats,
        assets: used.map((a) => ({ kind: a.kind, url: a.url, label: a.label })), target: "banner", target_id: bannerId, banner,
      });
      setGen(g);
      setVariant(0);
      setStep("run");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Xato");
    } finally {
      setBusy("");
    }
  }
  async function stop() {
    if (!gen) return;
    setBusy("cancel");
    try { setGen(await aiApi.cancel(gen.id)); } catch (e) { toast(e instanceof Error ? e.message : "Xato", "error"); } finally { setBusy(""); }
  }
  async function apply() {
    if (!gen) return;
    setBusy("apply");
    try {
      const g = await aiApi.apply(gen.id, variant, bannerId);
      setGen(g);
      const images: Record<string, string> = {};
      for (const [fmt, img] of Object.entries(g.variants[variant]?.images || {})) if (FORMAT_FIELD[fmt]) images[FORMAT_FIELD[fmt]] = img.url;
      onApply(images);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy("");
    }
  }
  async function saveToMedia() {
    if (!gen) return;
    setBusy("save");
    try { setGen(await aiApi.save(gen.id)); toast("Mediaga saqlandi — rasmlar /uploads da qoladi"); } catch (e) { toast(e instanceof Error ? e.message : "Xato", "error"); } finally { setBusy(""); }
  }

  return (
    <div className="stack ai-gen" style={{ gap: 16 }}>
      {!ready && (
        <div className="alert warn"><I.alert size={16} /><div><b>AI-servis ulanmagan.</b> OpenAI yoki Gemini kaliti kiritilmagan.{can("users") ? <> <Link to="/ai">AI-servis → Ulanishlar</Link></> : " Administratorga murojaat qiling."}</div></div>
      )}

      <Steps step={step} gen={gen} />

      {step === "input" && (
        <>
          <div className="field">
            <label htmlFor="ai-desc">Rasm tavsifi</label>
            <textarea id="ai-desc" className="textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="Masalan: kechki stadion, projektor nurlari, ikki jamoa futbolchilari to‘p uchun kurashmoqda, tribunada muxlislar…" />
            <div className="muted small">O‘zbek yoki rus tilida yozing. Keyingi qadamda AI tavsifni kengaytiradi — siz tekshirib tasdiqlaysiz.</div>
          </div>
          <AssetsBlock withAssets={withAssets} setWithAssets={setWithAssets} assets={assets} setAssets={setAssets} max={max}
            onLogo={() => addAsset(logoAsset())} teams={teams} onCrest={(n, u) => addAsset(crestAsset(n, u))} onUpload={() => fileRef.current?.click()} />
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => uploadAsset(e.target.files?.[0])} />
          <FormatsBlock settings={settings} enabled={enabledFormats} formats={formats} setFormats={setFormats} />
          <SettingsSummary settings={settings} provider={active?.provider} model={model} canEdit={can("users")} />
          {err && <div className="alert danger"><I.alert size={16} /><div>{err}</div></div>}
          <div className="row wrap">
            <button type="button" className="btn btn-primary" onClick={improve} disabled={!ready || improving || text.trim().length < 5 || !formats.length}>
              <I.sparkles size={16} /> {improving ? "Yaxshilanmoqda…" : "Promptni yaxshilash"}
            </button>
            <span className="muted small">Yaratishdan oldin majburiy qadam</span>
          </div>
        </>
      )}

      {step === "review" && improved && (
        <>
          <div className="ai-orig">
            <div className="muted small">Asl tavsif</div>
            <div>{text}</div>
          </div>
          <div className="field">
            <label htmlFor="ai-prompt">Yaxshilangan prompt — tahrirlash mumkin</label>
            <textarea id="ai-prompt" className="textarea" rows={7} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <div className="muted small">{PROVIDER_LABEL[improved.provider] || improved.provider} · {improved.model} · {(improved.ms / 1000).toFixed(1)} s</div>
          </div>
          {improved.added.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="muted small">AI qo‘shgan tafsilotlar</div>
              <div className="chips">{improved.added.map((a) => <span key={a} className="chip-static">+ {a}</span>)}</div>
            </div>
          )}
          <div className="muted small">
            {used.length ? `Assetlar: ${used.map((a) => a.label).join(", ")}` : "Assetlarsiz"} · {formats.map((f) => settings.formats[f]?.label || f).join(", ")}
          </div>
          {err && <div className="alert danger"><I.alert size={16} /><div>{err}</div></div>}
          <div className="row wrap">
            <button type="button" className="btn btn-primary" onClick={generate} disabled={busy === "start" || prompt.trim().length < 5}>
              <I.check size={16} /> {busy === "start" ? "Yuborilmoqda…" : `Tasdiqlash va yaratish · ${settings.variants} variant`}
            </button>
            <button type="button" className="btn" onClick={improve} disabled={improving}><I.refresh size={16} /> {improving ? "Yaxshilanmoqda…" : "Qayta yaxshilash"}</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setStep("input"); setImproved(null); }}>Asl tavsifga qaytish</button>
          </div>
        </>
      )}

      {step === "run" && gen && (
        gen.status === "running" ? <Running gen={gen} expected={settings.quality === "high" ? 90 : settings.quality === "medium" ? 50 : 25} onStop={stop} stopping={busy === "cancel"} />
        : gen.status === "error" || gen.status === "cancelled" ? (
          <>
            <div className={`alert ${gen.status === "error" ? "danger" : "warn"}`}><I.alert size={16} /><div><b>{gen.status === "error" ? "Rasm yaratilmadi." : "Bekor qilindi."}</b> {gen.error}</div></div>
            <div className="row wrap">
              <button type="button" className="btn btn-primary" onClick={generate} disabled={!!busy}><I.refresh size={16} /> Qayta urinish</button>
              <button type="button" className="btn btn-ghost" onClick={() => setStep("review")}>Promptni tahrirlash</button>
            </div>
          </>
        ) : (
          <Results gen={gen} variant={variant} setVariant={setVariant} settings={settings} busy={busy}
            onApply={apply} onSave={saveToMedia} onRetry={() => setStep("review")} />
        )
      )}
    </div>
  );
}

function Steps({ step, gen }: { step: Step; gen: AiGeneration | null }) {
  const idx = step === "input" ? 0 : step === "review" ? 1 : gen && gen.status !== "running" ? 3 : 2;
  const names = ["Tavsif", "Promptni tasdiqlash", "Yaratish", "Variant tanlash"];
  return (
    <ol className="ai-steps">
      {names.map((n, i) => <li key={n} className={i < idx ? "done" : i === idx ? "on" : ""}><span>{i < idx ? <I.check size={12} /> : i + 1}</span>{n}</li>)}
    </ol>
  );
}

function AssetsBlock(p: {
  withAssets: boolean; setWithAssets: (v: boolean) => void; assets: Asset[]; setAssets: (a: Asset[]) => void; max: number;
  onLogo: () => void; teams: { name: string; crest_url?: string }[]; onCrest: (name: string, url: string) => void; onUpload: () => void;
}) {
  const crestTeams = p.teams.filter((t) => t.crest_url && !p.assets.some((a) => a.url === t.crest_url));
  return (
    <div className="ai-block">
      <label className="toggle-row">
        <span><b>Assetlar bilan</b><small>Logotip, gerblar va rasmlar modelga namuna sifatida yuboriladi — brend elementlari aniq chiqadi</small></span>
        <input type="checkbox" className="switch" checked={p.withAssets} onChange={(e) => p.setWithAssets(e.target.checked)} />
      </label>
      {p.withAssets && (
        <>
          <div className="asset-grid">
            {p.assets.map((a) => (
              <div key={a.key} className="asset-tile">
                <div className="asset-thumb" style={{ backgroundImage: `url("${a.thumb}")` }} />
                <span className="ellipsis" title={a.label}>{a.label}</span>
                <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`${a.label} — olib tashlash`} onClick={() => p.setAssets(p.assets.filter((x) => x.key !== a.key))}><I.x size={14} /></button>
              </div>
            ))}
            {!p.assets.length && <div className="muted small">Asset tanlanmagan</div>}
          </div>
          <div className="row wrap">
            {!p.assets.some((a) => a.kind === "logo") && <button type="button" className="btn btn-sm" onClick={p.onLogo}><I.plus size={14} /> Liga logotipi</button>}
            {crestTeams.length > 0 && (
              <select className="select input-sm" style={{ width: "auto" }} value="" onChange={(e) => { const t = crestTeams.find((x) => x.crest_url === e.target.value); if (t) p.onCrest(t.name, t.crest_url!); }} aria-label="Jamoa gerbini qo‘shish">
                <option value="">+ Jamoa gerbi…</option>
                {crestTeams.map((t) => <option key={t.crest_url} value={t.crest_url}>{t.name}</option>)}
              </select>
            )}
            <button type="button" className="btn btn-sm" onClick={p.onUpload}><I.upload size={14} /> Mediadan</button>
            <span className="muted small">{p.assets.length} / {p.max}</span>
          </div>
        </>
      )}
    </div>
  );
}

function FormatsBlock({ settings, enabled, formats, setFormats }: { settings: AiSettings; enabled: string[]; formats: string[]; setFormats: (f: string[]) => void }) {
  return (
    <div className="ai-block">
      <div className="muted small" style={{ marginBottom: 8 }}>Formatlar</div>
      <div className="row wrap">
        {enabled.map((k) => {
          const f = settings.formats[k];
          const on = formats.includes(k);
          return (
            <label key={k} className={`check-pill${on ? " on" : ""}`}>
              <input type="checkbox" checked={on} onChange={() => setFormats(on ? formats.filter((x) => x !== k) : enabled.filter((x) => x === k || formats.includes(x)))} />
              {f.label} <span className="muted">{f.w}×{f.h}</span>
            </label>
          );
        })}
      </div>
      {formats.length > 1 && <div className="muted small" style={{ marginTop: 6 }}>Birinchi format yaratiladi, qolganlari shu kadrdan qayta kompozitsiya qilinadi — desktop va mobil bir xil chiqadi.</div>}
    </div>
  );
}

function SettingsSummary({ settings, provider, model, canEdit }: { settings: AiSettings; provider?: string; model: string; canEdit: boolean }) {
  return (
    <div className="ai-summary">
      <span><b>{provider ? PROVIDER_LABEL[provider] : "—"}</b> · {model || "model tanlanmagan"}</span>
      <span>Sifat: {QUALITY_LABEL[settings.quality]}</span>
      <span>{settings.variants} variant</span>
      <span>{settings.file_format.toUpperCase()} {settings.compression}%</span>
      {canEdit && <Link to="/ai/settings">Sozlamalar</Link>}
    </div>
  );
}

function Running({ gen, expected, onStop, stopping }: { gen: AiGeneration; expected: number; onStop: () => void; stopping: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const elapsed = Math.max(0, (now - new Date(gen.created_at).getTime()) / 1000);
  const pct = Math.min(95, (elapsed / expected) * 100);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="ai-running">
        <I.sparkles size={20} />
        <div className="grow">
          <b>Rasm yaratilmoqda…</b>
          <div className="muted small">{Math.round(elapsed)} s · odatda {expected} s gacha. Sahifani yopsangiz ham natija «AI-servis → Tarix»da saqlanadi.</div>
        </div>
      </div>
      <div className="progress"><i style={{ width: `${pct}%` }} /></div>
      <div className="muted small clamp-2" title={gen.prompt}>{gen.prompt}</div>
      <div><button type="button" className="btn" onClick={onStop} disabled={stopping}>{stopping ? "To‘xtatilmoqda…" : "To‘xtatish"}</button></div>
    </div>
  );
}

function Results({ gen, variant, setVariant, settings, busy, onApply, onSave, onRetry }: {
  gen: AiGeneration; variant: number; setVariant: (v: number) => void; settings: AiSettings; busy: string; onApply: () => void; onSave: () => void; onRetry: () => void;
}) {
  const variants = gen.variants || [];
  const warnings = gen.warnings || [];
  const order = useMemo(() => gen.formats.slice().sort((a, b) => (a === "hero_mobile" ? 1 : 0) - (b === "hero_mobile" ? 1 : 0)), [gen.formats]);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row muted small"><I.check size={16} /> {variants.length} variant · {PROVIDER_LABEL[gen.provider] || gen.provider} · {gen.model} · {(gen.duration_ms / 1000).toFixed(0)} s</div>
      {warnings.length > 0 && <div className="alert warn"><I.alert size={16} /><div>{warnings.map((w) => <div key={w}>{w}</div>)}</div></div>}
      <div className="variant-list" role="radiogroup" aria-label="Variantlar">
        {variants.map((v, i) => (
          <label key={i} className={`variant${variant === i ? " on" : ""}`}>
            <input type="radio" name="ai-variant" checked={variant === i} onChange={() => setVariant(i)} />
            <div className="variant-head"><b>Variant {i + 1}</b>{gen.applied_variant === i && gen.status === "applied" && <Badge tone="ok">Bannerda</Badge>}</div>
            <div className="variant-imgs">
              {order.map((f) => {
                const img = v.images[f];
                if (!img) return null;
                return (
                  <div key={f} className={`variant-img${img.height > img.width ? " tall" : ""}`} title={`${settings.formats[f]?.label || f} · ${img.width}×${img.height}`}>
                    <img src={img.url} alt={`Variant ${i + 1} — ${settings.formats[f]?.label || f}`} loading="lazy" />
                    <span>{settings.formats[f]?.label || f} · {img.width}×{img.height}</span>
                    <a className="variant-open" href={img.url} target="_blank" rel="noopener noreferrer" aria-label="To‘liq o‘lchamda ochish" onClick={(e) => e.stopPropagation()}><I.eye size={14} /></a>
                  </div>
                );
              })}
            </div>
          </label>
        ))}
      </div>
      <div className="row wrap">
        <button type="button" className="btn btn-primary" onClick={onApply} disabled={!!busy || !variants.length}><I.check size={16} /> {busy === "apply" ? "Qo‘llanmoqda…" : "Bannerga qo‘llash"}</button>
        <button type="button" className="btn" onClick={onSave} disabled={!!busy || gen.status === "saved"}>{gen.status === "saved" ? "Mediada saqlangan" : "Mediaga saqlash"}</button>
        <button type="button" className="btn btn-ghost" onClick={onRetry}><I.refresh size={16} /> Qayta yaratish</button>
      </div>
    </div>
  );
}
