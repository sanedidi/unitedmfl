"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Alert, Check, Clock, Info, Share, Shield, UserIc } from "./ui";
import { ETicket } from "./ETicket";
import { PROVIDERS, TicketApiError, fmtSum, seatLine, tapi, type OrderV, type TicketV } from "@/lib/tickets";
import { fmtDate, fmtTime } from "@/lib/format";

const STATUS: Record<string, string> = {
  pending: "To‘lov kutilmoqda", paid: "To‘langan", refund_requested: "Qaytarish so‘rovi yuborilgan", partially_refunded: "Qisman qaytarilgan",
  refunded: "Qaytarilgan", cancelled: "Bekor qilingan", expired: "Band qilish muddati tugagan",
};

export function OrderView({ token }: { token: string }) {
  const sp = useSearchParams();
  const fresh = sp.get("yangi") === "1";
  const [o, setO] = useState<OrderV | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => tapi<OrderV>("GET", `/ticket-orders/${token}`).then(setO).catch((e) => setErr(e instanceof TicketApiError && e.status === 404 ? "Buyurtma topilmadi. Havolani SMS’dan qayta oching." : e.message)), [token]);
  useEffect(() => { load(); }, [load]);
  // after a redirect from Payme/Click the payment may land a few seconds later
  useEffect(() => {
    if (o?.status !== "pending") return;
    const t = window.setInterval(() => { setNow(Date.now()); }, 1000);
    const p = window.setInterval(load, 5000);
    return () => { window.clearInterval(t); window.clearInterval(p); };
  }, [o?.status, load]);

  if (err) return <div className="card card-pad tk-empty"><Alert size={28} /><h2 className="h3">{err}</h2><Link className="btn btn-ghost" href="/matchlar">Matchlarga qaytish</Link></div>;
  if (!o) return <div className="tk-skel" aria-busy="true">Yuklanmoqda…</div>;

  const paid = ["paid", "refund_requested", "partially_refunded"].includes(o.status);
  const active = o.tickets.filter((t) => t.status === "active" || t.status === "used");
  const faceFor = (t: TicketV) => o.face_mode === "all" || (o.face_mode === "vip" && t.zone_kind === "vip");
  const left = o.hold_until ? Math.max(0, Math.floor((new Date(o.hold_until).getTime() - now) / 1000)) : 0;

  const pay = async (provider: string) => {
    setBusy(true);
    try {
      const p = await tapi<{ url: string; paid?: boolean }>("POST", `/ticket-orders/${token}/pay`, { provider });
      if (p.paid) { await load(); setBusy(false); } else window.location.href = p.url;
    } catch (e) { setMsg((e as Error).message); setBusy(false); load(); }
  };
  const refund = async () => {
    if (!window.confirm("Barcha chiptalar uchun qaytarish so‘rovi yuborilsinmi? Administrator ko‘rib chiqadi, pul kartaga 1–3 ish kunida qaytadi.")) return;
    try { await tapi("POST", `/ticket-orders/${token}/refund-request`); setMsg("So‘rov yuborildi — administrator ko‘rib chiqadi"); load(); } catch (e) { setMsg((e as Error).message); }
  };
  const share = async (t: TicketV, cancel = false) => {
    try {
      const r = await tapi<{ token: string }>("POST", `/ticket-orders/${token}/tickets/${t.id}/share`, { cancel });
      await load();
      if (cancel) { setMsg("Eski havola bekor qilindi"); return; }
      const url = `${window.location.origin}/chipta/${r.token}`;
      const text = `${o.match.title} — chipta (${t.zone_name}). Ochib, o‘zingiz uchun faollashtiring:`;
      if (navigator.share) { try { await navigator.share({ title: "United MFL chipta", text, url }); return; } catch { /* closed */ } }
      await navigator.clipboard?.writeText(url).catch(() => {});
      setMsg("Havola nusxalandi — do‘stingizga yuboring");
    } catch (e) { setMsg((e as Error).message); }
  };

  return (
    <div className="tk-grid">
      <div className="stack" style={{ gap: 24 }}>
        {o.status === "pending" ? (
          <section className="card card-pad stack">
            <div className="tk-banner warn"><Clock size={22} /><div><b>To‘lov kutilmoqda</b><p>Chiptalar {left > 0 ? `yana ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} band turadi` : "band qilish muddati tugamoqda"}. To‘lov o‘tgach sahifa o‘zi yangilanadi.</p></div></div>
            <div className="tk-pay">
              {o.providers.map((p) => (
                <button key={p} className="tk-pay-btn" disabled={busy || left === 0} onClick={() => pay(p)}><i>{PROVIDERS[p]?.tag || p}</i><span><b>{PROVIDERS[p]?.name || p} orqali to‘lash</b><small>{fmtSum(o.total)}</small></span></button>
              ))}
            </div>
          </section>
        ) : !paid ? (
          <div className="card card-pad tk-empty"><Info size={28} /><h2 className="h3">{STATUS[o.status] || o.status}</h2>
            <p className="muted">{o.status === "expired" ? "To‘lov vaqtida o‘tmadi, chiptalar sotuvga qaytarildi." : o.status === "refunded" ? `${fmtSum(o.refunded)} kartangizga qaytarildi.` : ""}</p>
            <Link className="btn btn-primary" href={`/matchlar/${o.match.id}/chipta`}>Qaytadan tanlash</Link></div>
        ) : (
          <div className="tk-banner ok">
            <span className="tk-banner-ico"><Check size={22} /></span>
            <div><b>{fresh ? `To‘lov qabul qilindi — ${active.length} ta chipta tayyor` : `${active.length} ta chipta`}</b>
              <p>Chiptalar havolasi {o.phone} raqamiga SMS orqali yuborildi. Buyurtma № {o.number}.{o.status === "refund_requested" ? " Qaytarish so‘rovi ko‘rib chiqilmoqda." : ""}</p></div>
          </div>
        )}
        {msg && <div className="tk-alert" role="status">{msg}</div>}

        {paid && (
          <section className="stack">
            <div className="tk-head"><h2 className="h4">Chiptalar ({o.tickets.length})</h2><small className="muted">Har bir chipta — alohida QR-kod, do‘stlaringizga ulashishingiz mumkin</small></div>
            {o.face_mode !== "off" && active.some((t) => faceFor(t) && t.face_status === "none") && (
              <div className="tk-banner lime"><Shield size={20} /><div><b>Har bir chipta — bitta yuz</b><p>Kirish uchun chipta egasi uni o‘z yuzi bilan faollashtiradi.{o.activate_by ? ` Muddat: ${fmtDate(o.activate_by, false)}, ${fmtTime(o.activate_by)} gacha.` : ""}</p></div></div>
            )}
            <div className="tk-tickets">
              {o.tickets.map((t) => (
                <ETicket key={t.id} t={t} match={o.match} foot={<TicketActions t={t} needFace={faceFor(t)} transfer={o.transfer_allowed} onShare={share} />} />
              ))}
            </div>
          </section>
        )}
      </div>

      <aside className="tk-aside">
        <div className="tk-receipt">
          <div className="tk-rc-head"><b>United MFL</b><small>TO‘LOV CHEKI</small>{paid && <span className="tk-pill"><Check size={12} /> To‘lov qabul qilindi</span>}</div>
          <div className="tk-rc-sum">{fmtSum(o.total)}</div>
          <dl>
            <div><dt>Buyurtma №</dt><dd>{o.number}</dd></div>
            <div><dt>Sana</dt><dd>{fmtDate(o.paid_at || o.created_at, false)}, {fmtTime(o.paid_at || o.created_at)}</dd></div>
            <div><dt>To‘lov usuli</dt><dd>{PROVIDERS[o.provider]?.name || (o.provider === "cash" ? "Kassa" : "—")}</dd></div>
            {o.card_mask && <div><dt>Karta</dt><dd>{o.card_mask}</dd></div>}
            <div><dt>Xaridor</dt><dd>{o.buyer_name}</dd></div>
            <div><dt>Telefon</dt><dd>{o.phone}</dd></div>
          </dl>
          <dl className="tk-rc-lines">
            {Object.entries(o.tickets.reduce<Record<string, { n: number; s: number }>>((m, t) => { m[t.zone_name] = { n: (m[t.zone_name]?.n || 0) + 1, s: (m[t.zone_name]?.s || 0) + t.price }; return m; }, {}))
              .map(([z, x]) => <div key={z}><dt>{z} × {x.n}</dt><dd>{fmtSum(x.s)}</dd></div>)}
            <div><dt>Xizmat haqi</dt><dd>{fmtSum(o.service_fee)}</dd></div>
            {o.refunded > 0 && <div><dt>Qaytarilgan</dt><dd>−{fmtSum(o.refunded)}</dd></div>}
          </dl>
          <div className="tk-total"><span>Jami</span><b>{fmtSum(o.total)}</b></div>
          <p className="tk-rc-foot">{STATUS[o.status]}</p>
        </div>
        <button className="btn btn-ghost btn-block" onClick={() => window.print()}>Chekni chop etish / PDF</button>
        {o.status === "paid" && (
          <div className="tk-refund">
            <b>Chiptani qaytarish</b>
            <p className="muted">{o.refund_deadline && new Date(o.refund_deadline).getTime() > Date.now()
              ? `${fmtDate(o.refund_deadline, false)}, ${fmtTime(o.refund_deadline)} gacha so‘rov yuborish mumkin.` : "Onlayn qaytarish muddati o‘tgan — administratorga murojaat qiling."}</p>
            {o.refund_deadline && new Date(o.refund_deadline).getTime() > Date.now() && <button className="btn btn-text btn-sm" onClick={refund}>Qaytarish so‘rovi</button>}
          </div>
        )}
      </aside>
    </div>
  );
}

