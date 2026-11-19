import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api, ApiError } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import { PageHead } from "@/components/Layout";
import { Badge, Crest, ErrorBox, Field, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

/* Tizim → Telegram stikerlar: team logos become one Telegram sticker set. */

export type StkStatus = "ready" | "queued" | "error" | "stale" | "no_logo" | "waiting";
export type StkTeam = {
  team_id: number; name: string; short_name: string; crest_url: string; status: StkStatus; image: string;
  attempts: number; last_error: string; updated_at: string | null; next_try_at: string | null;
};
type Person = { id: number; username: string; name: string; at?: string };
type State = {
  connected: boolean; token_broken: boolean; token_masked: string; bot_username: string; same_as_live: boolean;
  owner: Person | null; candidates: Person[];
  set_slug: string; set_title: string; set_url: string; sets: { name: string; title: string; url: string; count: number }[]; limit: number;
  outline: boolean; auto_update: boolean; enabled: boolean;
  problem: "" | "token_invalid" | "owner_blocked" | "telegram_down"; last_error: string;
  last_sync_at: string | null; next_retry_at: string | null;
  counts: Record<"teams" | "ready" | "queued" | "error" | "no_logo" | "stale", number>;
  teams: StkTeam[];
};

const errText = (e: unknown) => (e instanceof ApiError ? Object.values(e.fields)[0] as string || e.message : e instanceof Error ? e.message : "Xato");
const who = (p: Person) => (p.username ? `@${p.username}` : p.name || String(p.id));

export const STK_LABEL: Record<StkStatus, string> = {
  ready: "Tayyor", queued: "Navbatda", error: "Xato", stale: "Logotip o‘zgargan", no_logo: "Logotip yo‘q", waiting: "—",
};

export function StkStatusCell({ t, autoUpdate = true }: { t: StkTeam; autoUpdate?: boolean }) {
  let sub = "";
  if (t.status === "queued" && t.attempts > 0) sub = `${t.attempts}-urinish: ${t.last_error}`;
  else if (t.status === "queued" && t.last_error) sub = t.last_error;
  else if (t.status === "error") sub = t.last_error;
  else if (t.status === "stale") sub = autoUpdate ? "Yangilanish navbatda" : "Avtomatik yangilash o‘chiq — ↻ tugmasini bosing";
  else if (t.status === "no_logo") sub = "Jamoa sahifasida yuklang";
  return (
    <div className="stk-status">
      <span className="row" style={{ gap: 8 }}><i className={`stk-dot ${t.status}`} />{STK_LABEL[t.status]}</span>
      {sub && <small>{sub}</small>}
    </div>
  );
}

export function StkTile({ t, size = 44 }: { t: Pick<StkTeam, "image" | "crest_url" | "status">; size?: number }) {
  const src = t.image || t.crest_url;
  return (
    <span className={`stk-tile${t.image ? "" : " pending"}`} style={{ width: size, height: size }}>
      {src ? <img src={src} alt="" /> : <I.image size={Math.round(size / 2.6)} />}
    </span>
  );
}

export function StickersPage() {
  const { data, error, loading, reload, setData } = useLoad(() => api.get<State>("/admin/tg-stickers"), []);
  const busy = !!data && (data.counts.queued > 0 || (!data.enabled && data.connected && !data.owner));
  // live progress while something is queued or the owner is awaited
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => api.get<State>("/admin/tg-stickers").then(setData).catch(() => {}), data?.enabled ? 4000 : 3000);
    return () => clearInterval(t);
  }, [busy, data?.enabled, setData]);

  if (error) return <><PageHead title="Telegram stikerlar" /><div className="card card-pad"><ErrorBox error={error} retry={reload} /></div></>;
  if (loading && !data) return <><PageHead title="Telegram stikerlar" /><Loading /></>;
  if (!data) return null;
  return data.enabled ? <Connected s={data} set={setData} /> : <Setup s={data} set={setData} />;
}

