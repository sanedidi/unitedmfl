import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { api, ApiError } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import { PageHead } from "@/components/Layout";
import { Badge, Crest, ErrorBox, Field, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

import { tx } from "@/lib/i18n";
/* Tizim → Telegram stikerlar: team logos become one Telegram sticker set. */

export type StkStatus = "ready" | "queued" | "error" | "stale" | "no_logo" | "waiting";
export type StkItem = { status: StkStatus; image: string; attempts: number; last_error: string; updated_at: string | null; next_try_at: string | null };
export type StkTeam = StkItem & { team_id: number; name: string; short_name: string; crest_url: string; emoji: StkItem };
type Counts = Record<"teams" | "ready" | "queued" | "error" | "no_logo" | "stale", number>;
type SetView = { name: string; title: string; url: string; count: number };
type Person = { id: number; username: string; name: string; at?: string };
type State = {
  connected: boolean; token_broken: boolean; token_masked: string; bot_username: string; same_as_live: boolean;
  owner: Person | null; candidates: Person[];
  set_slug: string; set_title: string; set_url: string; sets: SetView[]; limit: number;
  outline: boolean; auto_update: boolean; enabled: boolean;
  problem: "" | "token_invalid" | "owner_blocked" | "telegram_down"; last_error: string;
  last_sync_at: string | null; next_retry_at: string | null;
  counts: Counts;
  emoji: { enabled: boolean; created: boolean; slug: string; title: string; outline: boolean; set_url: string; sets: SetView[]; limit: number; counts: Counts };
  teams: StkTeam[];
};

const errText = (e: unknown) => (e instanceof ApiError ? Object.values(e.fields)[0] as string || e.message : e instanceof Error ? e.message : tx("Xato"));
const who = (p: Person) => (p.username ? `@${p.username}` : p.name || String(p.id));

export const STK_LABEL: Record<StkStatus, string> = {
  ready: tx("Tayyor"), queued: tx("Navbatda"), error: tx("Xato"), stale: tx("Logotip o‘zgargan"), no_logo: tx("Logotip yo‘q"), waiting: "—",
};

export function StkStatusCell({ t, autoUpdate = true }: { t: StkItem; autoUpdate?: boolean }) {
  let sub = "";
  if (t.status === "queued" && t.attempts > 0) sub = tx("{0}-urinish: {1}", t.attempts, t.last_error);
  else if (t.status === "queued" && t.last_error) sub = t.last_error;
  else if (t.status === "error") sub = t.last_error;
  else if (t.status === "stale") sub = autoUpdate ? tx("Yangilanish navbatda") : tx("Avtomatik yangilash o‘chiq — ↻ tugmasini bosing");
  else if (t.status === "no_logo") sub = tx("Jamoa sahifasida yuklang");
  return (
    <div className="stk-status">
      <span className="row" style={{ gap: 8 }}><i className={`stk-dot ${t.status}`} />{STK_LABEL[t.status]}</span>
      {sub && <small>{sub}</small>}
    </div>
  );
}

export function StkTile({ t, size = 44 }: { t: { image: string; crest_url: string }; size?: number }) {
  const src = t.image || t.crest_url;
  return (
    <span className={`stk-tile${t.image ? "" : " pending"}`} style={{ width: size, height: size }}>
      {src ? <img src={src} alt="" /> : <I.image size={Math.round(size / 2.6)} />}
    </span>
  );
}

export function StickersPage() {
  const { data, error, loading, reload, setData } = useLoad(() => api.get<State>("/admin/tg-stickers"), []);
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "emoji" ? "emoji" : "stickers";
  const busy = !!data && (data.counts.queued > 0 || (data.emoji.enabled && data.emoji.counts.queued > 0) || (!data.enabled && data.connected && !data.owner));
  // live progress while something is queued or the owner is awaited
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => api.get<State>("/admin/tg-stickers").then(setData).catch(() => {}), data?.enabled ? 4000 : 3000);
    return () => clearInterval(t);
  }, [busy, data?.enabled, setData]);

  if (error) return <><PageHead title={tx("Telegram stikerlar")} /><div className="card card-pad"><ErrorBox error={error} retry={reload} /></div></>;
  if (loading && !data) return <><PageHead title={tx("Telegram stikerlar")} /><Loading /></>;
  if (!data) return null;
  if (!data.enabled) return <Setup s={data} set={setData} />;
  const tabs = (
    <div className="stk-tabs" role="tablist">
      {([["stickers", tx("Stikerlar"), <I.image size={16} />, data.counts.ready], ["emoji", tx("Emoji"), <I.ball size={16} />, data.emoji.counts.ready]] as const).map(([k, l, icon, n]) => (
        <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setParams(k === "emoji" ? { tab: "emoji" } : {}, { replace: true })}>
          {icon}{l}<span>{n}</span>
        </button>
      ))}
    </div>
  );
  if (tab === "emoji") return data.emoji.created ? <EmojiConnected s={data} set={setData} tabs={tabs} /> : <EmojiSetup s={data} set={setData} tabs={tabs} />;
  return <Connected s={data} set={setData} tabs={tabs} />;
}

