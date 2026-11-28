import { useEffect, useMemo, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router";
import { PageHead, SITE_URL } from "@/components/Layout";
import { Empty, ErrorBox, Field, Loading, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { StadiumCanvas } from "@/components/StadiumCanvas";
import { api, ApiError } from "@/lib/api";
import { useDebounced, useLoad } from "@/lib/hooks";
import { fmtDateTime, fmtShort, fmtUZS, fromLocalInput, toLocalInput } from "@/lib/format";
import { useAuth, Allowed } from "@/lib/auth";
import {
  ORDER_STATUS, PROVIDER, SALE_STATUS, SCAN_RESULT, TICKET_STATUS,
  type MatchInfo, type OrderRow, type Sale, type SaleRow, type SaleView, type TicketV, type Venue, type ZonePrice,
} from "@/lib/tickets";
import { tx } from "@/lib/i18n";
import "@/tickets.css";

export function TicketsSection() {
  return (
    <Routes>
      <Route index element={<TicketsHome />} />
      <Route path="match/:id" element={<SalePage />} />
      <Route path="orders/:id" element={<OrderPage />} />
    </Routes>
  );
}

const Badge = ({ map, k }: { map: Record<string, { label: string; tone: string }>; k: string }) => <span className={`badge ${map[k]?.tone || ""}`}>{map[k]?.label || k}</span>;
const Bar = ({ v, max, dark }: { v: number; max: number; dark?: boolean }) => (
  <div className="tk-bar"><span>{v} / {max}</span><i><b style={{ width: `${max ? Math.min(100, (v / max) * 100) : 0}%`, background: dark ? "var(--n-900)" : undefined }} /></i></div>
);

/* ================= C1 + C4 ================= */
function TicketsHome() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") || "sales";
  const { can } = useAuth();
  return (
    <>
      <PageHead title={tx("Chiptalar")} sub={tx("Matchlarga chipta sotuvi, zonalar va narxlar, buyurtmalar, kirish nazorati")}
        actions={<>{can("scan") && <Link className="btn" to="/scan"><I.qr size={16} />{" "}{tx("Kirish nazorati")}</Link>}{can("stadiums") && <Link className="btn" to="/stadiums">{tx("Stadionlar")}</Link>}</>} />
      <div className="tabs" role="tablist">
        {([["sales", tx("Sotuvlar")], ["orders", tx("Buyurtmalar")]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setSp({ tab: k })}>{l}</button>)}
      </div>
      {tab === "sales" ? <SalesList /> : <OrdersList />}
    </>
  );
}

function SalesList() {
  const { data, error, reload } = useLoad(() => api.get<{ items: SaleRow[]; kpi: Record<string, number>; journal: OrderRow[]; providers: { key: string; name: string; enabled: boolean }[] }>("/admin/ticket-sales"), []);
  const [filter, setFilter] = useState("all");
  const nav = useNavigate();
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const items = data.items.filter((x) => filter === "all" || x.status === filter);
  const count = (st: string) => data.items.filter((x) => x.status === st).length;
  return (
    <div className="tk-cols">
      <div className="stack">
        <div className="card tk-kpis">
          <div><b>{(data.kpi.sold || 0).toLocaleString("ru-RU")}</b><small>{tx("Sotilgan chiptalar")}</small></div>
          <div><b>{(data.kpi.revenue || 0).toLocaleString("ru-RU")}</b><small>{tx("Daromad, so‘m")}</small></div>
          <div><b>{data.kpi.today || 0}</b><small>{tx("So‘nggi 24 soatda")}</small></div>
          <div><b className={data.kpi.refund_requests ? "danger-text" : ""}>{data.kpi.refund_requests || 0}</b><small>{tx("Qaytarish so‘rovi")}</small></div>
        </div>
        <div className="row wrap">
          {([["all", tx("Hammasi"), data.items.length], ["open", tx("Sotuvda"), count("open")], ["draft", tx("Qoralama"), count("draft")], ["paused", tx("To‘xtatilgan"), count("paused")], ["closed", tx("Yopilgan"), count("closed")], ["none", tx("Sotuv yo‘q"), count("none")]] as const)
            .map(([k, l, n]) => <button key={k} className={`chip${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{l} <small>{n}</small></button>)}
        </div>
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>{tx("Match")}</th><th>{tx("Sotuv holati")}</th><th>{tx("Zonalar")}</th><th>{tx("Daromad")}</th><th /></tr></thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.match_id} className="clickable" onClick={() => nav(`match/${x.match_id}`)}>
                  <td><b>{x.title}</b><div className="muted small">{x.stage}{x.kickoff_at ? ` · ${fmtShort(x.kickoff_at)}` : ""}</div></td>
                  <td><Badge map={SALE_STATUS} k={x.status} />{x.status === "open" && x.sale_to && <div className="muted small">{tx("{0} gacha", fmtShort(x.sale_to))}</div>}</td>
                  <td>{x.zones.length ? <div className="stack" style={{ gap: 6 }}>{x.zones.map((z) => <div key={z.zone_key} className="row small"><span className="tk-zname">{z.title}</span><Bar v={z.sold} max={z.capacity} dark={z.kind === "vip"} /></div>)}</div> : <span className="muted small">—</span>}</td>
                  <td>{x.revenue ? x.revenue.toLocaleString("ru-RU") : "—"}</td>
                  <td className="actions"><I.arrow size={16} /></td>
                </tr>
              ))}
              {!items.length && <tr><td colSpan={5}><Empty title={tx("Matchlar yo‘q")} text={tx("Kelgusi matchlar shu yerda chiqadi")} /></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div className="stack tk-side">
        <div className="card">
          <div className="card-head"><h3>{tx("Sotuv jurnali")}</h3><small className="muted">{tx("so‘nggi")}</small></div>
          <div className="card-pad stack" style={{ gap: 12 }}>
            {data.journal.length === 0 && <div className="muted small">{tx("Hali buyurtma yo‘q")}</div>}
            {data.journal.map((o) => (
              <Link key={o.id} to={`orders/${o.id}`} className="tk-journal">
                <i className={`dot ${ORDER_STATUS[o.status]?.tone}`} />
                <span><b>{o.number} · {o.buyer_name}</b><small>{o.items.map((i) => `${i.qty}× ${i.zone}`).join(", ")} · {fmtUZS(o.total)} · {fmtShort(o.created_at)}</small></span>
              </Link>
            ))}
          </div>
        </div>
        <div className="card card-pad stack" style={{ gap: 10 }}>
          <h3>{tx("To‘lov tizimlari")}</h3>
          {data.providers.map((p) => <div key={p.key} className="tk-kv"><span>{p.name}</span><b className={p.enabled ? "ok-text" : "muted"}>{p.enabled ? tx("Ulangan") : tx("O‘chirilgan")}</b></div>)}
          <div className="muted small">{tx("Kalitlar serverdagi .env faylida: PAYME_MERCHANT_ID, PAYME_KEY, CLICK_SERVICE_ID, CLICK_MERCHANT_ID, CLICK_SECRET_KEY.")}</div>
        </div>
      </div>
    </div>
  );
}

function OrdersList({ matchId }: { matchId?: number }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const dq = useDebounced(q, 300);
  const nav = useNavigate();
  const { data, error, reload } = useLoad(() => api.get<{ items: OrderRow[]; counts: Record<string, number> }>(`/admin/ticket-orders?q=${encodeURIComponent(dq)}&status=${status}&page=${page}${matchId ? `&match_id=${matchId}` : ""}`), [dq, status, page, matchId]);
  useEffect(() => setPage(1), [dq, status]);
  if (error) return <ErrorBox error={error} retry={reload} />;
  const c = data?.counts || {};
  return (
    <div className="stack">
      <div className="row wrap">
        <input className="input" style={{ maxWidth: 280 }} placeholder={tx("Buyurtma №, chipta №, ism yoki telefon…")} value={q} onChange={(e) => setQ(e.target.value)} />
        {([["", tx("Hammasi"), c.all], ["paid", tx("To‘langan"), c.paid], ["pending", tx("Kutilmoqda"), c.pending], ["refund_requested", tx("Qaytarish so‘rovi"), c.refund_requested], ["refund", tx("Qaytarilgan"), (c.refunded || 0) + (c.partially_refunded || 0)], ["cancelled", tx("Bekor"), (c.cancelled || 0)], ["expired", tx("Muddati o‘tgan"), c.expired]] as const)
          .map(([k, l, n]) => <button key={k} className={`chip${status === k ? " on" : ""}`} onClick={() => setStatus(k)}>{l} <small>{n || 0}</small></button>)}
      </div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>{tx("Buyurtma")}</th><th>{tx("Xaridor")}</th>{!matchId && <th>{tx("Match")}</th>}<th>{tx("Chiptalar")}</th><th>{tx("Summa")}</th><th>{tx("To‘lov")}</th><th>{tx("Holat")}</th></tr></thead>
          <tbody>
            {!data ? <tr><td colSpan={7}><Loading /></td></tr> : data.items.map((o) => (
              <tr key={o.id} className="clickable" onClick={() => nav(`/tickets/orders/${o.id}`)}>
                <td><b>{o.number}</b><div className="muted small">{fmtShort(o.created_at)}</div></td>
                <td>{o.buyer_name}<div className="muted small">{o.phone}</div></td>
                {!matchId && <td className="small">{o.match}</td>}
                <td>{o.items.map((i) => <span key={i.zone} className="badge plain" style={{ marginRight: 4 }}>{i.qty}× {i.zone}</span>)}</td>
                <td><b>{o.total.toLocaleString("ru-RU")}</b>{o.refunded > 0 && <div className="danger-text small">−{o.refunded.toLocaleString("ru-RU")}</div>}</td>
                <td>{PROVIDER[o.provider] || o.provider}{o.source === "box_office" && <div className="muted small">{tx("kassa")}</div>}</td>
                <td><Badge map={ORDER_STATUS} k={o.status} />{o.status === "pending" && o.hold_until && <div className="muted small">{tx("band: {0} gacha", fmtShort(o.hold_until))}</div>}</td>
              </tr>
            ))}
            {data && !data.items.length && <tr><td colSpan={7}><Empty title={tx("Buyurtma topilmadi")} /></td></tr>}
          </tbody>
        </table>
      </div>
      <div className="row"><span className="muted small grow">{data?.items.length || 0}{" "}{tx("ta ko‘rsatilmoqda")}</span>
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button><span className="small">{page}</span><button className="btn btn-sm" disabled={(data?.items.length || 0) < 50} onClick={() => setPage(page + 1)}>›</button></div>
    </div>
  );
}

/* ================= C2 / C3 / C7 · one match ================= */
function SalePage() {
  const { id } = useParams();
  const mid = Number(id);
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, reload, setData } = useLoad(() => api.get<SaleView>(`/admin/matches/${mid}/ticket-sale`), [mid]);
  const [tab, setTab] = useState<"sale" | "zones" | "security" | "orders" | "entry">("sale");
  const [boxOffice, setBoxOffice] = useState(false);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const s = data.sale;
  const put = async (patch: Partial<Sale> & Record<string, unknown>) => {
    try { setData(await api.put<SaleView>(`/admin/matches/${mid}/ticket-sale`, patch)); toast(tx("Saqlandi")); }
    catch (e) { toast(e instanceof ApiError ? Object.values(e.fields)[0] as string || e.message : tx("Xato"), "error"); }
  };
  const status = async (st: string) => {
    if (st === "closed" && !(await confirm({ title: tx("Sotuvni yopish?"), text: tx("Yangi buyurtmalar qabul qilinmaydi. Sotilgan chiptalar amal qiladi."), ok: tx("Yopish"), danger: true }))) return;
    try { setData(await api.post<SaleView>(`/admin/matches/${mid}/ticket-sale/status`, { status: st })); toast(SALE_STATUS[st].label); }
    catch (e) { toast(e instanceof ApiError ? e.message : tx("Xato"), "error"); }
  };
  const sold = data.zones.reduce((n, z) => n + z.sold, 0), cap = data.zones.reduce((n, z) => n + z.capacity, 0);
  return (
    <>
      <PageHead pre={<Link to="/tickets" className="muted"><I.back size={14} />{" "}{tx("Chiptalar")}</Link>} title={tx("{0} · chipta sotuvi", data.match.title)}
        sub={`${data.match.stage ? data.match.stage + " · " : ""}${data.match.kickoff_at ? fmtDateTime(data.match.kickoff_at) : tx("vaqt belgilanmagan")}${data.match.venue ? " · " + data.match.venue : ""}`}
        actions={s && <>{s.box_office && <Allowed to="create"><button className="btn" onClick={() => setBoxOffice(true)}>{tx("Kassada sotish")}</button></Allowed>}<a className="btn" href={`${SITE_URL}/matchlar/${mid}/chipta`} target="_blank" rel="noreferrer">{tx("Saytda ko‘rish")}</a></>} />
      {!s ? <SaleStart mid={mid} onDone={setData} /> : (
        <>
          <div className={`tk-status ${s.status}`}>
            <input type="checkbox" className="switch lime" checked={s.status === "open"} onChange={(e) => status(e.target.checked ? "open" : "paused")} aria-label={tx("Sotuv ochiq")} />
            <span className="grow"><b>{s.status === "open" ? tx("Sotuv ochiq") : SALE_STATUS[s.status].label}</b>
              <small>{s.status === "open" ? tx("Saytda «Chipta sotib olish» tugmasi faol{0}", s.opened_at ? " · " + fmtShort(s.opened_at) + " da ochilgan" : "") : tx("Saytda tugma ko‘rinmaydi")}</small></span>
            <span className="small"><b>{sold}{" "}{tx("/ {0} sotildi", cap)}</b><small className="muted">{" "}{tx("· daromad")}{" "}{fmtUZS(data.revenue)}</small></span>
            {s.status !== "closed" && <button className="btn btn-sm" onClick={() => status("closed")}>{tx("Yopish")}</button>}
          </div>
          <div className="tabs" role="tablist">
            {([["sale", tx("Sotuv")], ["zones", tx("Zonalar va narxlar")], ["security", tx("Kirish xavfsizligi")], ["orders", tx("Buyurtmalar")], ["entry", tx("Kirish jurnali")]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
          </div>
          {tab === "sale" && <SaleSettings v={data} put={put} />}
          {tab === "zones" && <ZonePrices v={data} mid={mid} setData={setData} />}
          {tab === "security" && <SecuritySettings v={data} put={put} mid={mid} />}
          {tab === "orders" && <OrdersList matchId={mid} />}
          {tab === "entry" && <EntryLog mid={mid} v={data} />}
        </>
      )}
      {boxOffice && <BoxOffice v={data} mid={mid} onClose={() => { setBoxOffice(false); reload(); }} />}
    </>
  );
}

function LayoutPicker({ value, onPick }: { value: number | null; onPick: (id: number) => void }) {
  const { data } = useLoad(() => api.get<{ items: Venue[] }>("/admin/venues"), []);
  const opts = (data?.items || []).filter((v) => v.published);
  return (
    <select className="select" value={value || ""} onChange={(e) => e.target.value && onPick(Number(e.target.value))}>
      <option value="">{tx("— Stadion sxemasini tanlang —")}</option>
      {opts.map((v) => <option key={v.id} value={v.published!.id}>{v.name}{" "}{tx("· v{0} · {1} o‘rin", v.published!.version, v.published!.seats)}</option>)}
    </select>
  );
}

function SaleStart({ mid, onDone }: { mid: number; onDone: (v: SaleView) => void }) {
  const toast = useToast();
  return (
    <div className="card card-pad stack" style={{ maxWidth: 560 }}>
      <h3>{tx("Chipta sotuvini sozlash")}</h3>
      <div className="muted">{tx("Stadion sxemasini tanlang — zonalar (Oddiy, VIP…) undan olinadi. Keyin narxlarni qo‘yib, sotuvni ochasiz.")}</div>
      <LayoutPicker value={null} onPick={async (id) => { try { onDone(await api.put<SaleView>(`/admin/matches/${mid}/ticket-sale`, { layout_id: id })); } catch (e) { toast(e instanceof ApiError ? e.message : tx("Xato"), "error"); } }} />
      <Link to="/stadiums" className="small">{tx("Sxema yo‘qmi? Stadion konstruktorida yarating →")}</Link>
    </div>
  );
}

function SaleSettings({ v, put }: { v: SaleView; put: (p: Record<string, unknown>) => void }) {
  const s = v.sale!;
  const num = (k: keyof Sale, label: string, hint: string, suffix = "") => (
    <Field label={label} hint={hint}><div className="row"><input className="input" type="number" defaultValue={s[k] as number} onBlur={(e) => Number(e.target.value) !== s[k] && put({ [k]: Number(e.target.value) })} />{suffix && <span className="muted small">{suffix}</span>}</div></Field>
  );
  const tog = (k: keyof Sale, t: string, d: string) => <label className="toggle-row"><span><b>{t}</b><small>{d}</small></span><input type="checkbox" className="switch lime" checked={!!s[k]} onChange={(e) => put({ [k]: e.target.checked })} /></label>;
  const max = Math.max(1, ...v.daily.map((d) => d.count));
  return (
    <div className="tk-cols">
      <div className="card card-pad stack">
        <h3>{tx("Sotuv qoidalari")}</h3>
        <div className="form-grid">
          <Field label={tx("Sotuv boshlanishi")} hint={tx("Shu vaqtdan saytda tugma chiqadi")}><input className="input" type="datetime-local" defaultValue={toLocalInput(s.sale_from)} onBlur={(e) => put(e.target.value ? { sale_from: fromLocalInput(e.target.value) } : { clear_sale_from: true })} /></Field>
          <Field label={tx("Sotuv tugashi")} hint={tx("Odatda match boshlanishidan 1–2 soat oldin")}><input className="input" type="datetime-local" defaultValue={toLocalInput(s.sale_to)} onBlur={(e) => put(e.target.value ? { sale_to: fromLocalInput(e.target.value) } : { clear_sale_to: true })} /></Field>
          {num("hold_minutes", tx("Band qilish vaqti"), tx("To‘lanmasa chiptalar qaytadi"), tx("daqiqa"))}
          {num("max_per_order", tx("Bir buyurtmada maksimal"), tx("Jami chiptalar soni"), "ta")}
          {num("refund_hours", tx("Qaytarish muddati"), tx("Match boshlanishidan oldin; keyin faqat admin"), tx("soat"))}
          {num("service_fee", tx("Xizmat haqi"), tx("Har bir chipta uchun"), tx("so‘m"))}
        </div>
        {tog("telegram_delivery", tx("Telegram bot orqali yuborish"), tx("Xaridor botni ulasa — chipta va chek botga ham keladi"))}
        {tog("box_office", tx("Kassada sotuv (offline)"), tx("Stadion kassasida admin panel orqali naqd sotish"))}
      </div>
      <div className="stack tk-side">
        <div className="card card-pad stack">
          <h3>{tx("Stadion sxemasi")}</h3>
          <LayoutPicker value={s.layout_id} onPick={(id) => put({ layout_id: id })} />
          {v.layout && <div className="st-thumb"><StadiumCanvas layout={v.layout.doc} colorBy="zone" height={190} /></div>}
          {v.zones.map((z) => <div key={z.zone_key} className="tk-kv"><span><i className="dot" style={{ background: z.color }} /> {z.title}</span><b>{z.sold} / {z.capacity}</b></div>)}
          {v.layout && <Link className="small" to={`/stadiums/${v.layout.venue_id}`}>{tx("Konstruktorda ochish →")}</Link>}
        </div>
        <div className="card card-pad stack">
          <div className="row"><h3 className="grow">{tx("Sotuv dinamikasi")}</h3><small className="muted">{tx("7 kun")}</small></div>
          <div className="tk-chart">{v.daily.map((d) => <div key={d.day} title={`${d.day}: ${d.count}`}><i style={{ height: `${(d.count / max) * 100}%` }} /><small>{d.day}</small></div>)}</div>
        </div>
      </div>
    </div>
  );
}

function ZonePrices({ v, mid, setData }: { v: SaleView; mid: number; setData: (v: SaleView) => void }) {
  const toast = useToast();
  const [edit, setEdit] = useState<ZonePrice | null>(null);
  const save = async (z: ZonePrice) => {
    try {
      setData(await api.put<SaleView>(`/admin/matches/${mid}/ticket-sale/zones/${z.zone_key}`, { title: z.title, subtitle: z.subtitle, price: z.price, enabled: z.enabled, named: z.named, perks: z.perks, gate: z.gate }));
      toast(tx("Saqlandi")); setEdit(null);
    } catch (e) { toast(e instanceof ApiError ? e.message : tx("Xato"), "error"); }
  };
  return (
    <div className="card">
      <div className="card-head"><div><h3>{tx("Zonalar va narxlar")}</h3><small className="muted">{tx("Har bir zona — saytdagi alohida chipta turi. Zonalar ro‘yxati stadion sxemasidan olinadi")}</small></div></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{tx("Zona")}</th><th>{tx("Turi")}</th><th>{tx("Narx, so‘m")}</th><th>{tx("Sotildi")}</th><th>{tx("O‘rin")}</th><th>{tx("Holat")}</th><th /></tr></thead>
          <tbody>
            {v.zones.map((z) => (
              <tr key={z.zone_key} className="clickable" onClick={() => setEdit(structuredClone(z))}>
                <td><b>{z.title}</b><div className="muted small">{z.sections.join(", ")}{z.gate ? tx(" · kirish {0}", z.gate) : ""}</div></td>
                <td><span className={`tk-kind ${z.kind}`}>{z.kind === "vip" ? "VIP" : tx("Oddiy")}</span></td>
                <td>{z.price ? z.price.toLocaleString("ru-RU") : <span className="warn-text">{tx("narx yo‘q")}</span>}</td>
                <td><Bar v={z.sold} max={z.capacity} dark={z.kind === "vip"} />{z.held > 0 && <small className="muted">{tx("+{0} band", z.held)}</small>}</td>
                <td className="small">{z.mode === "numbered" ? tx("Raqamli") : tx("Erkin")}{z.named && <div className="muted">{tx("ismli chipta")}</div>}</td>
                <td>{!z.enabled ? <span className="badge">{tx("O‘chirilgan")}</span> : z.left === 0 ? <span className="badge warn">{tx("Sotildi")}</span> : <span className="badge ok">{tx("Sotuvda")}</span>}</td>
                <td className="actions"><I.edit size={16} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal title={tx("{0} — tahrirlash", edit.title)} onClose={() => setEdit(null)} footer={<><button className="btn btn-ghost" onClick={() => setEdit(null)}>{tx("Bekor qilish")}</button><button className="btn btn-primary" onClick={() => save(edit)}>{tx("Saqlash")}</button></>}>
          <div className="stack">
            <div className="form-grid">
              <Field label={tx("Nomi (saytda)")}><input className="input" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
              <Field label={tx("Narx, so‘m")} hint={tx("1 kishi uchun")}><input className="input" type="number" value={edit.price || ""} onChange={(e) => setEdit({ ...edit, price: Number(e.target.value) })} /></Field>
              <Field label={tx("Qisqa izoh")} hint={tx("«A, B, D sektorlar · erkin o‘rindiq»")} full><input className="input" value={edit.subtitle} onChange={(e) => setEdit({ ...edit, subtitle: e.target.value })} /></Field>
              <Field label={tx("Kirish (darvoza)")}><input className="input" value={edit.gate} onChange={(e) => setEdit({ ...edit, gate: e.target.value })} /></Field>
            </div>
            <label className="toggle-row"><span><b>{tx("Sotuvda")}</b><small>{tx("O‘chirilsa saytda bu zona ko‘rinmaydi")}</small></span><input type="checkbox" className="switch lime" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} /></label>
            <label className="toggle-row"><span><b>{tx("Ismli chipta")}</b><small>{tx("Xaridor har bir chipta egasining ismini kiritadi, kirishda tekshiriladi")}</small></span><input type="checkbox" className="switch lime" checked={edit.named} onChange={(e) => setEdit({ ...edit, named: e.target.checked })} /></label>
            <Field label={tx("Imtiyozlar")} hint={tx("Saytdagi kartochkada ✓ ro‘yxat, chiptada teglar. Har qatorda bittadan")}>
              <textarea className="textarea" value={edit.perks.join("\n")} onChange={(e) => setEdit({ ...edit, perks: e.target.value.split("\n") })} placeholder={tx("Yumshoq o‘rindiq\nAlohida kirish va VIP-lounge")} />
            </Field>
            <div className="muted small">{tx("O‘rinlar, sektorlar va bloklangan joylar stadion konstruktorida o‘zgartiriladi.")}</div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SecuritySettings({ v, put, mid }: { v: SaleView; put: (p: Record<string, unknown>) => void; mid: number }) {
  const s = v.sale!;
  const toast = useToast();
  const confirm = useConfirm();
  const tog = (k: keyof Sale, t: string, d: string) => <label className="toggle-row"><span><b>{t}</b><small>{d}</small></span><input type="checkbox" className="switch lime" checked={!!s[k]} onChange={(e) => put({ [k]: e.target.checked })} /></label>;
  const e = v.entry;
  const scans = useLoad(() => api.get<{ items: { id: number; at: string; result: string; gate: string; detail: string; ticket: string; scanner: string; score?: number }[] }>(`/admin/ticket-scans?match_id=${mid}&suspicious=1`), [mid]);
  return (
    <div className="tk-cols">
      <div className="stack">
        <div className="card card-pad stack">
          <h3>{tx("Himoya darajalari")}</h3>
          <div className="muted small">{tx("Bitta QR bilan ikki kishi kirmasligi uchun. Qatlamlar birgalikda ishlaydi")}</div>
          {tog("dynamic_qr", tx("1. Dinamik QR"), tx("Kod har 30 soniyada yangilanadi — skrinshot va nusxa ishlamaydi. Chipta faqat sayt yoki Telegram botda ochiladi"))}
          {tog("single_scan", tx("2. Bir martalik skan"), tx("Birinchi skandan keyin chipta «ishlatilgan». Qayta skan — ogohlantirish"))}
          <div className="toggle-row"><span><b>{tx("3. Yuz bilan bog‘lash (Face ID)")}</b><small>{tx("Chipta egasi selfi bilan faollashtiradi, kirishda yuz solishtiriladi")}</small></span></div>
          <div className="seg block">{(["off", "vip", "all"] as const).map((k) => <button key={k} className={s.face_mode === k ? "on" : ""} onClick={() => put({ face_mode: k })}>{{ off: tx("O‘chiq"), vip: tx("Faqat VIP"), all: tx("Barcha chiptalar") }[k]}</button>)}</div>
          {s.face_mode !== "off" && (
            <>
              <div className="form-grid">
                <div className="field"><label>{tx("Tekshiruv usuli")}</label>
                  <div className="seg block"><button className={s.face_check === "auto" ? "on" : ""} onClick={() => put({ face_check: "auto" })}>{tx("Avtomatik")}</button><button className={s.face_check === "manual" ? "on" : ""} onClick={() => put({ face_check: "manual" })}>{tx("Nazoratchiga rasm")}</button></div>
                </div>
                <Field label={tx("Moslik chegarasi: {0}%", s.face_threshold)} hint={tx("Avtomatik rejimda shundan past bo‘lsa — «mos kelmadi»")}><input type="range" min={60} max={99} defaultValue={s.face_threshold} onMouseUp={(ev) => put({ face_threshold: Number((ev.target as HTMLInputElement).value) })} onTouchEnd={(ev) => put({ face_threshold: Number((ev.target as HTMLInputElement).value) })} /></Field>
                <Field label={tx("Faollashtirish muddati")} hint={tx("Match boshlanishidan necha soat oldingacha")}><input className="input" type="number" defaultValue={s.activation_hours} onBlur={(ev) => put({ activation_hours: Number(ev.target.value) })} /></Field>
                <Field label={tx("Biometrik ma’lumotni saqlash")} hint={tx("Match tugagach necha kun, keyin avtomatik o‘chiriladi")}><input className="input" type="number" defaultValue={s.face_retention_days} onBlur={(ev) => put({ face_retention_days: Number(ev.target.value) })} /></Field>
              </div>
              {tog("transfer_allowed", tx("Chiptani o‘tkazish"), tx("Do‘stga havola — faollashtirishdan oldin. Faollashtirilgach egasi o‘zgarmaydi"))}
              {tog("no_face_entry", tx("Yuzsiz kirish (muqobil)"), tx("Rozilik bermaganlar uchun: hujjat bilan, ism chiptadagiga mos bo‘lishi shart"))}
            </>
          )}
        </div>
        {s.face_mode !== "off" && (
          <div className="card card-pad stack">
            <h3>{tx("Biometrik ma’lumotlar")}</h3>
            <div className="tk-kv"><span>{tx("Saqlash joyi")}</span><b>{tx("Server (O‘zbekistonda bo‘lishi shart)")}</b></div>
            <div className="tk-kv"><span>{tx("Nima saqlanadi")}</span><b>{tx("Kichik selfi, shifrlangan")}</b></div>
            <div className="tk-kv"><span>{tx("Saqlash muddati")}</span><b>{tx("Match + {0} kun", s.face_retention_days)}</b></div>
            <div className="tk-kv"><span>{tx("Kim ko‘radi")}</span><b>{tx("Faqat nazoratchi — skan paytida")}</b></div>
            <button className="btn btn-danger" onClick={async () => {
              if (!(await confirm({ title: tx("Yuz ma’lumotlarini o‘chirish?"), text: tx("Shu match chiptalariga bog‘langan barcha selfilar o‘chiriladi. Kirishda faqat hujjat bilan tekshirish qoladi."), ok: tx("O‘chirish"), danger: true }))) return;
              const r = await api.del<{ deleted: number }>(`/admin/matches/${mid}/ticket-sale/faces`); toast(tx("{0} ta o‘chirildi", r?.deleted ?? 0));
            }}>{tx("Shu match bo‘yicha yuz ma’lumotlarini hozir o‘chirish")}</button>
          </div>
        )}
      </div>
      <div className="stack tk-side">
        <div className="card card-pad stack" style={{ gap: 10 }}>
          <h3>{tx("Holat")}</h3>
          <div className="tk-kv"><span>{tx("Faollashtirilgan (yuz)")}</span><b className="ok-text">{e.face_bound || 0} / {e.active || 0}</b></div>
          <div className="tk-kv"><span>{tx("Hujjat bilan")}</span><b>{e.document || 0}</b></div>
          <div className="tk-kv"><span>{tx("Havola yuborilgan, kutilmoqda")}</span><b className="warn-text">{e.awaiting || 0}</b></div>
          <div className="tk-kv"><span>{tx("Kirdi")}</span><b>{e.entered || 0}</b></div>
          <div className="tk-kv"><span>{tx("Rad etilgan urinishlar")}</span><b className="danger-text">{e.rejected || 0}</b></div>
        </div>
        <div className="card card-pad stack" style={{ gap: 10 }}>
          <h3>{tx("Shubhali urinishlar")}</h3>
          {(scans.data?.items || []).slice(0, 12).map((x) => <div key={x.id} className="tk-journal"><i className={`dot ${SCAN_RESULT[x.result]?.tone}`} /><span><b>{SCAN_RESULT[x.result]?.label || x.result}{x.score != null ? ` · ${x.score}%` : ""}</b><small>{x.ticket || x.detail} · {x.gate || "—"} · {fmtShort(x.at)} · {x.scanner}</small></span></div>)}
          {scans.data && !scans.data.items.length && <div className="muted small">{tx("Hozircha yo‘q")}</div>}
        </div>
      </div>
    </div>
  );
}

function EntryLog({ mid, v }: { mid: number; v: SaleView }) {
  const { data } = useLoad(() => api.get<{ items: { id: number; at: string; result: string; gate: string; detail: string; ticket: string; scanner: string; score?: number }[] }>(`/admin/ticket-scans?match_id=${mid}`), [mid]);
  return (
    <div className="stack">
      <div className="card tk-kpis"><div><b>{v.entry.entered || 0}</b><small>{tx("Kirdi")}</small></div><div><b>{v.entry.active || 0}</b><small>{tx("Faol chiptalar")}</small></div><div><b className="danger-text">{v.entry.rejected || 0}</b><small>{tx("Rad etilgan")}</small></div><div><b>{v.gates.join(", ") || "—"}</b><small>{tx("Darvozalar")}</small></div></div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>{tx("Vaqt")}</th><th>{tx("Natija")}</th><th>{tx("Chipta")}</th><th>{tx("Darvoza")}</th><th>{tx("Nazoratchi")}</th></tr></thead>
          <tbody>
            {(data?.items || []).map((x) => <tr key={x.id}><td>{fmtShort(x.at)}</td><td><Badge map={SCAN_RESULT} k={x.result} />{x.score != null && <small className="muted"> {x.score}%</small>}</td><td className="small">{x.ticket || x.detail}</td><td>{x.gate}</td><td>{x.scanner}</td></tr>)}
            {data && !data.items.length && <tr><td colSpan={5}><Empty title={tx("Hali skan yo‘q")} /></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BoxOffice({ v, mid, onClose }: { v: SaleView; mid: number; onClose: () => void }) {
  const toast = useToast();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+998 ");
  const [busy, setBusy] = useState(false);
  const total = v.zones.reduce((n, z) => n + (qty[z.zone_key] || 0) * z.price, 0);
  const sell = async () => {
    setBusy(true);
    try {
      await api.post("/admin/ticket-orders/box-office", { match_id: mid, buyer_name: name, phone, items: Object.entries(qty).filter(([, q]) => q > 0).map(([zone, q]) => ({ zone, qty: q })) });
      toast(tx("Sotildi — chiptalar SMS bilan yuborildi")); onClose();
    } catch (e) { toast(e instanceof ApiError ? Object.values(e.fields)[0] as string || e.message : tx("Xato"), "error"); } finally { setBusy(false); }
  };
  return (
    <Modal title={tx("Kassada sotish")} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>{tx("Bekor qilish")}</button><button className="btn btn-primary" disabled={busy || !total || name.trim().length < 3} onClick={sell}>{fmtUZS(total)}{" "}{tx("— naqd qabul qilindi")}</button></>}>
      <div className="stack">
        {v.zones.filter((z) => z.enabled).map((z) => (
          <div key={z.zone_key} className="tk-kv"><span><b>{z.title}</b>{" "}{tx("· {0} · qoldi", fmtUZS(z.price))}{" "}{z.left}</span>
            <input className="input input-sm" style={{ width: 80 }} type="number" min={0} max={z.left} value={qty[z.zone_key] || 0} onChange={(e) => setQty({ ...qty, [z.zone_key]: Math.max(0, Math.min(z.left, Number(e.target.value))) })} /></div>
        ))}
        <div className="form-grid">
          <Field label={tx("Xaridor ismi")}><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={tx("Telefon")} hint={tx("Chiptalar SMS bilan keladi")}><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

/* ================= C5 / C6 · one order ================= */
type OrderDetail = { order: OrderRow; email: string; telegram: boolean; provider_txn: string; card_mask: string; cancel_reason: string; tickets: TicketV[]; match: MatchInfo; history: { at: string; text: string; kind: string }[]; refund_deadline: string | null };

function OrderPage() {
  const { id } = useParams();
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api.get<OrderDetail>(`/admin/ticket-orders/${id}`), [id]);
  const [refund, setRefund] = useState(false);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const o = data.order;
  const canRefund = ["paid", "refund_requested", "partially_refunded"].includes(o.status) && data.tickets.some((t) => t.status === "active");
  return (
    <>
      <PageHead pre={<Link to="/tickets?tab=orders" className="muted"><I.back size={14} />{" "}{tx("Buyurtmalar")}</Link>} title={tx("Buyurtma {0}", o.number)}
        sub={`${fmtDateTime(o.created_at)} · ${data.match.title}${data.match.stage ? ", " + data.match.stage : ""} · ${o.source === "box_office" ? tx("Kassa") : tx("Sayt orqali")}`}
        actions={<>{["paid", "partially_refunded"].includes(o.status) && <button className="btn" onClick={async () => { try { await api.post(`/admin/ticket-orders/${o.id}/resend`); toast(tx("SMS qayta yuborildi")); } catch (e) { toast(e instanceof ApiError ? e.message : tx("Xato"), "error"); } }}>{tx("Chiptalarni qayta yuborish")}</button>}</>} />
      <div className={`tk-status ${o.status === "paid" ? "open" : o.status}`}>
        <Badge map={ORDER_STATUS} k={o.status} />
        <span className="grow"><b>{fmtUZS(o.total)} · {PROVIDER[o.provider] || "—"}{data.card_mask ? " · " + data.card_mask : ""}</b>
          <small>{data.provider_txn ? tx("Tranzaksiya: {0} · ", data.provider_txn) : ""}{o.paid_at ? fmtDateTime(o.paid_at) : o.hold_until ? tx("Band: {0} gacha", fmtShort(o.hold_until)) : ""}{o.refunded ? tx(" · qaytarilgan {0}", fmtUZS(o.refunded)) : ""}</small></span>
      </div>
      <div className="tk-cols">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h3>{tx("Chiptalar ({0})", data.tickets.length)}</h3><small className="muted">{tx("Har bir chipta — alohida QR")}</small></div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>{tx("Chipta №")}</th><th>{tx("Zona")}</th><th>{tx("O‘rin")}</th><th>{tx("Egasi")}</th><th>{tx("Yuz")}</th><th>{tx("Holat")}</th></tr></thead>
              <tbody>{data.tickets.map((t) => (
                <tr key={t.id}><td><b className="mono small">{t.number}</b></td><td><span className={`tk-kind ${t.zone_kind}`}>{t.zone_name}</span></td>
                  <td className="small">{t.section}{t.row ? tx(", {0}-qator", t.row) : ""}{t.seat ? tx(", {0}-o‘rin", t.seat) : t.row ? "" : tx(" · erkin")}</td>
                  <td>{t.holder_name || <span className="muted">—</span>}</td>
                  <td className="small">{t.face_status === "bound" ? tx("bog‘langan") : t.face_status === "document" ? tx("hujjat") : t.transfer_sent_at ? tx("havola yuborilgan") : "—"}</td>
                  <td><Badge map={TICKET_STATUS} k={t.status} />{t.used_at && <div className="muted small">{fmtShort(t.used_at)} · {t.used_gate}</div>}</td></tr>
              ))}</tbody>
            </table></div>
          </div>
          <div className="tk-2">
            <div className="card card-pad stack" style={{ gap: 10 }}>
              <h3>{tx("Xaridor")}</h3>
              <div className="tk-kv"><span>{tx("Ism")}</span><b>{o.buyer_name}</b></div>
              <div className="tk-kv"><span>{tx("Telefon")}</span><b>{o.phone}</b></div>
              <div className="tk-kv"><span>{tx("Email")}</span><b>{data.email || "—"}</b></div>
              <div className="tk-kv"><span>{tx("Telegram")}</span><b>{data.telegram ? tx("so‘ragan") : "—"}</b></div>
            </div>
            <div className="card card-pad stack" style={{ gap: 10 }}>
              <h3>{tx("Tarix")}</h3>
              {data.history.map((h, i) => <div key={i} className="tk-journal"><i className={`dot ${h.kind === "ok" ? "ok" : h.kind === "refund" ? "danger" : ""}`} /><span><b className="small">{h.text}</b><small>{fmtDateTime(h.at)}</small></span></div>)}
            </div>
          </div>
        </div>
        <div className="stack tk-side">
          <div className="card card-pad stack">
            <h3>{tx("To‘lov cheki")}</h3>
            <div className="tk-kv"><span>{tx("Buyurtma №")}</span><b>{o.number}</b></div>
            {Object.entries(data.tickets.reduce<Record<string, { n: number; sum: number }>>((m, t) => { m[t.zone_name] = { n: (m[t.zone_name]?.n || 0) + 1, sum: (m[t.zone_name]?.sum || 0) + t.price }; return m; }, {}))
              .map(([z, x]) => <div key={z} className="tk-kv"><span>{z} × {x.n}</span><b>{fmtUZS(x.sum)}</b></div>)}
            <div className="tk-kv total"><span>{tx("Jami")}</span><b>{fmtUZS(o.total)}</b></div>
          </div>
          <div className="card card-pad stack">
            <h3>{tx("Qaytarish")}</h3>
            <div className="muted small">{data.refund_deadline ? tx("Mijoz o‘zi {0} gacha so‘rov yubora oladi. ", fmtShort(data.refund_deadline)) : ""}{tx("Admin istalgan vaqtda qisman yoki to‘liq qaytaradi.")}</div>
            <button className="btn btn-danger" disabled={!canRefund} onClick={() => setRefund(true)}>{tx("Qaytarish…")}</button>
          </div>
        </div>
      </div>
      {refund && <RefundModal d={data} onClose={() => setRefund(false)} onDone={() => { setRefund(false); reload(); }} />}
    </>
  );
}

function RefundModal({ d, onClose, onDone }: { d: OrderDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const active = d.tickets.filter((t) => t.status === "active");
  const [ids, setIds] = useState<number[]>(active.map((t) => t.id));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const sum = useMemo(() => active.filter((t) => ids.includes(t.id)).reduce((n, t) => n + t.price, 0), [ids, active]);
  const card = ["payme", "click", "uzum"].includes(d.order.provider);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ refunded: number; note: string }>(`/admin/ticket-orders/${d.order.id}/refund`, { ticket_ids: ids, reason });
      toast(r.note || tx("{0} qaytarildi", fmtUZS(r.refunded))); onDone();
    } catch (e) { toast(e instanceof ApiError ? e.message : tx("Xato"), "error"); } finally { setBusy(false); }
  };
  return (
    <Modal title={tx("Qaytarishni tasdiqlang")} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>{tx("Bekor qilish")}</button><button className="btn btn-danger" disabled={busy || !ids.length} onClick={go}>{fmtUZS(sum)}{" "}{tx("qaytarish")}</button></>}>
      <div className="stack">
        <div className="muted small">{tx("Buyurtma {0} · {1}. Qaysi chiptalarni qaytarasiz?", d.order.number, d.order.buyer_name)}</div>
        <div className="tk-radio-list">
          {active.map((t) => (
            <label key={t.id} className={ids.includes(t.id) ? "on" : ""}><input type="checkbox" checked={ids.includes(t.id)} onChange={(e) => setIds(e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id))} />
              <span className="grow"><b>{t.number}</b><small>{t.zone_name} · {t.section}{t.row ? tx(", {0}-qator", t.row) : ""}{t.seat ? `, ${t.seat}` : ""}</small></span><b>{fmtUZS(t.price)}</b></label>
          ))}
        </div>
        <Field label={tx("Sabab")} hint={tx("Jurnalga yoziladi")}><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tx("Mijoz kela olmaydi")} /></Field>
        <div className="tk-sum"><div className="tk-kv"><span>{tx("Qaytariladigan summa")}</span><b>{fmtUZS(sum)}</b></div><div className="tk-kv"><span>{tx("Usul")}</span><b>{PROVIDER[d.order.provider]}{d.card_mask ? " → " + d.card_mask : ""}</b></div>
          <small>{card ? tx("Chiptalar QR-kodi darhol bekor qilinadi, o‘rinlar sotuvga qaytadi. Pulni to‘lov tizimi kabinetida qaytaring (Payme/Click) — 1–3 ish kuni.") : tx("Naqd pulni kassada qaytaring. QR-kodlar darhol bekor qilinadi.")}</small></div>
      </div>
    </Modal>
  );
}
