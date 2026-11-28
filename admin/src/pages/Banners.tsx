import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router";
import { api, ApiError, uploadImage, type Page } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import { useAuth, Allowed } from "@/lib/auth";
import { useRefs } from "@/lib/refs";
import { aiApi, PROVIDER_LABEL, QUALITY_LABEL, type AiGeneration, type AiSettings, type BannerText, type Improved, type ProviderView } from "@/lib/ai";
import { FormFields, useForm, type FieldSpec, type Rec } from "@/components/Crud";
import { PageHead, SITE_URL } from "@/components/Layout";
import { Badge, Empty, ErrorBox, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

import { tx } from "@/lib/i18n";
// Same values as the `layout` column; every layout keeps the text readable on any photo.
const LAYOUTS = [
  { value: "shade", label: tx("Chapdagi soya — matn chapda pastda (standart)") },
  { value: "panel", label: tx("Pastki panel — matn pastdagi to‘q panelda") },
  { value: "glass", label: tx("Shisha karta — xira fonli karta") },
  { value: "split", label: tx("Diagonal — chapda qiya to‘q tekislik") },
  { value: "poster", label: tx("Afisha — matn markazda (final, maxsus voqea)") },
];

const MAIN: FieldSpec[] = [
  { name: "title", label: tx("Sarlavha"), required: true, full: true },
  { name: "badge", label: tx("Belgi"), placeholder: tx("FINAL, YARIM FINAL…") },
  { name: "badge_type", label: tx("Belgi rangi"), type: "select", options: [
    { value: "accent", label: tx("Yashil (aksent)") }, { value: "stage", label: tx("To‘q ko‘k (bosqich)") }, { value: "category", label: tx("Kulrang (rukn)") }, { value: "live", label: tx("Pushti (jonli)") }, { value: "demo", label: tx("Demo") },
  ] },
  { name: "event_date", label: tx("Sana"), type: "date" },
  { name: "event_time", label: tx("Vaqt"), placeholder: "20:00" },
  { name: "venue", label: tx("Joy"), full: true },
  { name: "cta_label", label: tx("Tugma matni"), placeholder: tx("Chipta sotib olish") },
  { name: "cta_url", label: tx("Tugma havolasi"), type: "url" },
  { name: "note", label: tx("Ichki izoh"), type: "textarea", full: true },
];
const IMAGES: FieldSpec[] = [
  { name: "image_desktop", label: tx("Desktop (2400×1100)"), type: "image" },
  { name: "image_mobile", label: tx("Mobil, ixtiyoriy (1080×1920)"), type: "image" },
];
const LAYOUT_FIELD: FieldSpec[] = [{ name: "layout", label: tx("Matn joylashuvi"), type: "select", full: true, options: LAYOUTS }];
const PUBLISH: FieldSpec[] = [
  { name: "status", label: tx("Holat"), type: "select", full: true, options: [{ value: "published", label: tx("Nashr etilgan") }, { value: "draft", label: tx("Qoralama") }] },
  { name: "is_active", label: tx("Faol"), type: "bool", full: true },
  { name: "show_from", label: tx("Ko‘rsatish boshlanishi"), type: "datetime", full: true },
  { name: "show_until", label: tx("Ko‘rsatish tugashi"), type: "datetime", full: true },
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
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
      reload();
    }
  }
  async function remove(b: Rec) {
    if (!(await confirm({ title: tx("Bannerni o‘chirish"), text: b.title, ok: tx("O‘chirish"), danger: true }))) return;
    await api.del(`/admin/banners/${b.id}`).then(() => { toast(tx("O‘chirildi")); reload(); }, (e) => toast(e.message, "error"));
  }

  return (
    <>
      <PageHead title={tx("Hero-bannerlar")} sub={tx("Bosh sahifadagi karusel. Tartib — saytdagi ketma-ketlik; avtoaylanish 5 soniya.")} actions={<Allowed to="create"><button className="btn btn-primary" onClick={() => navigate("/banners/new")}><I.plus size={16} />{" "}{tx("Banner qo‘shish")}</button></Allowed>} />
      <div className="card">
        {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : !items.length ? <Empty title={tx("Bannerlar yo‘q")} /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{tx("Tartib")}</th><th>{tx("Banner")}</th><th className="hide-mobile">{tx("Sana")}</th><th>{tx("Holat")}</th><th /></tr></thead>
            <tbody>
              {items.map((b, i) => (
                <tr key={b.id} className="clickable" onClick={() => navigate(`/banners/${b.id}`)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="row" style={{ gap: 2 }}>
                      <button className="btn btn-ghost btn-sm btn-icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label={tx("Yuqoriga")}><I.up size={16} /></button>
                      <button className="btn btn-ghost btn-sm btn-icon" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={tx("Pastga")}><I.down size={16} /></button>
                    </div>
                  </td>
                  <td>
                    <div className="row">
                      <div className="img-preview wide" style={{ width: 96, height: 54, ...(b.image_desktop ? { backgroundImage: `url("${b.image_desktop}")` } : {}) }}>{!b.image_desktop && "—"}</div>
                      <div><b>{b.title}</b><div className="muted small">{b.badge}</div></div>
                    </div>
                  </td>
                  <td className="hide-mobile nowrap">{b.event_date ? fmtDate(b.event_date) : "—"} {b.event_time}</td>
                  <td>{b.status === "draft" ? <Badge>{tx("Qoralama")}</Badge> : b.is_active ? <Badge tone="ok">{tx("Faol")}</Badge> : <Badge tone="warn">{tx("O‘chirilgan")}</Badge>}</td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}><Allowed to="delete"><button className="btn btn-ghost btn-sm btn-icon" onClick={() => remove(b)} aria-label={tx("O‘chirish")}><I.trash size={16} /></button></Allowed></td>
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
      toast(tx("Saqlandi"));
      setSaved(JSON.stringify(form.values));
      if (!item) navigate(`/banners/${r.id}`, { replace: true });
      return true;
    } catch (err) {
      form.fail(err);
      toast(err instanceof Error ? err.message : tx("Xato"), "error");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const save = (e?: React.FormEvent) => { e?.preventDefault(); persist({}); };
  async function cancel() {
    if (dirty && !(await confirm({ title: tx("O‘zgarishlar saqlanmagan"), text: tx("Sahifadan chiqsangiz, o‘zgarishlar yo‘qoladi."), ok: tx("Chiqish"), danger: true }))) return;
    navigate("/banners");
  }
  async function remove() {
    if (!item || !(await confirm({ title: tx("Bannerni o‘chirish"), text: item.title, ok: tx("O‘chirish"), danger: true }))) return;
    try {
      await api.del(`/admin/banners/${item.id}`);
      toast(tx("O‘chirildi"));
      navigate("/banners", { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    }
  }
  /** A generated variant was chosen: fill the image fields; an existing banner is saved right away. */
  async function applyImages(images: Record<string, string>) {
    for (const [k, v] of Object.entries(images)) form.set(k, v);
    setSource("upload");
    if (item) {
      const ok = await persist(images);
      if (ok) setSaved(JSON.stringify({ ...form.values, ...images }));
    } else toast(tx("Rasm qo‘yildi — bannerni saqlang"));
  }

  const title = item ? String(form.values.title || item.title || tx("Banner")) : tx("Yangi banner");
  return (
    <form onSubmit={save}>
      <PageHead title={title}
        sub={<span className="crumbs"><Link to="/banners" onClick={(e) => { e.preventDefault(); cancel(); }}>{tx("Hero-bannerlar")}</Link> / <b>{item ? tx("Tahrirlash") : tx("Yangi")}</b>{dirty && <span className="muted small">{" "}{tx("· saqlanmagan o‘zgarishlar")}</span>}</span>}
        actions={<>
          <button type="button" className="btn btn-ghost" onClick={cancel}>{tx("Bekor qilish")}</button>
          <Allowed to={item ? "edit" : "create"}><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tx("Saqlanmoqda…") : tx("Saqlash")}</button></Allowed>
        </>} />
      <div className="edit-layout">
        <div className="stack" style={{ gap: 24 }}>
          <div className="card">
            <div className="card-head"><h3>{tx("Asosiy ma’lumotlar")}</h3></div>
            <div className="card-pad"><FormFields fields={MAIN} values={form.values} set={form.set} errors={form.errors} /></div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3>{tx("Fon rasmi")}</h3>
              <div className="seg" role="tablist" aria-label={tx("Rasm manbai")}>
                <button type="button" role="tab" aria-pressed={source === "upload"} onClick={() => setSource("upload")}><I.upload size={15} />{" "}{tx("Yuklash")}</button>
                <button type="button" role="tab" aria-pressed={source === "ai"} onClick={() => setSource("ai")}><I.sparkles size={15} />{" "}{tx("AI bilan yaratish")}</button>
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
            <div className="card-head"><h3>{tx("Ko‘rinish")}</h3><a className="small" href={`${SITE_URL}/internal/hero`} target="_blank" rel="noopener noreferrer">{tx("Saytda solishtirish")}</a></div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              <HeroPreview values={form.values} />
              <FormFields fields={LAYOUT_FIELD} values={form.values} set={form.set} errors={form.errors} />
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>{tx("Nashr")}</h3></div>
            <div className="card-pad side-fields"><FormFields fields={PUBLISH} values={form.values} set={form.set} errors={form.errors} /></div>
          </div>
          {item && <Allowed to="delete"><button type="button" className="btn btn-ghost danger-text" style={{ alignSelf: "flex-start" }} onClick={remove}><I.trash size={16} />{" "}{tx("Bannerni o‘chirish")}</button></Allowed>}
        </aside>
      </div>
    </form>
  );
}

function HeroPreview({ values }: { values: Rec }) {
  const img = values.image_desktop as string;
  return (
    <div className={`hero-mini l-${values.layout || "shade"}`} style={img ? { backgroundImage: `url("${img}")` } : undefined}>
      {!img && <span className="hero-mini-empty">{tx("Rasm yo‘q")}</span>}
      <div className="hero-mini-text">
        {values.badge && <span className="hero-mini-badge">{values.badge}</span>}
        <b>{values.title || tx("Sarlavha")}</b>
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
  if (offError) return <div className="alert warn"><I.alert size={16} /><div><b>{tx("AI-servis o‘chirilgan.")}</b>{" "}{tx("Serverda AI_SERVICE_URL sozlanmagan yoki servis ishlamayapti. Hozircha rasmni «Yuklash» orqali qo‘shing.")}</div></div>;
  if (prov.error || st.error) return <ErrorBox error={prov.error || st.error} retry={() => { prov.reload(); st.reload(); }} />;
  if (!prov.data || !settings || !assets || !formats) return <Loading />;

  const connected = prov.data.filter((p) => p.connected && p.status !== "error");
  const active: ProviderView | undefined = prov.data.find((p) => p.provider === settings.provider && p.connected) || connected[0];
  const ready = !!active;
  const model = active ? settings.image_model[active.provider] : "";
  const used = withAssets ? assets : [];
  const enabledFormats = settings.format_order.filter((k) => settings.formats[k]?.enabled);
  const max = settings.max_assets;

  function logoAsset(): Asset { return { key: "logo", kind: "logo", url: "", label: tx("Liga logotipi"), thumb: `${SITE_URL}/icon.png` }; }
  function crestAsset(name: string, url: string): Asset { return { key: `crest:${url}`, kind: "url", url, label: tx("{0} gerbi", name), thumb: url }; }
  function addAsset(a: Asset) {
    if (assets!.some((x) => x.key === a.key)) return;
    if (assets!.length >= max) { toast(tx("Ko‘pi bilan {0} ta asset", max), "error"); return; }
    setAssets([...assets!, a]);
  }
  async function uploadAsset(f?: File) {
    if (!f) return;
    try {
      const url = await uploadImage(f);
      addAsset({ key: `url:${url}`, kind: "url", url, label: f.name.replace(/\.[a-z0-9]+$/i, ""), thumb: url });
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Yuklashda xato"), "error");
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
      setErr(e instanceof Error ? e.message : tx("Xato"));
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
      setErr(e instanceof Error ? e.message : tx("Xato"));
    } finally {
      setBusy("");
    }
  }
  async function stop() {
    if (!gen) return;
    setBusy("cancel");
    try { setGen(await aiApi.cancel(gen.id)); } catch (e) { toast(e instanceof Error ? e.message : tx("Xato"), "error"); } finally { setBusy(""); }
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
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    } finally {
      setBusy("");
    }
  }
  async function saveToMedia() {
    if (!gen) return;
    setBusy("save");
    try { setGen(await aiApi.save(gen.id)); toast(tx("Mediaga saqlandi — rasmlar /uploads da qoladi")); } catch (e) { toast(e instanceof Error ? e.message : tx("Xato"), "error"); } finally { setBusy(""); }
  }

  return (
    <div className="stack ai-gen" style={{ gap: 16 }}>
      {!ready && (
        <div className="alert warn"><I.alert size={16} /><div><b>{tx("AI-servis ulanmagan.")}</b>{" "}{tx("OpenAI yoki Gemini kaliti kiritilmagan.")}{can("ai") ? <> <Link to="/ai">{tx("AI-servis → Ulanishlar")}</Link></> : tx(" Administratorga murojaat qiling.")}</div></div>
      )}

      <Steps step={step} gen={gen} />

      {step === "input" && (
        <>
          <div className="field">
            <label htmlFor="ai-desc">{tx("Rasm tavsifi")}</label>
            <textarea id="ai-desc" className="textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)}
              placeholder={tx("Masalan: kechki stadion, projektor nurlari, ikki jamoa futbolchilari to‘p uchun kurashmoqda, tribunada muxlislar…")} />
            <div className="muted small">{tx("O‘zbek yoki rus tilida yozing. Keyingi qadamda AI tavsifni kengaytiradi — siz tekshirib tasdiqlaysiz.")}</div>
          </div>
          <AssetsBlock withAssets={withAssets} setWithAssets={setWithAssets} assets={assets} setAssets={setAssets} max={max}
            onLogo={() => addAsset(logoAsset())} teams={teams} onCrest={(n, u) => addAsset(crestAsset(n, u))} onUpload={() => fileRef.current?.click()} />
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" hidden onChange={(e) => uploadAsset(e.target.files?.[0])} />
          <FormatsBlock settings={settings} enabled={enabledFormats} formats={formats} setFormats={setFormats} />
          <SettingsSummary settings={settings} provider={active?.provider} model={model} canEdit={can("ai:edit")} />
          {err && <div className="alert danger"><I.alert size={16} /><div>{err}</div></div>}
          <div className="row wrap">
            <button type="button" className="btn btn-primary" onClick={improve} disabled={!ready || improving || text.trim().length < 5 || !formats.length}>
              <I.sparkles size={16} /> {improving ? tx("Yaxshilanmoqda…") : tx("Promptni yaxshilash")}
            </button>
            <span className="muted small">{tx("Yaratishdan oldin majburiy qadam")}</span>
          </div>
        </>
      )}

      {step === "review" && improved && (
        <>
          <div className="ai-orig">
            <div className="muted small">{tx("Asl tavsif")}</div>
            <div>{text}</div>
          </div>
          <div className="field">
            <label htmlFor="ai-prompt">{tx("Yaxshilangan prompt — tahrirlash mumkin")}</label>
            <textarea id="ai-prompt" className="textarea" rows={7} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <div className="muted small">{PROVIDER_LABEL[improved.provider] || improved.provider} · {improved.model} · {(improved.ms / 1000).toFixed(1)} s</div>
          </div>
          {improved.added.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="muted small">{tx("AI qo‘shgan tafsilotlar")}</div>
              <div className="chips">{improved.added.map((a) => <span key={a} className="chip-static">+ {a}</span>)}</div>
            </div>
          )}
          <div className="muted small">
            {used.length ? tx("Assetlar: {0}", used.map((a) => a.label).join(", ")) : tx("Assetlarsiz")} · {formats.map((f) => settings.formats[f]?.label || f).join(", ")}
          </div>
          {err && <div className="alert danger"><I.alert size={16} /><div>{err}</div></div>}
          <div className="row wrap">
            <button type="button" className="btn btn-primary" onClick={generate} disabled={busy === "start" || prompt.trim().length < 5}>
              <I.check size={16} /> {busy === "start" ? tx("Yuborilmoqda…") : tx("Tasdiqlash va yaratish · {0} variant", settings.variants)}
            </button>
            <button type="button" className="btn" onClick={improve} disabled={improving}><I.refresh size={16} /> {improving ? tx("Yaxshilanmoqda…") : tx("Qayta yaxshilash")}</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setStep("input"); setImproved(null); }}>{tx("Asl tavsifga qaytish")}</button>
          </div>
        </>
      )}

      {step === "run" && gen && (
        gen.status === "running" ? <Running gen={gen} expected={settings.quality === "high" ? 90 : settings.quality === "medium" ? 50 : 25} onStop={stop} stopping={busy === "cancel"} />
        : gen.status === "error" || gen.status === "cancelled" ? (
          <>
            <div className={`alert ${gen.status === "error" ? "danger" : "warn"}`}><I.alert size={16} /><div><b>{gen.status === "error" ? tx("Rasm yaratilmadi.") : tx("Bekor qilindi.")}</b> {gen.error}</div></div>
            <div className="row wrap">
              <button type="button" className="btn btn-primary" onClick={generate} disabled={!!busy}><I.refresh size={16} />{" "}{tx("Qayta urinish")}</button>
              <button type="button" className="btn btn-ghost" onClick={() => setStep("review")}>{tx("Promptni tahrirlash")}</button>
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
  const names = [tx("Tavsif"), tx("Promptni tasdiqlash"), tx("Yaratish"), tx("Variant tanlash")];
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
        <span><b>{tx("Assetlar bilan")}</b><small>{tx("Logotip, gerblar va rasmlar modelga namuna sifatida yuboriladi — brend elementlari aniq chiqadi")}</small></span>
        <input type="checkbox" className="switch" checked={p.withAssets} onChange={(e) => p.setWithAssets(e.target.checked)} />
      </label>
      {p.withAssets && (
        <>
          <div className="asset-grid">
            {p.assets.map((a) => (
              <div key={a.key} className="asset-tile">
                <div className="asset-thumb" style={{ backgroundImage: `url("${a.thumb}")` }} />
                <span className="ellipsis" title={a.label}>{a.label}</span>
                <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={tx("{0} — olib tashlash", a.label)} onClick={() => p.setAssets(p.assets.filter((x) => x.key !== a.key))}><I.x size={14} /></button>
              </div>
            ))}
            {!p.assets.length && <div className="muted small">{tx("Asset tanlanmagan")}</div>}
          </div>
          <div className="row wrap">
            {!p.assets.some((a) => a.kind === "logo") && <button type="button" className="btn btn-sm" onClick={p.onLogo}><I.plus size={14} />{" "}{tx("Liga logotipi")}</button>}
            {crestTeams.length > 0 && (
              <select className="select input-sm" style={{ width: "auto" }} value="" onChange={(e) => { const t = crestTeams.find((x) => x.crest_url === e.target.value); if (t) p.onCrest(t.name, t.crest_url!); }} aria-label={tx("Jamoa gerbini qo‘shish")}>
                <option value="">{tx("+ Jamoa gerbi…")}</option>
                {crestTeams.map((t) => <option key={t.crest_url} value={t.crest_url}>{t.name}</option>)}
              </select>
            )}
            <button type="button" className="btn btn-sm" onClick={p.onUpload}><I.upload size={14} />{" "}{tx("Mediadan")}</button>
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
      <div className="muted small" style={{ marginBottom: 8 }}>{tx("Formatlar")}</div>
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
      {formats.length > 1 && <div className="muted small" style={{ marginTop: 6 }}>{tx("Birinchi format yaratiladi, qolganlari shu kadrdan qayta kompozitsiya qilinadi — desktop va mobil bir xil chiqadi.")}</div>}
    </div>
  );
}

function SettingsSummary({ settings, provider, model, canEdit }: { settings: AiSettings; provider?: string; model: string; canEdit: boolean }) {
  return (
    <div className="ai-summary">
      <span><b>{provider ? PROVIDER_LABEL[provider] : "—"}</b> · {model || tx("model tanlanmagan")}</span>
      <span>{tx("Sifat:")}{" "}{QUALITY_LABEL[settings.quality]}</span>
      <span>{settings.variants}{" "}{tx("variant")}</span>
      <span>{settings.file_format.toUpperCase()} {settings.compression}%</span>
      {canEdit && <Link to="/ai/settings">{tx("Sozlamalar")}</Link>}
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
          <b>{tx("Rasm yaratilmoqda…")}</b>
          <div className="muted small">{Math.round(elapsed)}{" "}{tx("s · odatda {0} s gacha. Sahifani yopsangiz ham natija «AI-servis → Tarix»da saqlanadi.", expected)}</div>
        </div>
      </div>
      <div className="progress"><i style={{ width: `${pct}%` }} /></div>
      <div className="muted small clamp-2" title={gen.prompt}>{gen.prompt}</div>
      <div><button type="button" className="btn" onClick={onStop} disabled={stopping}>{stopping ? tx("To‘xtatilmoqda…") : tx("To‘xtatish")}</button></div>
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
      <div className="row muted small"><I.check size={16} />{" "}{tx("{0} variant ·", variants.length)}{" "}{PROVIDER_LABEL[gen.provider] || gen.provider} · {gen.model} · {(gen.duration_ms / 1000).toFixed(0)} s</div>
      {warnings.length > 0 && <div className="alert warn"><I.alert size={16} /><div>{warnings.map((w) => <div key={w}>{w}</div>)}</div></div>}
      <div className="variant-list" role="radiogroup" aria-label={tx("Variantlar")}>
        {variants.map((v, i) => (
          <label key={i} className={`variant${variant === i ? " on" : ""}`}>
            <input type="radio" name="ai-variant" checked={variant === i} onChange={() => setVariant(i)} />
            <div className="variant-head"><b>{tx("Variant")}{" "}{i + 1}</b>{gen.applied_variant === i && gen.status === "applied" && <Badge tone="ok">{tx("Bannerda")}</Badge>}</div>
            <div className="variant-imgs">
              {order.map((f) => {
                const img = v.images[f];
                if (!img) return null;
                return (
                  <div key={f} className={`variant-img${img.height > img.width ? " tall" : ""}`} title={`${settings.formats[f]?.label || f} · ${img.width}×${img.height}`}>
                    <img src={img.url} alt={tx("Variant {0} — {1}", i + 1, settings.formats[f]?.label || f)} loading="lazy" />
                    <span>{settings.formats[f]?.label || f} · {img.width}×{img.height}</span>
                    <a className="variant-open" href={img.url} target="_blank" rel="noopener noreferrer" aria-label={tx("To‘liq o‘lchamda ochish")} onClick={(e) => e.stopPropagation()}><I.eye size={14} /></a>
                  </div>
                );
              })}
            </div>
          </label>
        ))}
      </div>
      <div className="row wrap">
        <button type="button" className="btn btn-primary" onClick={onApply} disabled={!!busy || !variants.length}><I.check size={16} /> {busy === "apply" ? tx("Qo‘llanmoqda…") : tx("Bannerga qo‘llash")}</button>
        <button type="button" className="btn" onClick={onSave} disabled={!!busy || gen.status === "saved"}>{gen.status === "saved" ? tx("Mediada saqlangan") : tx("Mediaga saqlash")}</button>
        <button type="button" className="btn btn-ghost" onClick={onRetry}><I.refresh size={16} />{" "}{tx("Qayta yaratish")}</button>
      </div>
    </div>
  );
}
