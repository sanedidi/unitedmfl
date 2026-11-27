"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Clock, Info, Lock, Minus, Plus, Shield } from "./ui";
import { StadiumMap, zoneTint } from "./StadiumMap";
import { PROVIDERS, TicketApiError, fmtSum, tapi, type PublicSale, type ZoneOffer } from "@/lib/tickets";
import { fmtDate, fmtTime } from "@/lib/format";

export function Steps({ step }: { step: 1 | 2 | 3 }) {
  const items = ["Chipta tanlash", "Ma’lumotlar va to‘lov", "Chiptalar"];
  return (
    <ol className="tk-steps" aria-label="Bosqichlar">
      {items.map((t, i) => (
        <li key={t} className={i + 1 < step ? "done" : i + 1 === step ? "on" : ""} aria-current={i + 1 === step ? "step" : undefined}>
          <i>{i + 1 < step ? <Check size={14} /> : i + 1}</i><span>{t}</span>
        </li>
      ))}
    </ol>
  );
}

const ZONE_SUB = (z: ZoneOffer) => z.subtitle || `${(z.sections || []).join(", ")} ${(z.sections || []).length > 1 ? "sektorlar" : "sektor"} · ${z.mode === "free" ? "erkin o‘rindiq" : "raqamlangan o‘rindiq"}`;