function TicketActions({ t, needFace, transfer, onShare }: { t: TicketV; needFace: boolean; transfer: boolean; onShare: (t: TicketV, cancel?: boolean) => void }) {
  if (t.status === "used") return <div className="tk-et-state"><Check size={14} /> Kirildi{t.used_gate ? ` · ${t.used_gate}-darvoza` : ""}</div>;
  if (t.status !== "active") return <div className="tk-et-state off">{t.status === "refunded" ? "Qaytarilgan" : "Bekor qilingan"}</div>;
  const open = `/chipta/${t.holder_token}`;
  const bound = t.face_status !== "none";
  return (
    <>
      <div className={`tk-et-state${needFace && !bound ? (t.transfer_sent_at ? " wait" : " off") : ""}`}>
        <UserIc size={14} />
        {needFace ? (bound ? (t.face_status === "bound" ? `Faollashtirildi · yuz bog‘langan${t.holder_name ? " · " + t.holder_name : ""}` : "Hujjat bilan kirish") : t.transfer_sent_at ? "Havola yuborildi · faollashtirish kutilmoqda" : "Faollashtirilmagan")
          : seatLine(t)}
      </div>
      <div className="tk-et-actions">
        <Link className="btn btn-primary btn-sm" href={open}>{needFace && !bound ? "O‘zim uchun" : "QR-kodni ochish"}</Link>
        {transfer && !bound && (t.transfer_sent_at
          ? <button className="btn btn-ghost btn-sm" onClick={() => onShare(t, true)}>Havolani bekor qilish</button>
          : <button className="btn btn-ghost btn-sm" onClick={() => onShare(t)}><Share size={14} /> Do‘stga yuborish</button>)}
      </div>
    </>
  );
}