function Problems({ s, set }: { s: State; set: (v: State) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function retryNow() {
    setBusy(true);
    try { set(await api.post<State>("/admin/tg-stickers/sync")); toast(tx("Qayta urinilmoqda")); } catch (e) { toast(errText(e), "error"); } finally { setBusy(false); }
  }
  const out: ReactNode[] = [];
  const bot = s.bot_username ? `https://t.me/${s.bot_username}` : "";
  if (s.token_broken) out.push(<Banner key="tb" danger icon={<I.alert size={18} />} text={tx("Saqlangan tokenni ochib bo‘lmadi (serverdagi maxfiy kalit o‘zgargan). Tokenni qayta kiriting.")} />);
  if (s.problem === "token_invalid") out.push(<Banner key="ti" danger icon={<I.alert size={18} />} text={tx("Bot tokeni yaroqsiz yoki bekor qilingan. Stikerlar yangilanmayapti.")} action={<a className="btn" href="#tg-connection">{tx("Tokenni almashtirish")}</a>} />);
  if (s.problem === "owner_blocked") out.push(<Banner key="ob" danger icon={<I.alert size={18} />} text={tx("To‘plam egasi botni to‘xtatgan. Egasi botga qayta /start yuborishi kerak.")} action={bot ? <a className="btn" href={bot} target="_blank" rel="noreferrer">{tx("Botni ochish")}</a> : undefined} />);
  if (s.problem === "telegram_down") {
    const n = s.counts.queued;
    out.push(<Banner key="td" icon={<I.refresh size={18} />} text={tx("Telegram vaqtincha javob bermayapti. {0} ta stiker navbatda{1}.", n, s.next_retry_at ? `, keyingi urinish ${fmtDateTime(s.next_retry_at)} da` : "")} action={<button className="btn" disabled={busy} onClick={retryNow}>{tx("Hozir urinish")}</button>} />);
  }
  if (!s.problem && s.last_error) out.push(<Banner key="le" icon={<I.alert size={18} />} text={s.last_error} />);
  const last = s.sets[s.sets.length - 1];
  if (last && last.count >= s.limit) out.push(<Banner key="full" icon={<I.doc size={18} />} text={tx("To‘plam to‘ldi ({0} / {1}). Yangi jamoalar keyingi to‘plamga qo‘shiladi.", last.count, s.limit)} />);
  return out.length ? <div className="stack" style={{ gap: 12, marginBottom: 16 }}>{out}</div> : null;
}

function Banner({ text, action, danger, icon }: { text: string; action?: ReactNode; danger?: boolean; icon: ReactNode }) {
  return <div className={`stk-banner${danger ? " danger" : ""}`}>{icon}<span className="grow">{text}</span>{action}</div>;
}

/* ---------- T1: connected ---------- */

type Filter = "all" | "ready" | "queued" | "error" | "no_logo";

function Connected({ s, set, tabs }: { s: State; set: (v: State) => void; tabs: ReactNode }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => toast(errText(e), "error");

  async function sync() {
    setBusy(true);
    try { set(await api.post<State>("/admin/tg-stickers/sync")); toast(tx("Sinxronlash boshlandi: {0} ta jamoa", s.counts.teams)); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function retry(t: StkTeam) {
    try { set(await api.post<State>(`/admin/tg-stickers/teams/${t.team_id}/retry`)); toast(tx("{0}: navbatga qo‘yildi", t.name)); } catch (e) { fail(e); }
  }
  const inFilter = (t: StkTeam) => filter === "all" || t.status === filter || (filter === "queued" && t.status === "stale");
  const rows = s.teams.filter((t) => inFilter(t) && (!q.trim() || t.name.toLowerCase().includes(q.trim().toLowerCase())));
  const chips: [Filter, string, number][] = [
    ["all", tx("Hammasi"), s.counts.teams], ["ready", tx("Tayyor"), s.counts.ready], ["queued", tx("Navbatda"), s.counts.queued + s.counts.stale],
    ["error", tx("Xato"), s.counts.error], ["no_logo", tx("Logotip yo‘q"), s.counts.no_logo],
  ];

  return (
    <>
      <PageHead
        title={tx("Telegram stikerlar")}
        sub={tx("Jamoa logotiplari avtomatik ravishda Telegram stiker va emoji to‘plamlariga qo‘shiladi")}
        actions={<>
          <button className="btn btn-dark" disabled={busy} onClick={sync}><I.refresh size={16} />{" "}{tx("Hammasini sinxronlash")}</button>
          {s.set_url && <a className="btn btn-primary" href={s.set_url} target="_blank" rel="noreferrer">{tx("To‘plamni ochish")}</a>}
        </>}
      />
      {tabs}
      <Problems s={s} set={set} />
      <div className="stk-cols">
        <div className="stack">
          <div className="card stk-stats">
            {[[s.counts.teams, tx("Jamoalar")], [s.counts.ready, tx("Stiker tayyor")], [s.counts.queued + s.counts.stale, tx("Navbatda")], [s.counts.error, tx("Xato")]].map(([v, l]) => (
              <div key={l}><b>{v}</b><small>{l}</small></div>
            ))}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <div className="search" style={{ width: 260 }}><I.search size={16} /><input className="input" aria-label={tx("Qidirish")} placeholder={tx("Jamoa qidirish…")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
            {chips.map(([k, l, n]) => (
              <button key={k} className={`stk-chip${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{l} <span>{n}</span></button>
            ))}
          </div>
          <div className="card">
            <div className="table-wrap"><table className="table">
              <thead><tr><th>{tx("Jamoa")}</th><th>{tx("Stiker")}</th><th>{tx("Holat")}</th><th className="hide-mobile">{tx("Yangilangan")}</th><th /></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.team_id}>
                    <td><span className="row"><Crest team={{ id: t.team_id, name: t.name, short_name: t.short_name, crest_url: t.crest_url }} size={24} /><b>{t.name}</b></span></td>
                    <td style={{ width: 80 }}>{t.status === "no_logo" ? <span className="stk-tile nologo"><I.image size={18} /></span> : <StkTile t={t} />}</td>
                    <td><StkStatusCell t={t} autoUpdate={s.auto_update} /></td>
                    <td className="hide-mobile nowrap">{t.status === "ready" || t.status === "stale" ? fmtDateTime(t.updated_at) : "—"}</td>
                    <td className="nowrap" style={{ textAlign: "right" }}>
                      {t.status === "no_logo"
                        ? <Link className="btn btn-ghost btn-icon" title={tx("Logotip yuklash")} aria-label={tx("Logotip yuklash")} to={`/teams/${t.team_id}`}><I.upload size={16} /></Link>
                        : <button className="btn btn-ghost btn-icon" title={t.status === "ready" ? tx("Qayta yaratish") : tx("Qayta urinish")} aria-label={tx("Qayta yaratish")} onClick={() => retry(t)}><I.refresh size={16} /></button>}
                    </td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 32 }}>{tx("Jamoa topilmadi")}</td></tr>}
              </tbody>
            </table></div>
          </div>
        </div>
        <aside className="stack">
          <ConnectionCard s={s} set={set} />
          <LookCard s={s} set={set} />
          <div className="stk-note"><I.telegram size={16} /><span>{tx("To‘plam Telegram’da ochiq: havola orqali istalgan foydalanuvchi qo‘sha oladi.")}</span></div>
        </aside>
      </div>
    </>
  );
}

function ConnectionCard({ s, set }: { s: State; set: (v: State) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(s.problem === "token_invalid" || s.token_broken);
  const [title, setTitle] = useState(s.set_title);
  const total = s.sets.reduce((a, x) => a + x.count, 0);
  async function saveTitle() {
    if (title.trim() === s.set_title) return;
    try { set(await api.patch<State>("/admin/tg-stickers", { set_title: title.trim() })); toast(tx("To‘plam nomi yangilandi")); } catch (e) { toast(errText(e), "error"); setTitle(s.set_title); }
  }
  async function disconnect() {
    if (!(await confirm({ title: tx("Ulanishni uzish"), text: tx("Telegram’dagi to‘plam o‘chmaydi, lekin endi yangilanmaydi. Qayta ulansangiz, to‘plam qaytadan yaratiladi."), ok: tx("Uzish"), danger: true }))) return;
    try { set(await api.del<State>("/admin/tg-stickers")); toast(tx("Uzildi")); } catch (e) { toast(errText(e), "error"); }
  }
  const ok = !s.problem && !s.token_broken;
  return (
    <div className="card" id="tg-connection">
      <div className="card-head"><h2>{tx("Ulanish")}</h2><span className="row small b" style={{ gap: 6 }}><i className={`stk-dot ${ok ? "ready" : "error"}`} />{ok ? tx("Ulangan") : tx("Muammo bor")}</span></div>
      <div className="stk-kv">
        <div><span>{tx("Bot")}</span><b>@{s.bot_username}</b></div>
        <div><span>{tx("To‘plam egasi")}</span><b>{s.owner ? who(s.owner) : "—"}</b></div>
        <div><span>{tx("To‘plam")}</span><b>{s.set_title}</b></div>
        <div><span>{tx("Stikerlar")}</span><b>{total} / {s.limit * Math.max(1, s.sets.length)}</b></div>
        <div><span>{tx("Oxirgi sinxronlash")}</span><b>{fmtDateTime(s.last_sync_at)}</b></div>
      </div>
      {s.sets.map((x) => (
        <a key={x.name} className="stk-link" href={x.url} target="_blank" rel="noreferrer"><span className="grow">{x.url.replace("https://", "")}</span><I.link size={16} /></a>
      ))}
      <div className="card-pad stack" style={{ gap: 12 }}>
        <button className="btn" onClick={() => setOpen(!open)}><I.edit size={16} />{" "}{tx("Ulanishni sozlash")}</button>
        {open && <>
          <Field label={tx("To‘plam nomi")} hint={tx("Telegram’da ko‘rinadi")}><input className="input" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} /></Field>
          <TokenForm s={s} set={set} />
          <button className="btn btn-ghost" style={{ color: "var(--red-600)" }} onClick={disconnect}><I.x size={16} />{" "}{tx("Ulanishni uzish")}</button>
        </>}
      </div>
    </div>
  );
}

function LookCard({ s, set }: { s: State; set: (v: State) => void }) {
  const toast = useToast();
  const withLogo = s.teams.filter((t) => t.crest_url);
  const [teamId, setTeamId] = useState<number>(withLogo[0]?.team_id || 0);
  const [img, setImg] = useState("");
  useEffect(() => {
    if (!teamId) return;
    let live = true;
    api.post<{ image: string }>("/admin/tg-stickers/preview", { team_id: teamId, outline: s.outline }).then((r) => live && setImg(r.image)).catch(() => live && setImg(""));
    return () => { live = false; };
  }, [teamId, s.outline]);
  async function patch(b: Partial<Pick<State, "outline" | "auto_update">>) {
    try {
      set(await api.patch<State>("/admin/tg-stickers", b));
      if (b.outline !== undefined) toast(tx("Barcha stikerlar qayta chiziladi"));
    } catch (e) { toast(errText(e), "error"); }
  }
  return (
    <div className="card">
      <div className="card-head"><h2>{tx("Stiker ko‘rinishi")}</h2>
        {withLogo.length > 1 && (
          <select className="input input-sm" style={{ width: 140 }} value={teamId} onChange={(e) => setTeamId(Number(e.target.value))} aria-label={tx("Jamoa")}>
            {withLogo.map((t) => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
          </select>
        )}
      </div>
      <div className="card-pad stack" style={{ gap: 14 }}>
        <div className="stk-previews">
          {(["light", "dark"] as const).map((m) => (
            <div key={m} className={`stk-preview ${m}`}>
              {img ? <img src={img} alt="" /> : <span className="muted small">…</span>}
              <small>{m === "light" ? tx("Yorug‘ mavzu") : tx("Qorong‘i mavzu")}</small>
            </div>
          ))}
        </div>
        <label className="toggle-row"><span><b>{tx("Oq kontur")}</b><small>{tx("Qorong‘i mavzuda logotip yo‘qolib ketmaydi")}</small></span><input type="checkbox" className="switch" checked={s.outline} onChange={(e) => patch({ outline: e.target.checked })} /></label>
        <label className="toggle-row"><span><b>{tx("Avtomatik yangilash")}</b><small>{tx("Logotip o‘zgarsa, stiker o‘zi almashadi")}</small></span><input type="checkbox" className="switch" checked={s.auto_update} onChange={(e) => patch({ auto_update: e.target.checked })} /></label>
        <p className="muted small" style={{ margin: 0 }}>{tx("Oq fon avtomatik olib tashlanadi: logotip ichidagi oq qismlar saqlanadi.")}</p>
      </div>
    </div>
  );
}

function TokenForm({ s, set, onSaved }: { s: State; set: (v: State) => void; onSaved?: () => void }) {
  const toast = useToast();
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setErr("");
    try {
      const v = await api.put<State>("/admin/tg-stickers/token", { token: token.trim() });
      if (s.enabled && !v.enabled) toast(tx("Boshqa bot ulandi: to‘plamni qaytadan yaratish kerak"));
      else toast(tx("Bot topildi: @{0}", v.bot_username));
      set(v);
      setToken("");
      onSaved?.();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack" style={{ gap: 10 }}>
      <Field label={tx("Bot tokeni")} error={err} hint={tx("Token shifrlangan holda saqlanadi va brauzerga qaytarilmaydi")}>
        <input className="input" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.connected ? s.token_masked : "123456789:AA…"} autoComplete="off" spellCheck={false} />
      </Field>
      <div className="row"><button className="btn btn-primary" disabled={busy || token.trim().length < 30} onClick={save}>{busy ? tx("Tekshirilmoqda…") : s.connected ? tx("Tokenni almashtirish") : tx("Tekshirish va saqlash")}</button></div>
    </div>
  );
}

/* ---------- T2: not connected yet ---------- */

function Setup({ s, set }: { s: State; set: (v: State) => void }) {
  const toast = useToast();
  const [slug, setSlug] = useState(s.set_slug);
  const [title, setTitle] = useState(s.set_title);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSlug(s.set_slug); setTitle(s.set_title); }, [s.set_slug, s.set_title]);
  const withLogo = s.teams.filter((t) => t.crest_url).length;
  const bot = s.bot_username;
  const fullName = bot ? tx("{0}_by_{1}", slug || "…", bot) : "";

  async function saveSet(): Promise<boolean> {
    if (slug === s.set_slug && title === s.set_title) return true;
    try {
      set(await api.patch<State>("/admin/tg-stickers", { set_slug: slug.trim().toLowerCase(), set_title: title.trim() }));
      setErrs({});
      return true;
    } catch (e) {
      setErrs(e instanceof ApiError ? Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, String(v)])) : {});
      if (!(e instanceof ApiError && Object.keys(e.fields).length)) toast(errText(e), "error");
      return false;
    }
  }
  async function choose(p: Person) {
    try { set(await api.put<State>("/admin/tg-stickers/owner", { tg_user_id: p.id })); toast(tx("To‘plam egasi: {0}", who(p))); } catch (e) { toast(errText(e), "error"); }
  }
  async function create() {
    setBusy(true);
    try {
      if (!(await saveSet())) return;
      set(await api.post<State>("/admin/tg-stickers/create"));
      toast(tx("To‘plam yaratildi"));
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  const ready = s.connected && !!s.owner && !s.token_broken;

  return (
    <>
      <PageHead title={tx("Telegram stikerlar")} sub={tx("Jamoa logotiplari avtomatik ravishda Telegram stiker to‘plamiga qo‘shiladi")} />
      <Problems s={s} set={set} />
      <div className="stk-cols">
        <div className="card">
          <div className="card-head"><h2>{tx("Telegram’ga ulash")}</h2><span className="row small b muted" style={{ gap: 6 }}><i className="stk-dot waiting" />{tx("Ulanmagan")}</span></div>
          <Step n={1} done={s.connected && !s.token_broken} title={tx("Bot tokeni")} sub="@BotFather bergan tokenni kiriting. Live-pult boti yoki alohida bot bo‘lishi mumkin.">
            <TokenForm s={s} set={set} />
            {s.connected && !s.token_broken && <div className="row b small"><i className="stk-dot ready" />{tx("Bot topildi: @")}{bot}{s.same_as_live && <span className="muted" style={{ fontWeight: 400 }}>{" "}{tx("· Live-pult boti bilan bir xil")}</span>}</div>}
          </Step>
          <Step n={2} done={!!s.owner} title={tx("To‘plam egasi")} sub={tx("To‘plam shu Telegram-akkauntga yoziladi. Egasi bo‘ladigan akkauntdan botga /start yuboring — bot uni o‘zi aniqlaydi.")} disabled={!s.connected}>
            {s.owner ? (
              <div className="stk-person"><i className="stk-dot ready" /><span className="grow"><b>{who(s.owner)}</b>{s.owner.name && s.owner.username && <small>{s.owner.name}</small>}</span><Badge tone="ok">{tx("Egasi")}</Badge></div>
            ) : s.connected && (
              <>
                {s.candidates.map((p) => (
                  <div key={p.id} className="stk-person"><I.user size={16} /><span className="grow"><b>{who(p)}</b><small>{p.name && p.username ? `${p.name} · ` : ""}{tx("/start:")}{" "}{fmtDateTime(p.at)}</small></span><button className="btn btn-sm btn-primary" onClick={() => choose(p)}>{tx("Egasi qilish")}</button></div>
                ))}
                <div className="stk-waiting"><i className="stk-dot queued" /><span className="grow">{s.candidates.length ? tx("Kerakli akkaunt ro‘yxatda bo‘lmasa, undan botga /start yuboring") : tx("Kutilmoqda: botga hali /start yuborilmagan")}</span>{bot && <a className="btn btn-sm" href={`https://t.me/${bot}?start=stickers`} target="_blank" rel="noreferrer">{tx("Botni ochish")}</a>}</div>
              </>
            )}
          </Step>
          <Step n={3} done={false} title={tx("To‘plam")} sub={tx("Nom Telegram’da ko‘rinadi. Havolani to‘plam yaratilgandan keyin o‘zgartirib bo‘lmaydi.")}>
            <div className="form-grid">
              <Field label={tx("To‘plam nomi")} error={errs.set_title}><input className="input" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} onBlur={saveSet} /></Field>
              <Field label={tx("Havola")} error={errs.set_slug} hint={fullName ? `t.me/addstickers/${fullName}` : tx("Bot ulangach to‘liq havola ko‘rinadi")}>
                <input className="input" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} onBlur={saveSet} spellCheck={false} />
              </Field>
            </div>
          </Step>
          <div className="stk-foot">
            <span className="grow muted">{s.counts.teams}{" "}{tx("ta jamoadan {0} tasida logotip bor — {1} ta stiker yaratiladi", withLogo, withLogo)}</span>
            <button className="btn btn-primary" disabled={!ready || busy || !withLogo} onClick={create}>{busy ? tx("Yaratilmoqda…") : tx("To‘plamni yaratish")}</button>
          </div>
        </div>
        <aside className="stack">
          <div className="card">
            <div className="card-head"><h2>{tx("Qanday ishlaydi")}</h2></div>
            <ol className="stk-how">
              <li>{tx("Jamoa qo‘shilsa — stiker to‘plamga qo‘shiladi")}</li>
              <li>{tx("Logotip o‘zgarsa — stiker almashtiriladi")}</li>
              <li>{tx("Jamoa o‘chirilsa — stiker olib tashlanadi")}</li>
              <li>{tx("Telegram javob bermasa — navbatga tushadi va qayta uriniladi")}</li>
            </ol>
          </div>
          <div className="card">
            <div className="card-head"><h2>{tx("Stiker talablari")}</h2></div>
            <div className="stk-kv">
              <div><span>{tx("Format")}</span><b>{tx("PNG")}</b></div>
              <div><span>{tx("O‘lcham")}</span><b>{tx("512 × 512 px")}</b></div>
              <div><span>{tx("Fon")}</span><b>{tx("Shaffof (oq fon olib tashlanadi)")}</b></div>
              <div><span>{tx("Hajm")}</span><b>{tx("512 KB gacha")}</b></div>
            </div>
          </div>
          <div className="stk-note"><I.lock size={16} /><span>{tx("Shaxsiy Telegram-akkauntga kirish shart emas: faqat bot tokeni va /start yetarli.")}</span></div>
        </aside>
      </div>
    </>
  );
}

function Step({ n, done, title, sub, disabled, children }: { n: number; done: boolean; title: string; sub: string; disabled?: boolean; children?: ReactNode }) {
  return (
    <div className={`stk-step${disabled ? " disabled" : ""}`}>
      <span className={`stk-num${done ? " done" : ""}`}>{done ? <I.check size={14} /> : n}</span>
      <div className="grow stack" style={{ gap: 14 }}>
        <div><h3>{title}</h3><p>{sub}</p></div>
        {!disabled && children}
      </div>
    </div>
  );
}

/* ---------- E1 / E2: emoji ---------- */

/** A Telegram-like message with the emoji inline, in a light or dark chat. */
function ChatPreview({ img, img2, dark }: { img: string; img2?: string; dark?: boolean }) {
  const e = (src?: string) => (src ? <img src={src} alt="" className="stk-inline" /> : <span className="stk-inline empty" />);
  return (
    <div className={`stk-chat${dark ? " dark" : ""}`}>
      <div className="stk-bubble">{tx("Gol!")}{" "}{e(img)} 2 : 1 {e(img2 || img)}</div>
      <small>{dark ? tx("Qorong‘i mavzu") : tx("Yorug‘ mavzu")}</small>
    </div>
  );
}

function useEmojiPreview(teamId: number, outline: boolean) {
  const [img, setImg] = useState("");
  useEffect(() => {
    if (!teamId) return;
    let live = true;
    api.post<{ image: string }>("/admin/tg-stickers/preview", { team_id: teamId, outline, kind: "emoji" }).then((r) => live && setImg(r.image)).catch(() => live && setImg(""));
    return () => { live = false; };
  }, [teamId, outline]);
  return img;
}

const PREMIUM_NOTE = tx("Emoji’ni yuborish va to‘plamni qo‘shish faqat Telegram Premium foydalanuvchilariga ochiq. Boshqalar ularni xabarlarda ko‘radi.");

function EmojiConnected({ s, set, tabs }: { s: State; set: (v: State) => void; tabs: ReactNode }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => toast(errText(e), "error");
  const e = s.emoji;
  async function sync() {
    setBusy(true);
    try { set(await api.post<State>("/admin/tg-stickers/sync")); toast(tx("Sinxronlash boshlandi: {0} ta jamoa", e.counts.teams)); } catch (x) { fail(x); } finally { setBusy(false); }
  }
  async function retry(t: StkTeam) {
    try { set(await api.post<State>(`/admin/tg-stickers/teams/${t.team_id}/retry?kind=emoji`)); toast(tx("{0}: navbatga qo‘yildi", t.name)); } catch (x) { fail(x); }
  }
  async function patch(b: Record<string, unknown>, msg?: string) {
    try { set(await api.patch<State>("/admin/tg-stickers", b)); if (msg) toast(msg); } catch (x) { fail(x); }
  }
  const inFilter = (t: StkTeam) => filter === "all" || t.emoji.status === filter || (filter === "queued" && t.emoji.status === "stale");
  const rows = s.teams.filter((t) => inFilter(t) && (!q.trim() || t.name.toLowerCase().includes(q.trim().toLowerCase())));
  const chips: [Filter, string, number][] = [
    ["all", tx("Hammasi"), e.counts.teams], ["ready", tx("Tayyor"), e.counts.ready], ["queued", tx("Navbatda"), e.counts.queued + e.counts.stale],
    ["error", tx("Xato"), e.counts.error], ["no_logo", tx("Logotip yo‘q"), e.counts.no_logo],
  ];
  const withLogo = s.teams.filter((t) => t.crest_url);
  const [teamId, setTeamId] = useState<number>(withLogo[0]?.team_id || 0);
  const img = useEmojiPreview(teamId, e.outline);
  const img2 = withLogo.find((t) => t.team_id !== teamId)?.emoji.image;
  const total = e.sets.reduce((a, x) => a + x.count, 0);
  const ok = !s.problem && !s.token_broken;

  return (
    <>
      <PageHead
        title={tx("Telegram stikerlar")}
        sub={tx("Jamoa logotiplari avtomatik ravishda Telegram stiker va emoji to‘plamlariga qo‘shiladi")}
        actions={<>
          <button className="btn btn-dark" disabled={busy} onClick={sync}><I.refresh size={16} />{" "}{tx("Hammasini sinxronlash")}</button>
          {e.set_url && <a className="btn btn-primary" href={e.set_url} target="_blank" rel="noreferrer">{tx("To‘plamni ochish")}</a>}
        </>}
      />
      {tabs}
      <Problems s={s} set={set} />
      {!e.enabled && <div className="stack" style={{ marginBottom: 16 }}><Banner icon={<I.alert size={18} />} text={tx("Emoji o‘chirilgan: to‘plam Telegram’da qoladi, lekin jamoalar o‘zgarsa yangilanmaydi.")} action={<button className="btn" onClick={() => patch({ emoji_enabled: true }, tx("Emoji yoqildi"))}>{tx("Yoqish")}</button>} /></div>}
      <div className="stk-cols">
        <div className="stack">
          <div className="card stk-stats">
            {[[e.counts.teams, tx("Jamoalar")], [e.counts.ready, tx("Emoji tayyor")], [e.counts.queued + e.counts.stale, tx("Navbatda")], [e.counts.error, tx("Xato")]].map(([v, l]) => (
              <div key={l}><b>{v}</b><small>{l}</small></div>
            ))}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <div className="search" style={{ width: 260 }}><I.search size={16} /><input className="input" aria-label={tx("Qidirish")} placeholder={tx("Jamoa qidirish…")} value={q} onChange={(x) => setQ(x.target.value)} /></div>
            {chips.map(([k, l, n]) => (
              <button key={k} className={`stk-chip${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{l} <span>{n}</span></button>
            ))}
          </div>
          <div className="card">
            <div className="table-wrap"><table className="table">
              <thead><tr><th>{tx("Jamoa")}</th><th>{tx("Emoji")}</th><th className="hide-mobile">{tx("Matnda")}</th><th>{tx("Holat")}</th><th className="hide-mobile">{tx("Yangilangan")}</th><th /></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.team_id}>
                    <td><span className="row"><Crest team={{ id: t.team_id, name: t.name, short_name: t.short_name, crest_url: t.crest_url }} size={24} /><b>{t.name}</b></span></td>
                    <td style={{ width: 64 }}>{t.emoji.status === "no_logo" ? <span className="stk-tile nologo" style={{ width: 36, height: 36 }}><I.image size={16} /></span> : <StkTile t={{ image: t.emoji.image, crest_url: t.crest_url }} size={36} />}</td>
                    <td className="hide-mobile" style={{ width: 110 }}>{t.emoji.image ? <span className="row" style={{ gap: 10 }}><img className="stk-inline" src={t.emoji.image} alt="" /><img src={t.emoji.image} alt="" style={{ width: 32, height: 32 }} /></span> : <span className="muted">—</span>}</td>
                    <td><StkStatusCell t={t.emoji} autoUpdate={s.auto_update} /></td>
                    <td className="hide-mobile nowrap">{t.emoji.status === "ready" || t.emoji.status === "stale" ? fmtDateTime(t.emoji.updated_at) : "—"}</td>
                    <td className="nowrap" style={{ textAlign: "right" }}>
                      {t.emoji.status === "no_logo"
                        ? <Link className="btn btn-ghost btn-icon" title={tx("Logotip yuklash")} aria-label={tx("Logotip yuklash")} to={`/teams/${t.team_id}`}><I.upload size={16} /></Link>
                        : <button className="btn btn-ghost btn-icon" title={t.emoji.status === "ready" ? tx("Qayta yaratish") : tx("Qayta urinish")} aria-label={tx("Qayta yaratish")} disabled={!e.enabled} onClick={() => retry(t)}><I.refresh size={16} /></button>}
                    </td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={6} className="muted" style={{ textAlign: "center", padding: 32 }}>{tx("Jamoa topilmadi")}</td></tr>}
              </tbody>
            </table></div>
          </div>
        </div>
        <aside className="stack">
          <div className="card">
            <div className="card-head"><h2>{tx("Emoji to‘plami")}</h2><span className="row small b" style={{ gap: 6 }}><i className={`stk-dot ${e.enabled && ok ? "ready" : e.enabled ? "error" : "waiting"}`} />{!e.enabled ? tx("O‘chirilgan") : ok ? tx("Yoqilgan") : tx("Muammo bor")}</span></div>
            <div className="stk-kv">
              <div><span>{tx("To‘plam")}</span><b>{e.title}</b></div>
              <div><span>{tx("Emoji")}</span><b>{total} / {e.limit * Math.max(1, e.sets.length)}</b></div>
              <div><span>{tx("Egasi")}</span><b>{s.owner ? who(s.owner) : "—"}</b></div>
              <div><span>{tx("Oxirgi sinxronlash")}</span><b>{fmtDateTime(s.last_sync_at)}</b></div>
            </div>
            {e.sets.map((x) => (
              <a key={x.name} className="stk-link" href={x.url} target="_blank" rel="noreferrer"><span className="grow">{x.url.replace("https://", "")}</span><I.link size={16} /></a>
            ))}
            <div className="card-pad" style={{ borderTop: "1px solid var(--border)" }}>
              <label className="toggle-row"><span><b>{tx("Emoji’ni yoqish")}</b><small>{tx("O‘chirilsa, to‘plam Telegram’da qoladi, lekin yangilanmaydi")}</small></span><input type="checkbox" className="switch" checked={e.enabled} onChange={(x) => patch({ emoji_enabled: x.target.checked }, x.target.checked ? tx("Emoji yoqildi") : tx("Emoji o‘chirildi"))} /></label>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>{tx("Emoji ko‘rinishi")}</h2>
              {withLogo.length > 1 && (
                <select className="input input-sm" style={{ width: 140 }} value={teamId} onChange={(x) => setTeamId(Number(x.target.value))} aria-label={tx("Jamoa")}>
                  {withLogo.map((t) => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
                </select>
              )}
            </div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              <ChatPreview img={img} img2={img2} />
              <ChatPreview img={img} img2={img2} dark />
              <div className="stk-sizes">
                {([[20, tx("Matnda")], [32, tx("Tanlovda")], [48, tx("Katta")]] as const).map(([px, l]) => (
                  <div key={px}>{img ? <img src={img} alt="" style={{ width: px, height: px }} /> : <span style={{ width: px, height: px }} />}<small>{l}</small></div>
                ))}
              </div>
              <label className="toggle-row"><span><b>{tx("Ingichka oq kontur")}</b><small>{tx("2 px — kichik o‘lchamda ham logotip ko‘rinadi")}</small></span><input type="checkbox" className="switch" checked={e.outline} onChange={(x) => patch({ emoji_outline: x.target.checked }, tx("Barcha emoji qayta chiziladi"))} /></label>
              <label className="toggle-row"><span><b>{tx("Avtomatik yangilash")}</b><small>{tx("Stikerlar bilan umumiy sozlama")}</small></span><input type="checkbox" className="switch" checked={s.auto_update} onChange={(x) => patch({ auto_update: x.target.checked })} /></label>
            </div>
          </div>
          <div className="stk-note"><I.alert size={16} /><span>{PREMIUM_NOTE}</span></div>
        </aside>
      </div>
    </>
  );
}

function EmojiSetup({ s, set, tabs }: { s: State; set: (v: State) => void; tabs: ReactNode }) {
  const toast = useToast();
  const e = s.emoji;
  const [slug, setSlug] = useState(e.slug);
  const [title, setTitle] = useState(e.title);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSlug(e.slug); setTitle(e.title); }, [e.slug, e.title]);
  const withLogo = s.teams.filter((t) => t.crest_url);
  const img = useEmojiPreview(withLogo[0]?.team_id || 0, e.outline);
  const img2 = useEmojiPreview(withLogo[1]?.team_id || withLogo[0]?.team_id || 0, e.outline);

  async function save(extra: Record<string, unknown> = {}): Promise<boolean> {
    const body: Record<string, unknown> = { ...extra };
    if (slug !== e.slug) body.emoji_slug = slug.trim().toLowerCase();
    if (title !== e.title) body.emoji_title = title.trim();
    if (!Object.keys(body).length) return true;
    try {
      set(await api.patch<State>("/admin/tg-stickers", body));
      setErrs({});
      return true;
    } catch (x) {
      if (x instanceof ApiError && Object.keys(x.fields).length) setErrs(Object.fromEntries(Object.entries(x.fields).map(([k, v]) => [k, String(v)])));
      else toast(errText(x), "error");
      return false;
    }
  }
  async function create() {
    setBusy(true);
    try {
      if (!(await save())) return;
      set(await api.post<State>("/admin/tg-stickers/emoji/create"));
      toast(tx("Emoji to‘plami yaratildi"));
    } catch (x) {
      if (x instanceof ApiError && Object.keys(x.fields).length) setErrs(Object.fromEntries(Object.entries(x.fields).map(([k, v]) => [k, String(v)])));
      else toast(errText(x), "error");
    } finally {
      setBusy(false);
    }
  }
  const full = s.bot_username ? `t.me/addemoji/${slug || "…"}_by_${s.bot_username}` : "";
  return (
    <>
      <PageHead title={tx("Telegram stikerlar")} sub={tx("Jamoa logotiplari avtomatik ravishda Telegram stiker va emoji to‘plamlariga qo‘shiladi")} />
      {tabs}
      <Problems s={s} set={set} />
      <div className="stk-cols">
        <div className="card">
          <div className="card-head"><h2>{tx("Emoji to‘plamini yaratish")}</h2><span className="row small b muted" style={{ gap: 6 }}><i className="stk-dot waiting" />{tx("Yoqilmagan")}</span></div>
          <div className="stk-intro">
            <div className="stk-strip">
              {withLogo.slice(0, 6).map((t) => <span key={t.team_id}>{t.image || t.crest_url ? <img src={t.image || t.crest_url} alt="" /> : null}</span>)}
            </div>
            <div className="grow">
              <h3>{tx("Stikerlar bilan bir xil bot va egasi ishlatiladi")}</h3>
              <p>{tx("Logotiplar 100 × 100 ga joylanadi, oq fon olib tashlanadi. Jamoalar o‘zgarsa, emoji ham o‘zi yangilanadi.")}</p>
            </div>
          </div>
          <div className="card-pad stack" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="form-grid">
              <Field label={tx("To‘plam nomi")} error={errs.emoji_title}><input className="input" value={title} maxLength={60} onChange={(x) => setTitle(x.target.value)} onBlur={() => save()} /></Field>
              <Field label={tx("Havola")} error={errs.emoji_slug} hint={full}>
                <input className="input" value={slug} onChange={(x) => setSlug(x.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} onBlur={() => save()} spellCheck={false} />
              </Field>
            </div>
            <label className="toggle-row"><span><b>{tx("Ingichka oq kontur")}</b><small>{tx("2 px — kichik o‘lchamda ham logotip ko‘rinadi")}</small></span><input type="checkbox" className="switch" checked={e.outline} onChange={(x) => save({ emoji_outline: x.target.checked })} /></label>
          </div>
          <div className="stk-foot">
            <span className="grow muted">{s.counts.teams}{" "}{tx("ta jamoadan {0} tasida logotip bor — {1} ta emoji yaratiladi", withLogo.length, withLogo.length)}</span>
            <button className="btn btn-primary" disabled={busy || !withLogo.length || !s.owner} onClick={create}>{busy ? tx("Yaratilmoqda…") : tx("Emoji to‘plamini yaratish")}</button>
          </div>
        </div>
        <aside className="stack">
          <div className="card">
            <div className="card-head"><h2>{tx("Oldindan ko‘rish")}</h2></div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              <ChatPreview img={img} img2={img2} />
              <ChatPreview img={img} img2={img2} dark />
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>{tx("Emoji talablari")}</h2></div>
            <div className="stk-kv">
              <div><span>{tx("Format")}</span><b>{tx("PNG")}</b></div>
              <div><span>{tx("O‘lcham")}</span><b>{tx("100 × 100 px")}</b></div>
              <div><span>{tx("Fon")}</span><b>{tx("Shaffof")}</b></div>
              <div><span>{tx("To‘plamda")}</span><b>{e.limit}{" "}{tx("tagacha")}</b></div>
            </div>
          </div>
          <div className="stk-note"><I.alert size={16} /><span>{PREMIUM_NOTE}</span></div>
        </aside>
      </div>
    </>
  );
}

/* ---------- team page block (A11) ---------- */

type TeamBlock = { enabled: boolean; set_url: string; emoji_enabled: boolean; emoji_set_url: string; team: StkTeam };

export function TeamStickerCard({ teamId, version }: { teamId: number; version: number }) {
  const { data } = useLoad(() => api.get<TeamBlock>(`/admin/teams/${teamId}/sticker`).catch(() => null), [teamId, version]);
  const t = data?.team;
  if (!data || !t || (!data.enabled && !data.emoji_enabled)) return null;
  const line = (label: string, it: StkItem, size: string) => (
    <div className="stk-teamrow">
      {it.status === "no_logo" ? <span className="stk-tile nologo" style={{ width: 64, height: 64 }}><I.image size={22} /></span> : <StkTile t={{ image: it.image, crest_url: t.crest_url }} size={64} />}
      <div className="grow stack" style={{ gap: 4 }}>
        <b>{label}</b>
        <StkStatusCell t={it} />
        {it.status === "ready" && <small className="muted">{size}{" "}{tx("· yangilangan:")}{" "}{fmtDateTime(it.updated_at)}</small>}
      </div>
    </div>
  );
  return (
    <div className="card">
      <div className="card-head"><h3>{tx("Telegram")}</h3>{(data.set_url || data.emoji_set_url) && <a className="btn btn-sm" href={data.enabled ? data.set_url : data.emoji_set_url} target="_blank" rel="noreferrer">{tx("Ko‘rish")}</a>}</div>
      {data.enabled && line(tx("Stiker"), t, "512 × 512")}
      {data.emoji_enabled && line(tx("Emoji"), t.emoji, "100 × 100")}
      <div className="stk-foot small muted" style={{ borderTop: "1px solid var(--border)" }}><I.refresh size={14} /><span>{tx("Logotip saqlanganda stiker va emoji o‘zi yangilanadi.")}</span></div>
    </div>
  );
}