function Problems({ s, set }: { s: State; set: (v: State) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function retryNow() {
    setBusy(true);
    try { set(await api.post<State>("/admin/tg-stickers/sync")); toast("Qayta urinilmoqda"); } catch (e) { toast(errText(e), "error"); } finally { setBusy(false); }
  }
  const out: ReactNode[] = [];
  const bot = s.bot_username ? `https://t.me/${s.bot_username}` : "";
  if (s.token_broken) out.push(<Banner key="tb" danger icon={<I.alert size={18} />} text="Saqlangan tokenni ochib bo‘lmadi (serverdagi maxfiy kalit o‘zgargan). Tokenni qayta kiriting." />);
  if (s.problem === "token_invalid") out.push(<Banner key="ti" danger icon={<I.alert size={18} />} text="Bot tokeni yaroqsiz yoki bekor qilingan. Stikerlar yangilanmayapti." action={<a className="btn" href="#tg-connection">Tokenni almashtirish</a>} />);
  if (s.problem === "owner_blocked") out.push(<Banner key="ob" danger icon={<I.alert size={18} />} text="To‘plam egasi botni to‘xtatgan. Egasi botga qayta /start yuborishi kerak." action={bot ? <a className="btn" href={bot} target="_blank" rel="noreferrer">Botni ochish</a> : undefined} />);
  if (s.problem === "telegram_down") {
    const n = s.counts.queued;
    out.push(<Banner key="td" icon={<I.refresh size={18} />} text={`Telegram vaqtincha javob bermayapti. ${n} ta stiker navbatda${s.next_retry_at ? `, keyingi urinish ${fmtDateTime(s.next_retry_at)} da` : ""}.`} action={<button className="btn" disabled={busy} onClick={retryNow}>Hozir urinish</button>} />);
  }
  if (!s.problem && s.last_error) out.push(<Banner key="le" icon={<I.alert size={18} />} text={s.last_error} />);
  const last = s.sets[s.sets.length - 1];
  if (last && last.count >= s.limit) out.push(<Banner key="full" icon={<I.doc size={18} />} text={`To‘plam to‘ldi (${last.count} / ${s.limit}). Yangi jamoalar keyingi to‘plamga qo‘shiladi.`} />);
  return out.length ? <div className="stack" style={{ gap: 12, marginBottom: 16 }}>{out}</div> : null;
}

function Banner({ text, action, danger, icon }: { text: string; action?: ReactNode; danger?: boolean; icon: ReactNode }) {
  return <div className={`stk-banner${danger ? " danger" : ""}`}>{icon}<span className="grow">{text}</span>{action}</div>;
}

/* ---------- T1: connected ---------- */

type Filter = "all" | "ready" | "queued" | "error" | "no_logo";

function Connected({ s, set }: { s: State; set: (v: State) => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => toast(errText(e), "error");

  async function sync() {
    setBusy(true);
    try { set(await api.post<State>("/admin/tg-stickers/sync")); toast(`Sinxronlash boshlandi: ${s.counts.teams} ta jamoa`); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function retry(t: StkTeam) {
    try { set(await api.post<State>(`/admin/tg-stickers/teams/${t.team_id}/retry`)); toast(`${t.name}: navbatga qo‘yildi`); } catch (e) { fail(e); }
  }
  const inFilter = (t: StkTeam) => filter === "all" || t.status === filter || (filter === "queued" && t.status === "stale");
  const rows = s.teams.filter((t) => inFilter(t) && (!q.trim() || t.name.toLowerCase().includes(q.trim().toLowerCase())));
  const chips: [Filter, string, number][] = [
    ["all", "Hammasi", s.counts.teams], ["ready", "Tayyor", s.counts.ready], ["queued", "Navbatda", s.counts.queued + s.counts.stale],
    ["error", "Xato", s.counts.error], ["no_logo", "Logotip yo‘q", s.counts.no_logo],
  ];

  return (
    <>
      <PageHead
        title="Telegram stikerlar"
        sub="Jamoa logotiplari avtomatik ravishda Telegram stiker to‘plamiga qo‘shiladi"
        actions={<>
          <button className="btn btn-dark" disabled={busy} onClick={sync}><I.refresh size={16} /> Hammasini sinxronlash</button>
          {s.set_url && <a className="btn btn-primary" href={s.set_url} target="_blank" rel="noreferrer">To‘plamni ochish</a>}
        </>}
      />
      <Problems s={s} set={set} />
      <div className="stk-cols">
        <div className="stack">
          <div className="card stk-stats">
            {[[s.counts.teams, "Jamoalar"], [s.counts.ready, "Stiker tayyor"], [s.counts.queued + s.counts.stale, "Navbatda"], [s.counts.error, "Xato"]].map(([v, l]) => (
              <div key={l}><b>{v}</b><small>{l}</small></div>
            ))}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <div className="search" style={{ width: 260 }}><I.search size={16} /><input className="input" aria-label="Qidirish" placeholder="Jamoa qidirish…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            {chips.map(([k, l, n]) => (
              <button key={k} className={`stk-chip${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{l} <span>{n}</span></button>
            ))}
          </div>
          <div className="card">
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Jamoa</th><th>Stiker</th><th>Holat</th><th className="hide-mobile">Yangilangan</th><th /></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.team_id}>
                    <td><span className="row"><Crest team={{ id: t.team_id, name: t.name, short_name: t.short_name, crest_url: t.crest_url }} size={24} /><b>{t.name}</b></span></td>
                    <td style={{ width: 80 }}>{t.status === "no_logo" ? <span className="stk-tile nologo"><I.image size={18} /></span> : <StkTile t={t} />}</td>
                    <td><StkStatusCell t={t} autoUpdate={s.auto_update} /></td>
                    <td className="hide-mobile nowrap">{t.status === "ready" || t.status === "stale" ? fmtDateTime(t.updated_at) : "—"}</td>
                    <td className="nowrap" style={{ textAlign: "right" }}>
                      {t.status === "no_logo"
                        ? <Link className="btn btn-ghost btn-icon" title="Logotip yuklash" aria-label="Logotip yuklash" to={`/teams/${t.team_id}`}><I.upload size={16} /></Link>
                        : <button className="btn btn-ghost btn-icon" title={t.status === "ready" ? "Qayta yaratish" : "Qayta urinish"} aria-label="Qayta yaratish" onClick={() => retry(t)}><I.refresh size={16} /></button>}
                    </td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 32 }}>Jamoa topilmadi</td></tr>}
              </tbody>
            </table></div>
          </div>
        </div>
        <aside className="stack">
          <ConnectionCard s={s} set={set} />
          <LookCard s={s} set={set} />
          <div className="stk-note"><I.telegram size={16} /><span>To‘plam Telegram’da ochiq: havola orqali istalgan foydalanuvchi qo‘sha oladi.</span></div>
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
    try { set(await api.patch<State>("/admin/tg-stickers", { set_title: title.trim() })); toast("To‘plam nomi yangilandi"); } catch (e) { toast(errText(e), "error"); setTitle(s.set_title); }
  }
  async function disconnect() {
    if (!(await confirm({ title: "Ulanishni uzish", text: "Telegram’dagi to‘plam o‘chmaydi, lekin endi yangilanmaydi. Qayta ulansangiz, to‘plam qaytadan yaratiladi.", ok: "Uzish", danger: true }))) return;
    try { set(await api.del<State>("/admin/tg-stickers")); toast("Uzildi"); } catch (e) { toast(errText(e), "error"); }
  }
  const ok = !s.problem && !s.token_broken;
  return (
    <div className="card" id="tg-connection">
      <div className="card-head"><h2>Ulanish</h2><span className="row small b" style={{ gap: 6 }}><i className={`stk-dot ${ok ? "ready" : "error"}`} />{ok ? "Ulangan" : "Muammo bor"}</span></div>
      <div className="stk-kv">
        <div><span>Bot</span><b>@{s.bot_username}</b></div>
        <div><span>To‘plam egasi</span><b>{s.owner ? who(s.owner) : "—"}</b></div>
        <div><span>To‘plam</span><b>{s.set_title}</b></div>
        <div><span>Stikerlar</span><b>{total} / {s.limit * Math.max(1, s.sets.length)}</b></div>
        <div><span>Oxirgi sinxronlash</span><b>{fmtDateTime(s.last_sync_at)}</b></div>
      </div>
      {s.sets.map((x) => (
        <a key={x.name} className="stk-link" href={x.url} target="_blank" rel="noreferrer"><span className="grow">{x.url.replace("https://", "")}</span><I.link size={16} /></a>
      ))}
      <div className="card-pad stack" style={{ gap: 12 }}>
        <button className="btn" onClick={() => setOpen(!open)}><I.edit size={16} /> Ulanishni sozlash</button>
        {open && <>
          <Field label="To‘plam nomi" hint="Telegram’da ko‘rinadi"><input className="input" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} /></Field>
          <TokenForm s={s} set={set} />
          <button className="btn btn-ghost" style={{ color: "var(--red-600)" }} onClick={disconnect}><I.x size={16} /> Ulanishni uzish</button>
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
      if (b.outline !== undefined) toast("Barcha stikerlar qayta chiziladi");
    } catch (e) { toast(errText(e), "error"); }
  }
  return (
    <div className="card">
      <div className="card-head"><h2>Stiker ko‘rinishi</h2>
        {withLogo.length > 1 && (
          <select className="input input-sm" style={{ width: 140 }} value={teamId} onChange={(e) => setTeamId(Number(e.target.value))} aria-label="Jamoa">
            {withLogo.map((t) => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
          </select>
        )}
      </div>
      <div className="card-pad stack" style={{ gap: 14 }}>
        <div className="stk-previews">
          {(["light", "dark"] as const).map((m) => (
            <div key={m} className={`stk-preview ${m}`}>
              {img ? <img src={img} alt="" /> : <span className="muted small">…</span>}
              <small>{m === "light" ? "Yorug‘ mavzu" : "Qorong‘i mavzu"}</small>
            </div>
          ))}
        </div>
        <label className="toggle-row"><span><b>Oq kontur</b><small>Qorong‘i mavzuda logotip yo‘qolib ketmaydi</small></span><input type="checkbox" className="switch" checked={s.outline} onChange={(e) => patch({ outline: e.target.checked })} /></label>
        <label className="toggle-row"><span><b>Avtomatik yangilash</b><small>Logotip o‘zgarsa, stiker o‘zi almashadi</small></span><input type="checkbox" className="switch" checked={s.auto_update} onChange={(e) => patch({ auto_update: e.target.checked })} /></label>
        <p className="muted small" style={{ margin: 0 }}>Oq fon avtomatik olib tashlanadi: logotip ichidagi oq qismlar saqlanadi.</p>
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
      if (s.enabled && !v.enabled) toast("Boshqa bot ulandi: to‘plamni qaytadan yaratish kerak");
      else toast(`Bot topildi: @${v.bot_username}`);
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
      <Field label="Bot tokeni" error={err} hint="Token shifrlangan holda saqlanadi va brauzerga qaytarilmaydi">
        <input className="input" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.connected ? s.token_masked : "123456789:AA…"} autoComplete="off" spellCheck={false} />
      </Field>
      <div className="row"><button className="btn btn-primary" disabled={busy || token.trim().length < 30} onClick={save}>{busy ? "Tekshirilmoqda…" : s.connected ? "Tokenni almashtirish" : "Tekshirish va saqlash"}</button></div>
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
  const fullName = bot ? `${slug || "…"}_by_${bot}` : "";

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
    try { set(await api.put<State>("/admin/tg-stickers/owner", { tg_user_id: p.id })); toast(`To‘plam egasi: ${who(p)}`); } catch (e) { toast(errText(e), "error"); }
  }
  async function create() {
    setBusy(true);
    try {
      if (!(await saveSet())) return;
      set(await api.post<State>("/admin/tg-stickers/create"));
      toast("To‘plam yaratildi");
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  const ready = s.connected && !!s.owner && !s.token_broken;

  return (
    <>
      <PageHead title="Telegram stikerlar" sub="Jamoa logotiplari avtomatik ravishda Telegram stiker to‘plamiga qo‘shiladi" />
      <Problems s={s} set={set} />
      <div className="stk-cols">
        <div className="card">
          <div className="card-head"><h2>Telegram’ga ulash</h2><span className="row small b muted" style={{ gap: 6 }}><i className="stk-dot waiting" />Ulanmagan</span></div>
          <Step n={1} done={s.connected && !s.token_broken} title="Bot tokeni" sub="@BotFather bergan tokenni kiriting. Live-pult boti yoki alohida bot bo‘lishi mumkin.">
            <TokenForm s={s} set={set} />
            {s.connected && !s.token_broken && <div className="row b small"><i className="stk-dot ready" />Bot topildi: @{bot}{s.same_as_live && <span className="muted" style={{ fontWeight: 400 }}> · Live-pult boti bilan bir xil</span>}</div>}
          </Step>
          <Step n={2} done={!!s.owner} title="To‘plam egasi" sub="To‘plam shu Telegram-akkauntga yoziladi. Egasi bo‘ladigan akkauntdan botga /start yuboring — bot uni o‘zi aniqlaydi." disabled={!s.connected}>
            {s.owner ? (
              <div className="stk-person"><i className="stk-dot ready" /><span className="grow"><b>{who(s.owner)}</b>{s.owner.name && s.owner.username && <small>{s.owner.name}</small>}</span><Badge tone="ok">Egasi</Badge></div>
            ) : s.connected && (
              <>
                {s.candidates.map((p) => (
                  <div key={p.id} className="stk-person"><I.user size={16} /><span className="grow"><b>{who(p)}</b><small>{p.name && p.username ? `${p.name} · ` : ""}/start: {fmtDateTime(p.at)}</small></span><button className="btn btn-sm btn-primary" onClick={() => choose(p)}>Egasi qilish</button></div>
                ))}
                <div className="stk-waiting"><i className="stk-dot queued" /><span className="grow">{s.candidates.length ? "Kerakli akkaunt ro‘yxatda bo‘lmasa, undan botga /start yuboring" : "Kutilmoqda: botga hali /start yuborilmagan"}</span>{bot && <a className="btn btn-sm" href={`https://t.me/${bot}?start=stickers`} target="_blank" rel="noreferrer">Botni ochish</a>}</div>
              </>
            )}
          </Step>
          <Step n={3} done={false} title="To‘plam" sub="Nom Telegram’da ko‘rinadi. Havolani to‘plam yaratilgandan keyin o‘zgartirib bo‘lmaydi.">
            <div className="form-grid">
              <Field label="To‘plam nomi" error={errs.set_title}><input className="input" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} onBlur={saveSet} /></Field>
              <Field label="Havola" error={errs.set_slug} hint={fullName ? `t.me/addstickers/${fullName}` : "Bot ulangach to‘liq havola ko‘rinadi"}>
                <input className="input" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} onBlur={saveSet} spellCheck={false} />
              </Field>
            </div>
          </Step>
          <div className="stk-foot">
            <span className="grow muted">{s.counts.teams} ta jamoadan {withLogo} tasida logotip bor — {withLogo} ta stiker yaratiladi</span>
            <button className="btn btn-primary" disabled={!ready || busy || !withLogo} onClick={create}>{busy ? "Yaratilmoqda…" : "To‘plamni yaratish"}</button>
          </div>
        </div>
        <aside className="stack">
          <div className="card">
            <div className="card-head"><h2>Qanday ishlaydi</h2></div>
            <ol className="stk-how">
              <li>Jamoa qo‘shilsa — stiker to‘plamga qo‘shiladi</li>
              <li>Logotip o‘zgarsa — stiker almashtiriladi</li>
              <li>Jamoa o‘chirilsa — stiker olib tashlanadi</li>
              <li>Telegram javob bermasa — navbatga tushadi va qayta uriniladi</li>
            </ol>
          </div>
          <div className="card">
            <div className="card-head"><h2>Stiker talablari</h2></div>
            <div className="stk-kv">
              <div><span>Format</span><b>PNG</b></div>
              <div><span>O‘lcham</span><b>512 × 512 px</b></div>
              <div><span>Fon</span><b>Shaffof (oq fon olib tashlanadi)</b></div>
              <div><span>Hajm</span><b>512 KB gacha</b></div>
            </div>
          </div>
          <div className="stk-note"><I.lock size={16} /><span>Shaxsiy Telegram-akkauntga kirish shart emas: faqat bot tokeni va /start yetarli.</span></div>
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

/* ---------- team page block (A11) ---------- */

export function TeamStickerCard({ teamId, version }: { teamId: number; version: number }) {
  const { data } = useLoad(() => api.get<{ enabled: boolean; set_url: string; outline: boolean; team: StkTeam }>(`/admin/teams/${teamId}/sticker`).catch(() => null), [teamId, version]);
  const view = data?.team;
  if (!data || !data.enabled || !view) return null;
  return (
    <div className="card">
      <div className="card-head"><h3>Telegram stiker</h3>{data.set_url && <a className="btn btn-sm" href={data.set_url} target="_blank" rel="noreferrer">Ko‘rish</a>}</div>
      <div className="card-pad row" style={{ gap: 14, alignItems: "flex-start" }}>
        {view.status === "no_logo" ? <span className="stk-tile nologo" style={{ width: 64, height: 64 }}><I.image size={22} /></span> : <StkTile t={view} size={64} />}
        <div className="grow stack" style={{ gap: 4 }}>
          <StkStatusCell t={view} />
          {view.status === "ready" && <small className="muted">Yangilangan: {fmtDateTime(view.updated_at)}</small>}
        </div>
      </div>
      <div className="stk-foot small muted" style={{ borderTop: "1px solid var(--border)" }}><I.refresh size={14} /><span>Logotip saqlanganda stiker o‘zi yangilanadi.</span></div>
    </div>
  );
}
