import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { fmtDate, fmtShort } from "@/lib/format";
import { errText, SELLER_URL, type WBImportItem, type WBState } from "@/lib/wb";
import { PageHead } from "@/components/Layout";
import { ErrorBox, Field, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { ImportModal, WBBanners, WBLogCard } from "./Merch";

import { tx } from "@/lib/i18n";
/* Tizim → Wildberries (W3): token, sync rules, import, store details. */

const SCOPES: [string, string, string, boolean][] = [
  ["content", tx("Kontent"), tx("kartochka, rasm, xususiyatlar, shtrix-kod"), true],
  ["prices", tx("Narxlar va chegirmalar"), tx("narx va chegirmani yuborish"), true],
  ["analytics", tx("Analitika"), tx("WB omboridagi (FBO) qoldiq"), false],
];

export function WildberriesPage() {
  const { data, error, loading, reload, setData } = useLoad(() => api.get<WBState>("/admin/wb"), []);
  if (error) return <><PageHead title="Wildberries" /><div className="card card-pad"><ErrorBox error={error} retry={reload} /></div></>;
  if (loading && !data) return <><PageHead title="Wildberries" /><Loading /></>;
  if (!data) return null;
  return <Settings s={data} set={setData} />;
}

function Settings({ s, set }: { s: WBState; set: (v: WBState) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [importOpen, setImportOpen] = useState(false);
  async function patch(b: Partial<WBState>, msg = tx("Saqlandi")) {
    try { set(await api.patch<WBState>("/admin/wb", b)); toast(msg); } catch (e) { toast(errText(e), "error"); }
  }
  async function disconnect() {
    if (!(await confirm({ title: tx("Ulanishni o‘chirish"), text: tx("Token o‘chiriladi. WB’dagi kartochkalar qoladi, saytdagi mahsulotlarda «Wildberries’da sotib olish» tugmasi yashirinadi."), ok: tx("O‘chirish"), danger: true }))) return;
    try { set(await api.del<WBState>("/admin/wb/token")); toast(tx("Uzildi")); } catch (e) { toast(errText(e), "error"); }
  }
  return (
    <>
      <PageHead title="Wildberries" sub={tx("Do‘kon ulanishi, API token va sinxronlash qoidalari")} actions={<>
        <a className="btn" href={SELLER_URL} target="_blank" rel="noreferrer"><I.link size={16} />{" "}{tx("WB kabinetini ochish")}</a>
        {s.connected && <Link className="btn btn-primary" to="/products">{tx("Merch’ga o‘tish")}</Link>}
      </>} />
      <WBBanners s={s} />
      <div className="stk-cols">
        <div className="stack">
          <TokenCard s={s} set={set} />
          {s.connected && (
            <div className="card">
              <div className="card-head"><h2>{tx("Sinxronlash")}</h2></div>
              <div className="card-pad stack" style={{ gap: 14 }}>
                <label className="toggle-row"><span><b>{tx("Saqlashda WB’ga avtomatik yuborish")}</b><small>{tx("«WB’da sotish» yoqilgan mahsulot saqlanganda kartochka, rasmlar va narx navbatga tushadi")}</small></span><input type="checkbox" className="switch lime" checked={s.auto_push} onChange={(e) => patch({ auto_push: e.target.checked })} /></label>
                <label className="toggle-row"><span><b>{tx("Narx va qoldiqni WB’dan olish")}</b><small>{tx("Har 30 daqiqada: saytda narx va o‘lchamlar mavjudligi yangilanadi")}</small></span><input type="checkbox" className="switch lime" checked={s.pull_stocks} onChange={(e) => patch({ pull_stocks: e.target.checked })} /></label>
                <label className="toggle-row"><span><b>{tx("Qoldiq 0 bo‘lsa saytda «Vaqtincha tugagan»")}</b><small>{tx("Barcha o‘lchamlar tugaganda holat avtomatik o‘zgaradi, qoldiq qaytsa — yana «Sotuvda»")}</small></span><input type="checkbox" className="switch lime" checked={s.auto_out_of_stock} onChange={(e) => patch({ auto_out_of_stock: e.target.checked })} /></label>
                <div className="form-grid">
                  <Field label={tx("Saytdagi havola")} hint={tx("«Wildberries’da sotib olish» tugmasi shu domenga olib boradi")}>
                    <select className="select" value={s.link_domain} onChange={(e) => patch({ link_domain: e.target.value })}>
                      {["wildberries.uz", "wildberries.ru", "wildberries.kz"].map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </Field>
                  <Field label={tx("Ishlash sxemasi")} hint={tx("Qoldiq WB omboridan olinadi")}><input className="input" value="FBO — WB ombori" disabled /></Field>
                </div>
              </div>
            </div>
          )}
          {s.connected && (
            <ImportCard onOpen={() => setImportOpen(true)} />
          )}
        </div>
        <aside className="stack">
          {s.connected && (
            <div className="card">
              <div className="card-head"><h2>{tx("Do‘kon")}</h2><span className="row small b" style={{ gap: 6 }}><i className={`stk-dot ${s.problem ? "error" : "ready"}`} />{s.problem ? tx("Muammo bor") : tx("Faol")}</span></div>
              <div className="stk-kv">
                <div><span>{tx("Sotuvchi")}</span><b>{s.seller.name || "—"}</b></div>
                <div><span>{tx("Brend / do‘kon nomi")}</span><b>{s.seller.trademark || "—"}</b></div>
                <div><span>{tx("Mamlakat")}</span><b>{s.seller.country || "—"}</b></div>
                <div><span>{tx("Valyuta")}</span><b>{s.currency || tx("birinchi sinxronlashda")}</b></div>
                <div><span>{tx("Oxirgi yuborish")}</span><b>{fmtShort(s.last_sync_at)}</b></div>
                <div><span>{tx("Oxirgi sinxronlash")}</span><b>{fmtShort(s.last_pull_at)}</b></div>
              </div>
              <a className="stk-link" href={`${SELLER_URL}/supplier-settings/supplier-card`} target="_blank" rel="noreferrer"><span className="grow">{tx("seller.wildberries.ru/supplier-settings/supplier-card")}</span><I.link size={16} /></a>
            </div>
          )}
          <HowTo />
          {s.connected && <WBLogCard log={s.log} />}
          {s.connected && (
            <div className="card card-pad stack" style={{ gap: 8 }}>
              <b>{tx("Ulanishni o‘chirish")}</b>
              <span className="muted small">{tx("Token o‘chiriladi. WB’dagi kartochkalar qoladi, saytdagi mahsulotlarda WB tugmasi yashirinadi.")}</span>
              <button className="btn" style={{ alignSelf: "flex-start" }} onClick={disconnect}>{tx("O‘chirish")}</button>
            </div>
          )}
        </aside>
      </div>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); api.get<WBState>("/admin/wb").then(set).catch(() => {}); }} />}
    </>
  );
}