export function Checkout({ matchId, onStep }: { matchId: number; onStep?: (s: 1 | 2) => void }) {
  const router = useRouter();
  const [sale, setSale] = useState<PublicSale | null>(null);
  const [err, setErr] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+998 ");
  const [email, setEmail] = useState("");
  const [telegram, setTelegram] = useState(true);
  const [holders, setHolders] = useState<Record<string, string[]>>({});
  const [selfHolder, setSelfHolder] = useState(true);
  const [provider, setProvider] = useState("");
  const [agree, setAgree] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = () => tapi<PublicSale>("GET", `/matches/${matchId}/tickets`).then((s) => { setSale(s); setProvider((p) => p || s.providers[0] || ""); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [matchId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onStep?.(step); window.scrollTo({ top: 0, behavior: "smooth" }); }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const zones = sale?.zones || [];
  const count = Object.values(qty).reduce((a, b) => a + b, 0);
  const max = sale?.max_per_order || 10;
  const fee = (sale?.service_fee || 0) * count;
  const total = zones.reduce((n, z) => n + (qty[z.zone_key] || 0) * z.price, 0) + fee;
  const selected = useMemo(() => new Set(Object.entries(qty).filter(([, q]) => q > 0).map(([k]) => k)), [qty]);
  const named = zones.filter((z) => z.named && (qty[z.zone_key] || 0) > 0);
  const set = (z: ZoneOffer, n: number) => setQty((q) => {
    const others = count - (q[z.zone_key] || 0);
    return { ...q, [z.zone_key]: Math.max(0, Math.min(n, z.left, max - others)) };
  });

  if (err) return <div className="tk-alert danger">{err}</div>;
  if (!sale) return <div className="tk-skel" aria-busy="true">Yuklanmoqda…</div>;
  if (sale.status !== "open") return <Closed sale={sale} />;

  const pay = async () => {
    setFields({});
    const f: Record<string, string> = {};
    if (name.trim().length < 3) f.buyer_name = "Ism familiyani kiriting";
    if (phone.replace(/\D/g, "").length !== 12) f.phone = "Telefon: +998 XX XXX XX XX";
    if (!agree) f.agree = "Oferta shartlariga rozilik kerak";
    if (!provider) f.provider = "To‘lov usulini tanlang";
    named.forEach((z) => {
      const list = holders[z.zone_key] || [];
      for (let i = 0; i < (qty[z.zone_key] || 0); i++) {
        const v = i === 0 && selfHolder ? name : list[i] || "";
        if (v.trim().length < 3) f[`h_${z.zone_key}_${i}`] = "Ism familiya";
      }
    });
    if (Object.keys(f).length) { setFields(f); return; }
    setBusy(true);
    try {
      const items = zones.filter((z) => (qty[z.zone_key] || 0) > 0).map((z) => ({
        zone: z.zone_key, qty: qty[z.zone_key],
        ...(z.named ? { holders: Array.from({ length: qty[z.zone_key] }, (_, i) => (i === 0 && selfHolder ? name : (holders[z.zone_key] || [])[i] || "").trim()) } : {}),
      }));
      const o = await tapi<{ access_token: string }>("POST", "/ticket-orders", { match_id: matchId, items, buyer_name: name.trim(), phone, email: email.trim(), telegram, agree });
      try { const keep = JSON.parse(localStorage.getItem("umfl.orders") || "[]"); localStorage.setItem("umfl.orders", JSON.stringify([o.access_token, ...keep].slice(0, 20))); } catch { /* ignore */ }
      const p = await tapi<{ url: string; paid?: boolean }>("POST", `/ticket-orders/${o.access_token}/pay`, { provider });
      if (p.paid) router.push(`/chiptalar/${o.access_token}?yangi=1`);
      else window.location.href = p.url;
    } catch (e) {
      if (e instanceof TicketApiError) {
        setFields(e.fields);
        setErr("");
        if (e.status === 409) { load(); setStep(1); }
        alertMsg(e.message);
      }
      setBusy(false);
    }
  };

  const summary = (
    <aside className="tk-aside card card-pad">
      <h2 className="h4">Buyurtma</h2>
      {count === 0 ? <p className="muted tk-small">Hali chipta tanlanmagan. Sxemadan sektorni yoki pastdagi kartochkani tanlang.</p> : (
        <div className="tk-lines">
          {zones.filter((z) => qty[z.zone_key]).map((z) => (
            <div key={z.zone_key} className="tk-line"><span>{z.title} × {qty[z.zone_key]}<small>{z.mode === "numbered" ? "eng yaxshi bo‘sh o‘rin beriladi" : "erkin o‘rindiq"}</small></span><b>{fmtSum(z.price * qty[z.zone_key])}</b></div>
          ))}
          <div className="tk-line"><span>Xizmat haqi</span><b>{fmtSum(fee)}</b></div>
        </div>
      )}
      <div className="tk-total"><span>Jami</span><b>{fmtSum(total)}</b></div>
      {step === 1 ? (
        <button className="btn btn-primary btn-lg btn-block" disabled={!count} onClick={() => setStep(2)}>Davom etish</button>
      ) : (
        <>
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !count} onClick={pay}>{busy ? "Kutilmoqda…" : `${fmtSum(total)} to‘lash`}</button>
          <button className="btn btn-text btn-block" onClick={() => setStep(1)}>Orqaga — chipta tanlash</button>
          <p className="tk-note"><Lock size={14} /> To‘lov to‘lov tizimi sahifasida xavfsiz amalga oshiriladi</p>
        </>
      )}
      <p className="tk-note"><Clock size={14} /> Tanlangan chiptalar to‘lov uchun {sale.hold_minutes} daqiqaga band qilinadi</p>
    </aside>
  );

  return (
    <div className="tk-grid">
      <div className="stack" style={{ gap: 24 }}>
        {step === 1 ? (
          <>
            {sale.layout && (
              <section className="card card-pad">
                <div className="tk-head"><h2 className="h4">1. Zonani tanlang</h2><small className="muted">Sxemadagi sektorni yoki pastdagi kartochkani bosing</small></div>
                <StadiumMap layout={sale.layout} offers={zones} selected={selected} onPick={(k) => { const z = zones.find((x) => x.zone_key === k); if (z && !qty[k]) set(z, 1); }} />
                <div className="tk-legend">
                  {zones.map((z) => <span key={z.zone_key}><i style={{ background: zoneTint(z) }} />{z.title} · {fmtSum(z.price)}</span>)}
                  <span><i className="on" />Tanlangan</span><span><i className="off" />Sotilgan</span>
                </div>
              </section>
            )}
            <section>
              <div className="tk-head"><h2 className="h4">2. Chipta turi va soni</h2><small className="muted">Bitta buyurtmada {max} tagacha chipta</small></div>
              <div className="tk-cards">
                {zones.map((z) => {
                  const q = qty[z.zone_key] || 0, sold = z.left === 0;
                  return (
                    <div key={z.zone_key} className={`tk-type${z.kind === "vip" ? " vip" : ""}${q ? " on" : ""}${sold ? " sold" : ""}`} onClick={() => !q && !sold && set(z, 1)}>
                      <div className="tk-type-top"><span className="overline">{z.kind === "vip" ? "VIP zona" : zoneTint(z) !== "#C3C8CF" ? "Narx toifasi" : "Oddiy zona"}</span>{q > 0 && <span className="tk-pill"><Check size={12} /> Tanlandi</span>}{sold && <span className="tk-pill off">Sotildi</span>}</div>
                      <h3 className="h3">{z.title}</h3>
                      <p className="tk-sub">{ZONE_SUB(z)}</p>
                      <div className="tk-price"><b>{new Intl.NumberFormat("ru-RU").format(z.price)}</b><span>so‘m / 1 kishi</span></div>
                      <ul className="tk-perks">
                        <li><Check size={14} /> Elektron chipta, kirish QR-kod orqali</li>
                        {z.gate && <li><Check size={14} /> Kirish: {z.gate}-darvoza</li>}
                        {(z.perks || []).filter(Boolean).map((p) => <li key={p}><Check size={14} /> {p}</li>)}
                        {z.named && <li><Check size={14} /> Ismli chipta — kirishda tekshiriladi</li>}
                        {(sale.face_mode === "all" || (sale.face_mode === "vip" && z.kind === "vip")) && <li><Shield size={14} /> Chipta egasining yuziga bog‘lanadi</li>}
                      </ul>
                      <div className="tk-type-foot" onClick={(e) => e.stopPropagation()}>
                        <span className={z.left < 30 && !sold ? "tk-few" : ""}>{sold ? "Barcha chiptalar sotildi" : `Qoldi: ${z.left} ta`}</span>
                        <div className="tk-qty">
                          <button aria-label="Kamaytirish" disabled={!q} onClick={() => set(z, q - 1)}><Minus size={16} /></button>
                          <b aria-live="polite">{q}</b>
                          <button aria-label="Ko‘paytirish" disabled={sold || q >= z.left || count >= max} onClick={() => set(z, q + 1)}><Plus size={16} /></button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
            <div className="tk-alert"><Shield size={18} /> Chiptalar elektron: to‘lovdan so‘ng QR-kodli chipta va chek SMS{sale.telegram_delivery ? " va Telegram" : ""} orqali yuboriladi. Qaytarish — o‘yin boshlanishidan {sale.refund_hours} soat oldingacha.</div>
          </>
        ) : (
          <>
            <section className="card card-pad stack">
              <div><h2 className="h4">1. Aloqa ma’lumotlari</h2><p className="tk-sub">Chipta va chek shu raqamga SMS{sale.telegram_delivery ? " va Telegram" : ""} orqali yuboriladi</p></div>
              <div className="tk-form">
                <F label="Ism familiya" hint="Lotin harflarida" err={fields.buyer_name}><input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Aziz Karimov" /></F>
                <F label="Telefon" hint="Chipta havolasi shu raqamga keladi" err={fields.phone}><input className="input" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(fmtPhone(e.target.value))} /></F>
                <F label="Email (ixtiyoriy)" hint="Chek nusxasi uchun" err={fields.email}><input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="aziz@example.uz" /></F>
                {sale.telegram_delivery && (
                  <label className="tk-toggle"><span><b>Telegram bot orqali olish</b><small>@unitedmfl_bot chiptani darhol yuboradi</small></span><input type="checkbox" role="switch" checked={telegram} onChange={(e) => setTelegram(e.target.checked)} /></label>
                )}
              </div>
            </section>
            {named.map((z) => (
              <section key={z.zone_key} className="card card-pad stack">
                <div><h2 className="h4">2. {z.title} — chipta egalari</h2><p className="tk-sub">{z.title} chiptalari ismga yoziladi — kirishda shaxsni tasdiqlovchi hujjat so‘ralishi mumkin</p></div>
                {Array.from({ length: qty[z.zone_key] }, (_, i) => (
                  <div key={i} className="stack" style={{ gap: 8 }}>
                    {i === 0 && <label className="tk-check"><input type="checkbox" checked={selfHolder} onChange={(e) => setSelfHolder(e.target.checked)} /> Egasi — xaridorning o‘zi</label>}
                    <F label={`${i + 1}-chipta egasining ismi`} hint="Hujjatdagi kabi yozing" err={fields[`h_${z.zone_key}_${i}`]}>
                      <input className="input" disabled={i === 0 && selfHolder} value={i === 0 && selfHolder ? name : (holders[z.zone_key] || [])[i] || ""}
                        onChange={(e) => setHolders((h) => { const l = [...(h[z.zone_key] || [])]; l[i] = e.target.value; return { ...h, [z.zone_key]: l }; })} />
                    </F>
                  </div>
                ))}
              </section>
            ))}
            <section className="card card-pad stack">
              <h2 className="h4">{named.length ? 3 : 2}. To‘lov usuli</h2>
              {sale.providers.length === 0 ? <div className="tk-alert danger">Onlayn to‘lov hozircha ulanmagan — chiptalarni stadion kassasidan oling.</div> : (
                <div className="tk-pay">
                  {sale.providers.map((p) => (
                    <label key={p} className={provider === p ? "on" : ""}>
                      <input type="radio" name="provider" checked={provider === p} onChange={() => setProvider(p)} />
                      <i>{PROVIDERS[p]?.tag || p.slice(0, 2).toUpperCase()}</i>
                      <span><b>{PROVIDERS[p]?.name || p}</b><small>{PROVIDERS[p]?.sub}</small></span>
                    </label>
                  ))}
                </div>
              )}
              {fields.provider && <small className="tk-err">{fields.provider}</small>}
              <label className="tk-check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> Ommaviy oferta va chiptani qaytarish shartlari bilan tanishdim</label>
              {fields.agree && <small className="tk-err">{fields.agree}</small>}
            </section>
          </>
        )}
      </div>
      {summary}
    </div>
  );
}

function alertMsg(m: string) {
  const el = document.getElementById("tk-toast");
  if (!el) return;
  el.textContent = m; el.dataset.show = "1";
  window.setTimeout(() => { delete el.dataset.show; }, 4500);
}

function fmtPhone(v: string) {
  let d = v.replace(/\D/g, "");
  if (!d.startsWith("998")) d = "998" + d.replace(/^998?/, "");
  d = d.slice(0, 12);
  const p = [d.slice(0, 3), d.slice(3, 5), d.slice(5, 8), d.slice(8, 10), d.slice(10, 12)].filter(Boolean);
  return "+" + p.join(" ");
}

function F({ label, hint, err, children }: { label: string; hint?: string; err?: string; children: React.ReactNode }) {
  return <div className={`field${err ? " has-err" : ""}`}><label>{label}</label>{children}{err ? <small className="tk-err">{err}</small> : hint ? <small className="muted">{hint}</small> : null}</div>;
}

function Closed({ sale }: { sale: PublicSale }) {
  const t: Record<string, [string, string]> = {
    none: ["Chipta sotuvi hali boshlanmagan", "Sotuv ochilganda shu sahifada «Chipta sotib olish» tugmasi paydo bo‘ladi."],
    soon: ["Sotuv tez orada boshlanadi", sale.sale_from ? `Sotuv ${fmtDate(sale.sale_from)}, ${fmtTime(sale.sale_from)} da ochiladi.` : ""],
    paused: ["Sotuv vaqtincha to‘xtatilgan", "Birozdan keyin qayta kiring."],
    closed: ["Onlayn sotuv yakunlandi", "Qolgan chiptalarni stadion kassasidan so‘rang."],
    sold_out: ["Barcha chiptalar sotildi", "Qaytarilgan chiptalar shu sahifada yana sotuvga chiqadi."],
  };
  const [h, p] = t[sale.status] || t.none;
  return <div className="card card-pad tk-empty"><Info size={28} /><h2 className="h3">{h}</h2><p className="muted">{p}</p></div>;
}
