import { useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes } from "react-router";
import { ApiError } from "@/lib/api";
import { useDebounced, useLoad } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import { aiApi, PROVIDER_LABEL, QUALITY_LABEL, STATUS_LABEL, type AiGeneration, type AiSettings, type ProviderName, type ProviderView } from "@/lib/ai";
import { PageHead } from "@/components/Layout";
import { Badge, Empty, ErrorBox, Field, Loading, Pager, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

/** AI-servis: connections (OpenAI, Gemini), shared generation settings, history. */
export function AiPage() {
  return (
    <>
      <PageHead title="AI-servis" sub="OpenAI va Google Gemini ulanishlari · rasm generatsiyasi sozlamalari · tarix" />
      <nav className="tabs" aria-label="AI-servis bo‘limlari">
        <NavLink to="/ai" end className={({ isActive }) => `tab-link${isActive ? " on" : ""}`}>Ulanishlar</NavLink>
        <NavLink to="/ai/settings" className={({ isActive }) => `tab-link${isActive ? " on" : ""}`}>Rasm generatsiyasi</NavLink>
        <NavLink to="/ai/history" className={({ isActive }) => `tab-link${isActive ? " on" : ""}`}>Tarix</NavLink>
      </nav>
      <Routes>
        <Route index element={<Connections />} />
        <Route path="settings" element={<SettingsTab />} />
        <Route path="history" element={<History />} />
      </Routes>
    </>
  );
}

export function StatusPill({ status }: { status: ProviderView["status"] | "connected-off" }) {
  if (status === "ok") return <Badge tone="ok">Ulangan</Badge>;
  if (status === "error") return <Badge tone="danger">Xato</Badge>;
  if (status === "unknown") return <Badge tone="warn">Tekshirilmagan</Badge>;
  return <Badge>Ulanmagan</Badge>;
}

/* ---------- Connections ---------- */
function Connections() {
  const prov = useLoad(() => aiApi.providers(), []);
  const st = useLoad(() => aiApi.settings(), []);
  const toast = useToast();
  if (prov.error) return <ErrorBox error={prov.error} retry={prov.reload} />;
  if (!prov.data || !st.data) return <Loading />;
  const list = prov.data;
  const settings = st.data;
  const connected = (p: string) => list.some((x) => x.provider === p && x.connected);
  async function saveSettings(patch: Partial<AiSettings>) {
    try {
      st.setData(await aiApi.saveSettings({ ...settings, ...patch }));
      toast("Saqlandi");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }
  const update = (v: ProviderView) => prov.setData(list.map((x) => (x.provider === v.provider ? v : x)));
  return (
    <div className="edit-layout">
      <div className="stack" style={{ gap: 24 }}>
        {list.map((p) => <ProviderCard key={p.provider} view={p} onChange={update} onRemoved={prov.reload} />)}
      </div>
      <aside className="stack" style={{ gap: 24 }}>
        <div className="card">
          <div className="card-head"><h3>Umumiy</h3></div>
          <div className="card-pad stack" style={{ gap: 16 }}>
            <Field label="Standart provayder" hint={!connected("gemini") || !connected("openai") ? "Faqat ulangan provayderni tanlash mumkin" : undefined}>
              <div className="seg seg-wide">
                {(["openai", "gemini"] as ProviderName[]).map((p) => (
                  <button key={p} type="button" aria-pressed={settings.provider === p} disabled={!connected(p)} onClick={() => saveSettings({ provider: p })}>{p === "openai" ? "OpenAI" : "Gemini"}</button>
                ))}
              </div>
            </Field>
            <label className="toggle-row">
              <span><b>Zaxira provayder</b><small>Xato bo‘lsa boshqa ulangan provayderga avtomatik o‘tish</small></span>
              <input type="checkbox" className="switch" checked={settings.fallback} onChange={(e) => saveSettings({ fallback: e.target.checked })} />
            </label>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Xavfsizlik</h3></div>
          <div className="card-pad row" style={{ alignItems: "flex-start" }}>
            <I.lock size={18} />
            <p className="muted" style={{ margin: 0 }}>Kalitlar faqat serverda (AI-servis) shifrlangan holda saqlanadi va brauzerga qaytarilmaydi. Rasm yaratish barcha admin foydalanuvchilari uchun ochiq, limit yo‘q.</p>
          </div>
        </div>
      </aside>
    </div>
  );
}

function ProviderCard({ view, onChange, onRemoved }: { view: ProviderView; onChange: (v: ProviderView) => void; onRemoved: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editKey, setEditKey] = useState(!view.connected);
  const [key, setKey] = useState("");
  const [org, setOrg] = useState(view.org_id);
  const [base, setBase] = useState(view.base_url);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<Record<string, string>>({});
  const isOpenAI = view.provider === "openai";
  useEffect(() => { setOrg(view.org_id); setBase(view.base_url); setEditKey(!view.connected); }, [view.connected, view.org_id, view.base_url]);

  async function save() {
    setBusy("save");
    setErr({});
    try {
      const v = await aiApi.saveProvider(view.provider, { api_key: key.trim(), org_id: isOpenAI ? org : "", base_url: base });
      onChange(v);
      setKey("");
      toast(v.status === "ok" ? "Ulandi" : "Kalit saqlandi, lekin tekshiruvdan o‘tmadi", v.status === "ok" ? "ok" : "error");
    } catch (e) {
      if (e instanceof ApiError) setErr(e.fields);
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy("");
    }
  }
  async function test() {
    setBusy("test");
    try {
      const v = await aiApi.testProvider(view.provider);
      onChange(v);
      toast(v.status === "ok" ? "Ulanish ishlayapti" : v.last_error, v.status === "ok" ? "ok" : "error");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy("");
    }
  }
  async function remove() {
    if (!(await confirm({ title: `${PROVIDER_LABEL[view.provider]} ulanishini uzish`, text: "API kalit o‘chiriladi. Generatsiya bu provayder orqali ishlamaydi.", ok: "Uzish", danger: true }))) return;
    try {
      await aiApi.deleteProvider(view.provider);
      toast("Uzildi");
      onRemoved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }
  return (
    <div className="card">
      <div className="card-head">
        <div className="row"><span className={`prov-mark ${view.provider}`}>{isOpenAI ? "OA" : "G"}</span><h3>{PROVIDER_LABEL[view.provider]}</h3></div>
        <StatusPill status={view.connected ? view.status : "off"} />
      </div>
      <div className="card-pad stack" style={{ gap: 16 }}>
        {view.connected && !editKey ? (
          <Field label="API kalit">
            <div className="row">
              <input className="input grow" value={view.key_mask} readOnly aria-label="API kalit" />
              <button type="button" className="btn" onClick={() => setEditKey(true)}>Kalitni almashtirish</button>
            </div>
          </Field>
        ) : (
          <Field label={isOpenAI ? "API kalit" : "API kalit (Google AI Studio)"} error={err.api_key}
            hint={isOpenAI ? "platform.openai.com → API keys" : "aistudio.google.com → «Get API key»"}>
            <input className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={isOpenAI ? "sk-proj-…" : "AIza…"} />
          </Field>
        )}
        <div className="form-grid">
          {isOpenAI && (
            <Field label="Organization ID (ixtiyoriy)"><input className="input" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="org-…" /></Field>
          )}
          <Field label="Base URL (ixtiyoriy)" error={err.base_url} hint="Proksi orqali ulanish uchun" full={!isOpenAI}>
            <input className="input" value={base} onChange={(e) => setBase(e.target.value)} placeholder={isOpenAI ? "https://api.openai.com/v1" : "https://generativelanguage.googleapis.com"} />
          </Field>
        </div>
        {view.connected && (
          <div className={`row small ${view.status === "error" ? "danger-text" : "muted"}`} style={{ alignItems: "flex-start" }}>
            {view.status === "ok" ? <I.check size={16} /> : <I.alert size={16} />}
            <span>
              {view.checked_at ? `Oxirgi tekshiruv: ${fmtDateTime(view.checked_at)} · javob ${view.latency_ms} ms` : "Hali tekshirilmagan"}
              {view.status === "ok" && ` · ${view.image_models.length} ta rasm modeli, ${view.text_models.length} ta matn modeli`}
              {view.status === "error" && view.last_error && <><br />{view.last_error}</>}
            </span>
          </div>
        )}
        {view.image_models.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="muted small">Rasm modellari — rasm yaratish uchun</div>
            <div className="chips">{view.image_models.slice(0, 8).map((m) => <span key={m} className="tag">{m}</span>)}</div>
          </div>
        )}
        {view.text_models.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="muted small">Matn modellari — «Promptni yaxshilash» uchun</div>
            <div className="chips">{view.text_models.slice(0, 8).map((m) => <span key={m} className="tag">{m}</span>)}{view.text_models.length > 8 && <span className="tag">+{view.text_models.length - 8}</span>}</div>
          </div>
        )}
        <div className="row wrap">
          {view.connected && <button type="button" className="btn" onClick={test} disabled={!!busy}><I.refresh size={16} /> {busy === "test" ? "Tekshirilmoqda…" : "Ulanishni tekshirish"}</button>}
          {(editKey || !view.connected || org !== view.org_id || base !== view.base_url) && (
            <button type="button" className="btn btn-primary" onClick={save} disabled={!!busy || (!view.connected && key.trim().length < 10)}>
              {busy === "save" ? "Tekshirilmoqda…" : view.connected ? "Saqlash" : "Saqlash va tekshirish"}
            </button>
          )}
          {editKey && view.connected && <button type="button" className="btn btn-ghost" onClick={() => { setEditKey(false); setKey(""); }}>Bekor qilish</button>}
          <div className="grow" />
          {view.connected && <button type="button" className="btn btn-ghost danger-text" onClick={remove}>Uzish</button>}
        </div>
      </div>
    </div>
  );
}

/* ---------- Generation settings ---------- */
const MODEL_HINT: Record<string, string> = {
  "gpt-image-2.5-sunburst": "Eng yuqori sifat va assetlar bilan aniq tahrir — bannerlar uchun tavsiya",
  "gpt-image-2.5-flare": "Tezkor va arzonroq — qoralama variantlar uchun",
  "gpt-image-2": "Oldingi avlod",
  "gemini-3-pro-image": "Nano Banana Pro — studiya sifati, 14 tagacha namuna rasm",
  "gemini-3.1-flash-image": "Nano Banana 2 — tez va sifatli",
  "gemini-3.1-flash-lite-image": "Nano Banana 2 Lite — eng arzon",
};

function SettingsTab() {
  const prov = useLoad(() => aiApi.providers(), []);
  const st = useLoad(() => aiApi.settings(), []);
  const [s, setS] = useState<AiSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const toast = useToast();
  useEffect(() => { if (st.data) setS(st.data); }, [st.data]);
  const dirty = useMemo(() => !!s && !!st.data && JSON.stringify(s) !== JSON.stringify(st.data), [s, st.data]);
  if (st.error) return <ErrorBox error={st.error} retry={st.reload} />;
  if (!s || !prov.data) return <Loading />;
  const set = (patch: Partial<AiSettings>) => setS({ ...s, ...patch });
  const pv = prov.data.find((p) => p.provider === s.provider);
  const connected = (p: string) => prov.data!.some((x) => x.provider === p && x.connected);
  const imageModels = Array.from(new Set([...(pv?.image_models || []), s.image_model[s.provider]].filter(Boolean)));
  const textModels = Array.from(new Set([...(pv?.text_models || []), s.text_model[s.provider]].filter(Boolean)));
  async function save() {
    setBusy(true);
    setErr({});
    try {
      const out = await aiApi.saveSettings(s!);
      st.setData(out);
      setS(out);
      toast("Sozlamalar saqlandi");
    } catch (e) {
      if (e instanceof ApiError) setErr(e.fields);
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  const setFormat = (k: string, patch: Partial<AiSettings["formats"][string]>) => set({ formats: { ...s.formats, [k]: { ...s.formats[k], ...patch } } });
  return (
    <>
      <div className="sticky-actions">
        <span className="muted small">{dirty ? "Saqlanmagan o‘zgarishlar bor" : "Sozlamalar barcha bo‘limlar uchun umumiy"}</span>
        <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? "Saqlanmoqda…" : "Saqlash"}</button>
      </div>
      <div className="edit-layout">
        <div className="stack" style={{ gap: 24 }}>
          <div className="card">
            <div className="card-head"><h3>Model</h3></div>
            <div className="card-pad stack" style={{ gap: 16 }}>
              <Field label="Provayder" hint="Ulanmagan provayder — AI-servis → Ulanishlar bo‘limida ulanadi">
                <div className="seg seg-wide">
                  {(["openai", "gemini"] as ProviderName[]).map((p) => (
                    <button key={p} type="button" aria-pressed={s.provider === p} disabled={!connected(p)} onClick={() => set({ provider: p })}>{p === "openai" ? "OpenAI" : "Gemini"}</button>
                  ))}
                </div>
              </Field>
              <div className="radio-list" role="radiogroup" aria-label="Rasm modeli">
                {imageModels.map((m) => (
                  <label key={m} className={`radio-card${s.image_model[s.provider] === m ? " on" : ""}`}>
                    <input type="radio" name="image-model" checked={s.image_model[s.provider] === m} onChange={() => set({ image_model: { ...s.image_model, [s.provider]: m } })} />
                    <span><b>{m}</b>{MODEL_HINT[m] && <small>{MODEL_HINT[m]}</small>}</span>
                  </label>
                ))}
                {!imageModels.length && <p className="muted small" style={{ margin: 0 }}>Modellar ro‘yxati ulanishni tekshirgandan keyin chiqadi.</p>}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>O‘lchamlar (formatlar)</h3></div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Joy</th><th>Kenglik</th><th>Balandlik</th><th className="hide-mobile">Nisbat</th><th>Faol</th></tr></thead>
              <tbody>
                {s.format_order.filter((k) => s.formats[k]).map((k) => {
                  const f = s.formats[k];
                  return (
                    <tr key={k}>
                      <td><b>{f.label}</b>{err[`formats.${k}`] && <div className="danger-text small">{err[`formats.${k}`]}</div>}</td>
                      <td><input className="input input-sm" style={{ width: 96 }} type="number" value={f.w} onChange={(e) => setFormat(k, { w: Number(e.target.value) })} aria-label={`${f.label} kenglik`} /></td>
                      <td><input className="input input-sm" style={{ width: 96 }} type="number" value={f.h} onChange={(e) => setFormat(k, { h: Number(e.target.value) })} aria-label={`${f.label} balandlik`} /></td>
                      <td className="hide-mobile muted">{ratio(f.w, f.h)}</td>
                      <td><input type="checkbox" className="switch" checked={f.enabled} onChange={(e) => setFormat(k, { enabled: e.target.checked })} aria-label={`${f.label} faol`} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
            <div className="card-foot muted small">OpenAI aniq o‘lchamda yaratadi; Gemini eng yaqin nisbatda yaratadi, server rasmni kerakli o‘lchamga kesadi.</div>
          </div>

          <div className="card">
            <div className="card-head"><h3>Sifat va fayl</h3></div>
            <div className="card-pad form-grid">
              <Field label="Sifat" hint={s.provider === "openai" ? `OpenAI: quality = ${s.quality}` : `Gemini: ${s.quality === "low" ? "1K" : s.quality === "medium" ? "2K" : "4K"}`}>
                <div className="seg seg-wide">{(["low", "medium", "high"] as const).map((q) => <button key={q} type="button" aria-pressed={s.quality === q} onClick={() => set({ quality: q })}>{QUALITY_LABEL[q]}</button>)}</div>
              </Field>
              <Field label="Variantlar soni (bir so‘rovda)" error={err.variants}>
                <div className="seg seg-wide">{[1, 2, 3, 4].map((n) => <button key={n} type="button" aria-pressed={s.variants === n} onClick={() => set({ variants: n })}>{n}</button>)}</div>
              </Field>
              <Field label="Fayl formati" hint="WebP serverda cwebp bo‘lsa; bo‘lmasa JPEG">
                <select className="select" value={s.file_format} onChange={(e) => set({ file_format: e.target.value as AiSettings["file_format"] })}>
                  <option value="webp">WEBP</option><option value="jpeg">JPEG</option><option value="png">PNG</option>
                </select>
              </Field>
              <Field label="Siqish (sifat %)" error={err.compression}>
                <input className="input" type="number" min={40} max={100} value={s.compression} onChange={(e) => set({ compression: Number(e.target.value) })} />
              </Field>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>Uslub va prompt shabloni</h3></div>
            <div className="card-pad stack" style={{ gap: 16 }}>
              <Field label="Brend uslubi — har bir so‘rov boshiga qo‘shiladi" error={err.style}>
                <textarea className="textarea" rows={3} value={s.style} onChange={(e) => set({ style: e.target.value })} />
              </Field>
              <Field label="Taqiqlangan elementlar">
                <input className="input" value={s.forbidden} onChange={(e) => set({ forbidden: e.target.value })} />
              </Field>
              <label className="toggle-row">
                <span><b>Matn uchun joy qoldirish</b><small>Banner ko‘rinishiga qarab (Shade, Split, Panel…) kadrda bo‘sh zona qoldiriladi</small></span>
                <input type="checkbox" className="switch" checked={s.text_space} onChange={(e) => set({ text_space: e.target.checked })} />
              </label>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>Promptni yaxshilash</h3><span className="muted small">Generatsiyadan oldin majburiy</span></div>
            <div className="card-pad stack" style={{ gap: 16 }}>
              <div className="form-grid">
                <Field label="Matn modeli" hint="Ro‘yxat ulangan provayderdan olinadi; yangi modellar «Ulanishni tekshirish»dan keyin chiqadi">
                  <select className="select" value={s.text_model[s.provider] || ""} onChange={(e) => set({ text_model: { ...s.text_model, [s.provider]: e.target.value } })}>
                    {textModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </Field>
                <Field label="Til">
                  <select className="select" value={s.improve_language} onChange={(e) => set({ improve_language: e.target.value as AiSettings["improve_language"] })}>
                    <option value="user">Foydalanuvchi tilida</option><option value="en">Ingliz tilida (modelga aniqroq)</option>
                  </select>
                </Field>
              </div>
              <Field label="Ko‘rsatma (system prompt)" error={err.improve_instruction}>
                <textarea className="textarea" rows={4} value={s.improve_instruction} onChange={(e) => set({ improve_instruction: e.target.value })} />
              </Field>
              <div className="row muted small" style={{ alignItems: "flex-start" }}><I.lock size={16} /> Foydalanuvchi yaxshilangan promptni ko‘rib, tahrirlab tasdiqlaydi — shundan keyingina rasm yaratiladi.</div>
            </div>
          </div>
        </div>

        <aside className="stack" style={{ gap: 24 }}>
          <div className="card">
            <div className="card-head"><h3>Assetlar</h3></div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              <p className="muted small" style={{ margin: 0 }}>«Assetlar bilan» yoqilganda banner sahifasida oldindan tanlanadi va modelga namuna sifatida yuboriladi.</p>
              {[["logo", "Liga logotipi", "Doimo"], ["crests", "Jamoa gerblari", "Banner sarlavhasidagi jamoalar"]].map(([k, l, sub]) => (
                <label key={k} className="toggle-row">
                  <span><b>{l}</b><small>{sub}</small></span>
                  <input type="checkbox" className="switch" checked={!!s.default_assets[k]} onChange={(e) => set({ default_assets: { ...s.default_assets, [k]: e.target.checked } })} />
                </label>
              ))}
              <Field label="Bir so‘rovda maks. asset" error={err.max_assets} hint="OpenAI — 16 tagacha, Gemini — 14 tagacha">
                <input className="input" type="number" min={0} max={14} value={s.max_assets} onChange={(e) => set({ max_assets: Number(e.target.value) })} />
              </Field>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Xavfsizlik</h3></div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              <Field label="Moderatsiya (OpenAI)">
                <select className="select" value={s.moderation} onChange={(e) => set({ moderation: e.target.value as AiSettings["moderation"] })}>
                  <option value="auto">auto — standart</option><option value="low">low — yumshoqroq</option>
                </select>
              </Field>
              <Field label="Odamlar tasviri (Gemini)">
                <select className="select" value={s.people} onChange={(e) => set({ people: e.target.value as AiSettings["people"] })}>
                  <option value="ALLOW_ADULT">Faqat kattalar</option><option value="ALLOW_ALL">Hammasi</option><option value="DONT_ALLOW">Odamlarsiz</option>
                </select>
              </Field>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

function ratio(w: number, h: number) {
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(w, h) || 1;
  return `${w / d}:${h / d}`;
}

/* ---------- History ---------- */
export function GenStatus({ g }: { g: Pick<AiGeneration, "status" | "error"> }) {
  const tone = g.status === "applied" ? "ok" : g.status === "error" ? "danger" : g.status === "running" ? "info" : g.status === "done" || g.status === "saved" ? "warn" : "";
  return <span title={g.error || undefined}><Badge tone={tone}>{STATUS_LABEL[g.status]}</Badge></span>;
}

function History() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => setPage(1), [dq, provider, status]);
  const qs = new URLSearchParams({ limit: "20", page: String(page), ...(dq ? { q: dq } : {}), ...(provider ? { provider } : {}), ...(status ? { status } : {}) }).toString();
  const { data, error, loading, reload } = useLoad(() => import("@/lib/api").then(({ api }) => api.get<{ items: AiGeneration[]; total: number; month: { total: number; errors: number } }>(`/admin/ai/generations?${qs}`)), [qs]);
  return (
    <div className="card">
      <div className="toolbar">
        <div className="search grow" style={{ maxWidth: 360 }}>
          <I.search size={16} />
          <input className="input" placeholder="Prompt bo‘yicha qidirish…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Qidirish" />
        </div>
        <select className="select" style={{ width: "auto" }} value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provayder">
          <option value="">Provayder: barchasi</option><option value="openai">OpenAI</option><option value="gemini">Gemini</option>
        </select>
        <select className="select" style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Holat">
          <option value="">Holat: barchasi</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : !data?.items.length ? <Empty title="Hali generatsiya yo‘q" text="Rasm banner sahifasida «AI bilan yaratish» orqali yaratiladi." /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Rasm</th><th>Prompt</th><th>Model</th><th className="hide-mobile">O‘lcham</th><th className="hide-mobile">Assetlar</th><th>Kim · qachon</th><th>Holat</th></tr></thead>
          <tbody>
            {data.items.map((g) => {
              const v = g.variants[g.applied_variant ?? 0];
              const img = v ? v.images[g.formats[0]] || Object.values(v.images)[0] : undefined;
              return (
                <tr key={g.id}>
                  <td><div className="img-preview wide" style={{ width: 96, height: 44, ...(img ? { backgroundImage: `url("${img.url}")` } : {}) }}>{!img && "—"}</div></td>
                  <td><span className="clamp-2" title={g.prompt}>{g.prompt_original || g.prompt}</span></td>
                  <td><div>{g.model || "—"}</div><div className="muted small">{g.provider ? PROVIDER_LABEL[g.provider] : ""}</div></td>
                  <td className="hide-mobile nowrap">{img ? `${img.width} × ${img.height}` : "—"}</td>
                  <td className="hide-mobile">{g.assets.length ? `${g.assets.length} ta` : "—"}</td>
                  <td><div>{g.user_name}</div><div className="muted small nowrap">{fmtDateTime(g.created_at)}</div></td>
                  <td><GenStatus g={g} /></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      {data && (
        <div className="row" style={{ justifyContent: "space-between", padding: "10px 16px", borderTop: "1px solid var(--border)" }}>
          <span className="muted small">Shu oy: {data.month.total} ta rasm so‘rovi · xato {data.month.errors}</span>
        </div>
      )}
      {data && <Pager page={page} total={data.total} limit={20} onPage={setPage} />}
    </div>
  );
}