function TokenCard({ s, set }: { s: WBState; set: (v: WBState) => void }) {
  const toast = useToast();
  const [token, setToken] = useState("");
  const [open, setOpen] = useState(!s.connected || s.problem === "token_invalid" || s.token_broken);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { if (!s.connected) setOpen(true); }, [s.connected]);
  async function save() {
    setBusy(true); setErr("");
    try { set(await api.put<WBState>("/admin/wb/token", { token })); setToken(""); setOpen(false); toast(tx("Wildberries ulandi")); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  const ok = s.connected && !s.problem;
  const expSoon = s.expires_at && new Date(s.expires_at).getTime() - Date.now() < 14 * 864e5;
  return (
    <div className="card">
      <div className="card-head"><h2>{tx("API token")}</h2><span className="row small b" style={{ gap: 6 }}><i className={`stk-dot ${!s.connected ? "waiting" : ok ? "ready" : "error"}`} />{!s.connected ? tx("Ulanmagan") : ok ? tx("Ulangan") : tx("Muammo bor")}</span></div>
      <div className="card-pad stack" style={{ gap: 14 }}>
        {s.connected && !open && (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="mono small">{s.token_masked}</span>
            <button className="btn btn-sm" onClick={() => setOpen(true)}><I.edit size={15} />{" "}{tx("Tokenni almashtirish")}</button>
          </div>
        )}
        {open && (
          <>
            <Field label={tx("Token")} error={err} hint={tx("AES-GCM bilan shifrlanib saqlanadi, brauzerga qaytarilmaydi")}>
              <input className="input mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJhbGciOi…" autoComplete="off" aria-invalid={!!err || undefined} />
            </Field>
            <div className="row">
              <button className="btn btn-dark" disabled={busy || token.trim().length < 20} onClick={save}>{busy ? tx("Tekshirilmoqda…") : tx("Tekshirish va saqlash")}</button>
              {s.connected && <button className="btn btn-ghost" onClick={() => { setOpen(false); setErr(""); }}>{tx("Bekor qilish")}</button>}
            </div>
          </>
        )}
        <div className="wb-scopes">
          <div className="wb-scopes-head"><span>{tx("TOKEN RUXSATLARI")}</span>{s.expires_at && <span className={expSoon ? "danger-text" : ""}>{tx("Muddati: {0} gacha", fmtDate(s.expires_at))}</span>}</div>
          {SCOPES.map(([k, name, what, req]) => {
            const has = s.scopes.includes(k);
            return (
              <div key={k} className={has ? "" : "off"}>
                {has ? <I.check size={16} /> : <I.x size={16} />}
                <b>{name}</b><span className="grow muted small">{what}{req ? tx(" · majburiy") : ""}</span>
                <span className={`small b ${has ? "ok-text" : "muted"}`}>{!s.connected ? "—" : has ? tx("Bor") : tx("Yo‘q")}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ImportCard({ onOpen }: { onOpen: () => void }) {
  const { data, error } = useLoad(() => api.get<{ total: number; items: WBImportItem[] }>("/admin/wb/import"), []);
  return (
    <div className="card">
      <div className="card-head"><h2>{tx("WB kabinetidan import")}</h2>{data && <span className="muted small">{data.total}{" "}{tx("kartochka · {0} tasi saytda yo‘q", data.items.length)}</span>}</div>
      <div className="card-pad stack" style={{ gap: 12 }}>
        <span className="muted small">{tx("WB kabinetida yaratilgan kartochkalar saytga mahsulot sifatida qo‘shiladi: nom, rasmlar, xususiyatlar, o‘lchamlar va narx. Artikul (vendorCode) bo‘yicha moslanadi — saytda bor mahsulotlar qayta yaratilmaydi.")}</span>
        {error ? <span className="danger-text small">{errText(error)}</span> : null}
        <button className="btn" style={{ alignSelf: "flex-start" }} disabled={!data?.items.length} onClick={onOpen}><I.download size={16} /> {data ? tx("Import qilish ({0})", data.items.length) : tx("Yuklanmoqda…")}</button>
      </div>
    </div>
  );
}

function HowTo() {
  const steps = [
    tx("seller.wildberries.ru → profil → «Настройки» → «Доступ к API»"),
    tx("«Создать токен», nomi: «United MFL sayt»"),
    tx("Kategoriyalar: Контент, Цены и скидки, Аналитика"),
    tx("«Только чтение» belgisini qo‘ymang"),
    tx("Tokenni nusxalab shu yerga qo‘ying → «Tekshirish va saqlash»"),
  ];
  return (
    <div className="card">
      <div className="card-head"><h2>{tx("Token qanday olinadi")}</h2></div>
      <div className="card-pad wb-steps">
        {steps.map((t, i) => <div key={i}><span className={i === steps.length - 1 ? "on" : ""}>{i + 1}</span><p>{t}</p></div>)}
      </div>
    </div>
  );
}
