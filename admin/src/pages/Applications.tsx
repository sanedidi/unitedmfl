import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router";
import QRCode from "qrcode";
import { api, blobUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useDebounced, useLoad } from "@/lib/hooks";
import { fmtDateTime, fmtShort, fromLocalInput, initials, toLocalInput } from "@/lib/format";
import { invalidateRefs, useRefs } from "@/lib/refs";
import { PageHead } from "@/components/Layout";
import { Badge, Empty, ErrorBox, Field, Loading, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { PhotoThumb, PhotoViewer, type PhotoItem } from "@/components/PlayerPhotos";
import { ArizalarTabs, CabinetPage, CabinetsList, ChangeReview, ChangesList } from "./TeamCabinets";

/* ---------- types ---------- */
type LinkState = "open" | "paused" | "soon" | "closed" | "full" | "used";
export type RegLink = {
  id: number; code: string; title: string; season_id: number | null; stage_id: number | null; kind: "multi" | "single";
  is_active: boolean; is_default: boolean; opens_at: string | null; closes_at: string | null; max_teams: number | null;
  min_players: number; max_players: number; min_age: number | null; require_logo: boolean; require_photo: boolean;
  require_medical: boolean; require_phone: boolean; check_duplicates: boolean; heading: string; description: string; rules_url: string;
  season: string; stage: string; state: LinkState; url: string; approved: number; sent: number; drafts: number; slots_left: number | null;
};
type Player = { first_name: string; last_name: string; jersey_name: string; birth_date: string; number: string | null; kit_size: string; workplace: string; role: "player" | "goalkeeper" | "media"; photo_url: string; medical: { file: string; name: string } | null };
type Staff = { first_name: string; last_name: string; birth_date: string; kit_size: string; role: string; phone: string };
type Check = { level: "error" | "warn"; section: string; code: string; text: string; index?: number; staff?: boolean };
type Dup = { index: number; matches: { player_id: number; full_name: string; number: string | null; team_id: number | null; team_name: string; birth_date: string }[] };
type AppSummary = {
  id: number; number: string; status: string; team: { name: string; short_name: string; crest_url: string; colors: string[] };
  rep: { name: string; phone: string }; phone_verified: boolean; players: number; media: number; staff: number;
  link: { id: number; title: string; code: string } | null; errors: number; warnings: number; team_id: number | null;
  changes_deadline: string | null; submitted_at: string | null; updated_at: string; created_at: string;
};
type AppDetail = {
  id: number; number: string; status: string; link: RegLink | null;
  team: { name: string; short_name: string; city: string; colors: string[]; crest_url: string; crest_w: number; crest_h: number; about: string; instagram: string };
  rep: { name: string; role: string; phone: string; telegram: string; email: string; authorized: boolean };
  players: Player[]; staff: Staff[]; phone_verified: boolean; otp_required: boolean;
  comments: { section: string; text: string }[]; changes_deadline: string | null; reject_reason: string; internal_note: string;
  submitted_at: string | null; decided_at: string | null; created_at: string;
  checks: Check[]; duplicates: Dup[]; events: { kind: string; note: string; created_at: string; user: string }[];
  created_team: { id: number; slug: string; name: string } | null; rep_url: string;
  max_players: number | null; roster_min: number; roster_max: number;
};

const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "Qoralama", tone: "" },
  submitted: { label: "Yangi", tone: "dark" },
  review: { label: "Ko‘rib chiqilmoqda", tone: "info" },
  changes: { label: "Tuzatish kerak", tone: "warn" },
  approved: { label: "Tasdiqlangan", tone: "ok" },
  rejected: { label: "Rad etilgan", tone: "danger" },
};
const LINK_STATE: Record<LinkState, { label: string; tone: string }> = {
  open: { label: "Faol", tone: "ok" },
  paused: { label: "To‘xtatilgan", tone: "" },
  soon: { label: "Hali boshlanmagan", tone: "info" },
  closed: { label: "Muddati tugagan", tone: "danger" },
  full: { label: "Joylar to‘ldi", tone: "warn" },
  used: { label: "Ishlatilgan", tone: "" },
};
const EVENT: Record<string, string> = {
  created: "Qoralama yaratildi", phone_verified: "Telefon tasdiqlandi", submitted: "Ariza yuborildi", resubmitted: "Tuzatilib qayta yuborildi",
  review: "Ko‘rib chiqish boshlandi", changes: "Tuzatishga qaytarildi", approved: "Tasdiqlandi", rejected: "Rad etildi", expired: "Tuzatish muddati o‘tdi",
  limit: "Tarkib limiti o‘zgartirildi",
};
const SECTIONS: Record<string, string> = { team: "Jamoa", rep: "Vakil", roster: "Tarkib" };
const STAFF_ROLES: Record<string, string> = { head_coach: "Bosh murabbiy", assistant: "Yordamchi", gk_coach: "Darvozabonlar murabbiyi", fitness: "Jismoniy tayyorgarlik", doctor: "Shifokor", manager: "Menejer", other: "Boshqa" };
const KIT_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];
const fullName = (p: { first_name: string; last_name: string }) => `${p.first_name} ${p.last_name}`.trim();
const ROLE_NAME: Record<Player["role"], string> = { player: "Maydon o‘yinchisi", goalkeeper: "Darvozabon", media: "Media shaxs" };
const fmtBirth = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split("-").reverse().join(".") : d || "—");

function useRegConfig() {
  return useLoad(() => api.get<{ register_url: string; sms: string }>("/admin/registration/config"), []).data;
}

/* ---------- shared: copy / QR / share ---------- */
async function copy(text: string, toast: (t: string, k?: "ok" | "error") => void) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Havola nusxalandi");
  } catch {
    toast("Nusxalab bo‘lmadi — havolani qo‘lda belgilang", "error");
  }
}
function QrModal({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(url, { width: 880, margin: 2, errorCorrectionLevel: "M" }).then(setSrc).catch(() => setSrc(""));
  }, [url]);
  return (
    <Modal title="QR-kod" onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Yopish</button>
      {src && <a className="btn btn-primary" href={src} download={`QR-${title.replace(/[^\p{L}\p{N}]+/gu, "-")}.png`}><I.download size={16} /> PNG yuklab olish</a>}
    </>}>
      <div className="stack" style={{ alignItems: "center", gap: 12 }}>
        {src ? <img className="qr-img" src={src} alt={`QR: ${url}`} /> : <Loading />}
        <b style={{ wordBreak: "break-all", textAlign: "center" }}>{url}</b>
        <span className="muted small" style={{ textAlign: "center" }}>Afisha, post yoki chatga qo‘ying — skaner qilganda ariza sahifasi ochiladi.</span>
      </div>
    </Modal>
  );
}
const tgShare = (url: string, text: string) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;

function LinkActions({ link, small }: { link: RegLink; small?: boolean }) {
  const toast = useToast();
  const [qr, setQr] = useState(false);
  if (!link.url) return <span className="muted small">Kod: <b>{link.code}</b></span>;
  const cls = `btn${small ? " btn-sm" : ""}`;
  return (
    <>
      <button className={`${cls} btn-ghost`} onClick={(e) => { e.stopPropagation(); copy(link.url, toast); }}><I.copy size={15} /> Nusxa olish</button>
      <button className={cls} onClick={(e) => { e.stopPropagation(); setQr(true); }}><I.qr size={15} /> QR-kod</button>
      <a className={cls} href={tgShare(link.url, "United MFL: jamoa arizasi")} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}><I.telegram size={15} /> Telegramda ulashish</a>
      {qr && <QrModal url={link.url} title={link.title} onClose={() => setQr(false)} />}
    </>
  );
}

/* ---------- applications list ---------- */
/* ---------- deleting applications ---------- */
type DeleteInfo = {
  id: number; number: string; status: string; team_name: string; players: number; staff: number; medical_files: number;
  frees_slot: boolean; can_delete: boolean; confirm_number: boolean; can_delete_team: boolean;
  team: { id: number; name: string; players: number; media: number; staff: number; kept: number; played: number; scheduled: number } | null;
};
type ToastFn = (t: string, k?: "ok" | "error") => void;

// drafts and rejected applications: anyone with «Jamoa arizalari»; the rest — administrators
const mayDelete = (can: (perm: string) => boolean, status: string) => can("applications:delete") || status === "draft" || status === "rejected";

async function downloadXlsx(id: number, name: string, toast: ToastFn) {
  try {
    const u = await blobUrl(`/admin/applications/${id}/export.xlsx`);
    const el = document.createElement("a");
    el.href = u;
    el.download = `TARKIB-${name}.xlsx`;
    el.click();
  } catch (e) {
    toast(e instanceof Error ? e.message : "Yuklab bo‘lmadi", "error");
  }
}

type MenuItem = { label: string; icon: ReactNode; onClick: () => void; danger?: boolean } | "sep";
/** «⋯» button with a small menu; the menu is fixed-positioned so the table does not clip it. */
function RowMenu({ items }: { items: MenuItem[] }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!t.closest?.(".row-menu-pop") && !btn.current?.contains(t)) close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [pos]);
  function toggle(e: ReactMouseEvent) {
    e.stopPropagation();
    if (pos || !btn.current) return setPos(null);
    const r = btn.current.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    setPos(window.innerHeight - r.bottom > 200 ? { top: r.bottom + 6, right } : { bottom: window.innerHeight - r.top + 6, right });
  }
  return (
    <>
      <button ref={btn} type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Amallar" aria-haspopup="menu" aria-expanded={!!pos} onClick={toggle}><I.more size={16} /></button>
      {pos && (
        <div className="row-menu-pop" role="menu" style={pos} onClick={(e) => e.stopPropagation()}>
          {items.map((it, i) => it === "sep" ? <hr key={i} /> : (
            <button key={i} type="button" role="menuitem" className={it.danger ? "danger" : undefined} onClick={() => { setPos(null); it.onClick(); }}>{it.icon}{it.label}</button>
          ))}
        </div>
      )}
    </>
  );
}

/** Confirmation for deleting an application (design A7/A8): an approved one can take its team along and needs its number typed. */
function DeleteModal({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const d = useLoad(() => api.get<DeleteInfo>(`/admin/applications/${id}/delete-info`), [id]);
  const [withTeam, setWithTeam] = useState(true);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const info = d.data;
  const team = info?.team || null;
  const teamOn = !!team && !!info?.can_delete_team && withTeam;
  const numberOk = !info?.confirm_number || typed.trim().toUpperCase() === info.number;
  const name = info?.team_name || "Nomsiz jamoa";

  async function go() {
    if (!info) return;
    setBusy(true);
    try {
      const q = new URLSearchParams();
      if (teamOn) q.set("team", "1");
      if (info.confirm_number) q.set("confirm", typed.trim());
      const qs = q.toString();
      const res = await api.del<{ team_deleted: boolean; players_detached: number }>(`/admin/applications/${id}${qs ? `?${qs}` : ""}`);
      if (res?.team_deleted) invalidateRefs();
      toast(`«${name}» arizasi o‘chirildi${res?.team_deleted ? " — jamoa ham o‘chirildi" : ""}`);
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "O‘chirilmadi", "error");
      setBusy(false);
    }
  }

  const teamText = team ? `${team.players} o‘yinchi${team.media ? `, ${team.media} media shaxs` : ""}${team.staff ? ` va ${team.staff} murabbiy` : ""} bilan birga. ` +
    (team.played ? `Jamoa ${team.played} ta matchda o‘ynagan.` : "Jamoa hali birorta matchda o‘ynamagan.") : "";
  return (
    <Modal title={info?.confirm_number ? "Tasdiqlangan arizani o‘chirish" : "Arizani o‘chirish"} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Bekor qilish</button>
      <button className="btn btn-destructive" onClick={go} disabled={!info || !info.can_delete || !numberOk || busy}>
        {busy ? "O‘chirilmoqda…" : teamOn ? "Ariza va jamoani o‘chirish" : "Arizani o‘chirish"}
      </button>
    </>}>
      {d.error ? <ErrorBox error={d.error} retry={d.reload} /> : !info ? <Loading /> : (
        <div className="stack" style={{ gap: 16 }}>
          {!info.can_delete && <div className="alert danger"><I.lock size={16} /><div>Bu arizani faqat administrator o‘chira oladi.</div></div>}
          {!info.confirm_number ? (
            <>
              <div className="muted">«{name}» ({info.number}) arizasi butunlay o‘chiriladi. Bu amalni qaytarib bo‘lmaydi.</div>
              <b className="small">O‘chiriladi:</b>
              <div className="del-list">
                <div><I.trash size={16} /><span>Ariza va tarkib — {info.players} kishi{info.staff ? `, ${info.staff} murabbiy` : ""}</span></div>
                <div><I.trash size={16} /><span>Yuklangan logotip, fotolar{info.medical_files ? ` va ${info.medical_files} ta tibbiy ruxsatnoma` : ""}</span></div>
                <div><I.trash size={16} /><span>Tarix va ichki izoh</span></div>
              </div>
              {!team && <div className="muted small">Jamoa yaratilmagan: ariza hali tasdiqlanmagan, saytga hech narsa chiqmagan.</div>}
            </>
          ) : (
            <>
              {team ? (
                <div className="alert danger"><I.alert size={16} /><div><b>Ariza asosida «{team.name}» jamoasi yaratilgan.</b><div>Faqat ariza o‘chirilsa, jamoa, o‘yinchilar va shtab saytda qoladi.</div></div></div>
              ) : (
                <div className="del-note"><I.alert size={16} />Ariza asosida yaratilgan jamoa allaqachon o‘chirilgan.</div>
              )}
              <b className="small">Nimani o‘chiramiz?</b>
              <label className="del-opt locked"><input type="checkbox" checked disabled /><span><b>Arizani o‘chirish</b><small>{info.number}, tarkib, fayllar, tarix va ichki izoh. Doim o‘chiriladi.</small></span></label>
              {team && (
                <label className={`del-opt${teamOn ? " on" : ""}${info.can_delete_team ? "" : " locked"}`}>
                  <input type="checkbox" checked={teamOn} disabled={!info.can_delete_team} onChange={(e) => setWithTeam(e.target.checked)} />
                  <span><b>«{team.name}» jamoasini ham o‘chirish</b><small>{teamText}</small></span>
                </label>
              )}
              {team && team.played > 0 && <div className="del-note"><I.lock size={16} />Jamoa matchlarda o‘ynagan — statistika buzilmasligi uchun jamoa o‘chirilmaydi, faqat ariza o‘chadi.</div>}
              {teamOn && team && team.kept > 0 && <div className="del-note"><I.users size={16} />{team.kept} ta o‘yinchi boshqa jamoadan ko‘chirilgan yoki keyin qo‘shilgan — ular o‘chirilmaydi, jamoasiz qoladi.</div>}
              {teamOn && team && team.scheduled > 0 && <div className="del-note"><I.calendar size={16} />{team.scheduled} ta rejadagi matchda bu jamoa o‘rni bo‘sh qoladi.</div>}
              {info.frees_slot && <div className="del-note"><I.link size={16} />Havolada 1 joy bo‘shaydi.</div>}
              <Field label={`Tasdiqlash uchun ariza raqamini yozing: ${info.number}`} hint="Raqam to‘g‘ri yozilmaguncha «O‘chirish» tugmasi faol bo‘lmaydi">
                <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={info.number} autoFocus
                  onKeyDown={(e) => e.key === "Enter" && numberOk && info.can_delete && !busy && go()} />
              </Field>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function ApplicationsList() {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [delId, setDelId] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const data = useLoad(() => api.get<{ items: AppSummary[]; total: number; counts: Record<string, number> }>(
    `/admin/applications?page=${page}&limit=50${status ? `&status=${status}` : ""}${dq ? `&q=${encodeURIComponent(dq)}` : ""}`), [status, dq, page]);
  const links = useLoad(() => api.get<{ items: RegLink[] }>("/admin/registration/links"), []);
  const open = (links.data?.items || []).filter((l) => l.state === "open");
  const c = data.data?.counts || {};
  const sent = Object.entries(c).filter(([k]) => k !== "draft").reduce((s, [, n]) => s + n, 0);
  const chips: [string, string, number][] = [["", "Hammasi", sent], ["submitted", "Yangi", c.submitted || 0], ["review", "Ko‘rib chiqilmoqda", c.review || 0],
    ["changes", "Tuzatishda", c.changes || 0], ["approved", "Tasdiqlangan", c.approved || 0], ["rejected", "Rad etilgan", c.rejected || 0], ["draft", "Qoralamalar", c.draft || 0]];
  const active = open[0];

  return (
    <>
      <PageHead title="Jamoa arizalari" sub={active ? `${active.title} · ${sent} ta ariza${active.max_teams ? ` · ${active.max_teams} joydan ${active.slots_left} tasi bo‘sh` : ""}` : "Jamoalar alohida ro‘yxatdan o‘tish sayti orqali ariza yuboradi"}
        actions={<>
          <Link className="btn" to="/applications/links"><I.link size={16} /> Havolalar</Link>
          <Link className="btn btn-primary" to="/applications/links/new"><I.plus size={16} /> Yangi havola</Link>
        </>} />
      <ArizalarTabs current="apps" />
      {links.data && (active ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="link-banner">
            <span className="ic"><I.link size={20} /></span>
            <div className="grow" style={{ minWidth: 220 }}>
              <div className="row" style={{ gap: 8 }}><b>{active.title}</b><Badge tone="ok">Faol</Badge>{active.is_default && <Badge plain>Asosiy sahifada</Badge>}</div>
              <div className="muted small" style={{ marginTop: 2 }}>{active.url || `Kod: ${active.code}`}{active.closes_at ? ` · ${fmtDateTime(active.closes_at)} gacha` : ""} · {active.sent} ariza{active.max_teams ? ` · ${active.approved}/${active.max_teams} joy` : ""}</div>
            </div>
            <LinkActions link={active} />
          </div>
        </div>
      ) : (
        <div className="alert warn" style={{ marginBottom: 16 }}>
          <I.lock size={16} />
          <div className="grow"><b>Ro‘yxatdan o‘tish yopiq.</b> Ariza sayti hozir «Ro‘yxatdan o‘tish hozircha yopiq» deb ko‘rsatadi. Qabulni ochish uchun havola yarating va uni faollashtiring.</div>
          <Link className="btn btn-sm" to={links.data.items.length ? "/applications/links" : "/applications/links/new"}>{links.data.items.length ? "Havolalarni ochish" : "Havola yaratish"}</Link>
        </div>
      ))}
      <div className="card">
        <div className="toolbar">
          <div className="search" style={{ width: 280 }}><I.search size={16} /><input className="input input-sm" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Jamoa, vakil yoki telefon…" aria-label="Qidirish" /></div>
          <div className="chips">
            {chips.map(([k, label, n]) => <button key={k} className="chip" aria-pressed={status === k} onClick={() => { setStatus(k); setPage(1); }}>{label} <span className="muted">{n}</span></button>)}
          </div>
        </div>
        {data.error ? <div className="card-pad"><ErrorBox error={data.error} retry={data.reload} /></div> : !data.data ? <Loading /> : !data.data.items.length ? (
          <Empty title={status === "draft" ? "Qoralama yo‘q" : "Hali ariza yo‘q"} text="Jamoa vakillari havola orqali ariza yuborganda shu yerda ko‘rinadi." />
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Jamoa</th><th>Vakil</th><th>Tarkib</th><th className="hide-mobile">Tekshiruv</th><th className="hide-mobile">Yuborilgan</th><th>Holat</th><th /></tr></thead>
            <tbody>{data.data.items.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => nav(`/applications/${a.id}`)}>
                <td><div className="row">
                  <span className="crest" style={{ width: 32, height: 32, fontSize: 11 }}>{a.team.crest_url ? <img src={a.team.crest_url} alt="" /> : a.team.short_name || initials(a.team.name || "?")}</span>
                  <div><b>{a.team.name || "Nomsiz"}</b><div className="muted small">{a.number}{a.link ? ` · ${a.link.title}` : ""}</div></div>
                </div></td>
                <td>{a.rep.name || <span className="muted">—</span>}<div className="muted small">{a.rep.phone}{a.phone_verified && " ✓"}</div></td>
                <td className="nowrap">{a.players} o‘yinchi<div className="muted small">{a.media} media · {a.staff} murabbiy</div></td>
                <td className="hide-mobile">{a.errors ? <span className="danger-text small row" style={{ gap: 6 }}><I.alert size={14} /> {a.errors} xato</span> : a.warnings ? <span className="small row" style={{ gap: 6 }}><span style={{ color: "var(--amber-500)" }}><I.alert size={14} /></span> {a.warnings} ogohlantirish</span> : <span className="small row" style={{ gap: 6, color: "var(--text-accent)" }}><I.check size={14} /> Muammo yo‘q</span>}</td>
                <td className="hide-mobile nowrap">{fmtShort(a.submitted_at || a.updated_at)}</td>
                <td><Badge tone={STATUS[a.status]?.tone}>{STATUS[a.status]?.label || a.status}</Badge>{a.status === "changes" && a.changes_deadline && <div className="muted small">{fmtShort(a.changes_deadline)} gacha</div>}</td>
                <td className="actions"><RowMenu items={[
                  { label: "Ko‘rish", icon: <I.eye size={16} />, onClick: () => nav(`/applications/${a.id}`) },
                  { label: "TARKIB.xlsx yuklab olish", icon: <I.download size={16} />, onClick: () => downloadXlsx(a.id, a.team.short_name || String(a.id), toast) },
                  ...(mayDelete(can, a.status) ? ["sep" as const, { label: "O‘chirish…", icon: <I.trash size={16} />, danger: true, onClick: () => setDelId(a.id) }] : []),
                ]} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {data.data && data.data.total > 50 && (
          <div className="row" style={{ justifyContent: "space-between", padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
            <span className="muted small">Jami: {data.data.total}</span>
            <div className="row"><button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>←</button><button className="btn btn-sm" disabled={page * 50 >= data.data.total} onClick={() => setPage(page + 1)}>→</button></div>
          </div>
        )}
      </div>
      {delId != null && <DeleteModal id={delId} onClose={() => setDelId(null)} onDone={() => { setDelId(null); data.reload(); links.reload(); }} />}
    </>
  );
}

/* ---------- application review ---------- */
function ApplicationReview() {
  const { id } = useParams();
  const toast = useToast();
  const nav = useNavigate();
  const { can } = useAuth();
  const d = useLoad(() => api.get<AppDetail>(`/admin/applications/${id}`), [id]);
  const cfg = useRegConfig();
  const [modal, setModal] = useState<"" | "approve" | "changes" | "reject" | "delete">("");
  const [note, setNote] = useState<string | null>(null);
  const [photo, setPhoto] = useState<number | null>(null); // index into photos

  useEffect(() => {
    if (d.data?.status === "submitted") api.post(`/admin/applications/${id}/review`).then(() => d.reload()).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.data?.status, id]);

  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Loading />;
  const a = d.data;
  const st = STATUS[a.status];
  const canDecide = a.status === "submitted" || a.status === "review";
  const errors = a.checks.filter((c) => c.level === "error");

  async function openFile(file: string) {
    try {
      window.open(await blobUrl(`/admin/applications/${a.id}/files/${encodeURIComponent(file)}`), "_blank");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Fayl ochilmadi", "error");
    }
  }
  async function exportXlsx() {
    try {
      const u = await blobUrl(`/admin/applications/${a.id}/export.xlsx`);
      const el = document.createElement("a");
      el.href = u;
      el.download = `TARKIB-${a.team.short_name || a.id}.xlsx`;
      el.click();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Yuklab bo‘lmadi", "error");
    }
  }
  async function saveNote() {
    if (note == null || note === a.internal_note) return;
    try {
      await api.patch(`/admin/applications/${a.id}`, { internal_note: note });
      toast("Izoh saqlandi");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Saqlanmadi", "error");
    }
  }

  const field = a.players.map((p, i) => ({ p, i })).filter((x) => x.p.role !== "media");
  const media = a.players.map((p, i) => ({ p, i })).filter((x) => x.p.role === "media");
  const rowCheck = (i: number) => a.checks.find((c) => c.index === i && !c.staff && c.level === "error") || a.checks.find((c) => c.index === i && !c.staff);
  const dupFor = (i: number) => a.duplicates.find((x) => x.index === i);
  const sizes = (() => {
    const m = new Map<string, number>();
    for (const p of [...a.players, ...a.staff]) if (p.kit_size) m.set(p.kit_size, (m.get(p.kit_size) || 0) + 1);
    return KIT_ORDER.filter((s) => m.has(s)).map((s) => [s, m.get(s)!] as const);
  })();
  const maxSize = Math.max(1, ...sizes.map(([, n]) => n));
  const medical = a.players.filter((p) => p.medical).length;
  // the viewer walks through the photos in the order the tables show them
  const ordered = [...field, ...media];
  const photos: (PhotoItem & { i: number })[] = ordered.filter((x) => x.p.photo_url).map(({ p, i }) => ({
    i,
    src: p.photo_url,
    name: fullName(p),
    meta: [p.number != null ? `№${p.number}` : "", ROLE_NAME[p.role], p.jersey_name ? `futbolkada ${p.jersey_name}` : "", p.birth_date ? fmtBirth(p.birth_date) : ""].filter(Boolean).join(" · "),
    file: `${a.team.short_name || "jamoa"}-${p.number ?? ""}-${fullName(p)}`.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") + (p.photo_url.match(/\.(webp|jpe?g|png|gif)(\?|$)/i)?.[0].replace("?", "") || ".webp"),
  }));

  const table = (rows: { p: Player; i: number }[]) => (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>№</th><th>Foto · o‘yinchi · ish joyi</th><th>Futbolkada</th><th className="hide-mobile">Tug‘ilgan</th><th>O‘lcham</th><th>Tibbiy</th><th>Tekshiruv</th></tr></thead>
      <tbody>{rows.map(({ p, i }) => {
        const c = rowCheck(i);
        const dup = dupFor(i);
        return (
          <tr key={i} className={c?.level === "error" ? "row-err" : c || dup ? "row-warn" : ""}>
            <td><span className="num-box">{p.number ?? "—"}</span></td>
            <td><div className="pl-cell"><PhotoThumb src={p.photo_url} name={fullName(p)} onOpen={() => setPhoto(photos.findIndex((x) => x.i === i))} /><div><b>{fullName(p)}</b>{p.role === "goalkeeper" && <span className="tag-mini">GK</span>}{p.role === "media" && <span className="tag-mini dark">Media</span>}<div className="muted small">{p.workplace || "ish joyi yo‘q"}</div></div></div></td>
            <td className="small"><b>{p.jersey_name || "—"}</b></td>
            <td className="hide-mobile nowrap">{fmtBirth(p.birth_date)}</td>
            <td>{p.kit_size ? <Badge plain>{p.kit_size}</Badge> : "—"}</td>
            <td>{p.medical ? <button className="link-btn small" onClick={() => openFile(p.medical!.file)}>Ochish</button> : <span className="muted small">Yo‘q</span>}</td>
            <td className="small">{dup ? <span>⚠ {dup.matches.map((m) => `${m.team_name || "jamoasiz"}${m.number != null ? ` #${m.number}` : ""}`).join(", ")}</span> : c ? <span className={c.level === "error" ? "danger-text" : ""}>{c.text.replace(/^[^:]+: /, "")}</span> : <span style={{ color: "var(--text-accent)" }}>✓</span>}</td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );

  return (
    <>
      <div className="crumbs small" style={{ marginBottom: 8 }}><Link to="/applications">Arizalar</Link> / <b>{a.number}</b></div>
      <PageHead title={a.team.name || "Nomsiz jamoa"} sub={<>{a.submitted_at ? `Yuborilgan ${fmtDateTime(a.submitted_at)}` : `Yaratilgan ${fmtDateTime(a.created_at)}`}{a.link ? ` · havola «${a.link.title}»` : ""}</>}
        actions={<>
          {mayDelete(can, a.status) && <button className="btn btn-icon danger-text" title="Arizani o‘chirish" aria-label="Arizani o‘chirish" onClick={() => setModal("delete")}><I.trash size={16} /></button>}
          <button className="btn btn-ghost" onClick={exportXlsx}><I.download size={16} /> TARKIB.xlsx</button>
          {canDecide && <>
            <button className="btn btn-ghost danger-text" onClick={() => setModal("reject")}>Rad etish</button>
            <button className="btn" onClick={() => setModal("changes")}>Tuzatishga qaytarish</button>
            <button className="btn btn-primary" onClick={() => setModal("approve")} disabled={errors.length > 0} title={errors.length ? "Avval xatolarni tuzatishga qaytaring" : undefined}>Tasdiqlash</button>
          </>}
          {a.status === "changes" && <button className="btn btn-ghost danger-text" onClick={() => setModal("reject")}>Rad etish</button>}
          {a.created_team && <Link className="btn btn-primary" to={`/teams/${a.created_team.id}`}>Jamoani ochish</Link>}
        </>} />
      {canDecide && errors.length > 0 && <div className="alert danger" style={{ marginBottom: 16 }}><I.alert size={16} /><div>Arizada {errors.length} ta xato bor — tasdiqlash mumkin emas. Tuzatishga qaytaring yoki rad eting.</div></div>}
      <div className="app-layout">
        <div className="stack" style={{ gap: 24 }}>
          <div className="card">
            <div className="card-head"><h3>Jamoa</h3></div>
            <div className="row card-pad" style={{ gap: 16 }}>
              <span className="crest" style={{ width: 72, height: 72, fontSize: 20 }}>{a.team.crest_url ? <img src={a.team.crest_url} alt="" /> : a.team.short_name}</span>
              <div><h3 style={{ fontSize: 22 }}>{a.team.name}</h3><div className="muted">{[a.team.short_name, a.team.city].filter(Boolean).join(" · ")}</div></div>
            </div>
            <div className="kv-list">
              <div><span>Logotip</span><span>{a.team.crest_url ? `${a.team.crest_w || "?"}×${a.team.crest_h || "?"}${a.team.crest_w && a.team.crest_w < 512 ? " (min 512)" : ""}` : "yuklanmagan"}</span></div>
              {a.team.instagram && <div><span>Instagram</span><span>{a.team.instagram}</span></div>}
              {a.team.about && <div><span>Jamoa haqida</span><span style={{ fontWeight: 400 }}>{a.team.about}</span></div>}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Vakil</h3></div>
            <div className="kv-list">
              <div><span>Ism</span><span>{a.rep.name || "—"} · {{ captain: "Kapitan", manager: "Menejer", coach: "Murabbiy", other: "Boshqa" }[a.rep.role] || a.rep.role}</span></div>
              <div><span>Telefon</span><span className="row" style={{ gap: 8 }}>{a.rep.phone || "—"}{a.phone_verified ? <Badge tone="ok">SMS orqali tasdiqlangan</Badge> : a.rep.phone && <Badge tone="warn">Tasdiqlanmagan</Badge>}</span></div>
              {a.rep.telegram && <div><span>Telegram</span><span>{a.rep.telegram}</span></div>}
              {a.rep.email && <div><span>Email</span><span>{a.rep.email}</span></div>}
            </div>
          </div>
          {a.rep_url && (
            <div className="card">
              <div className="card-head"><h3>Vakil havolasi</h3><span className="muted small">Jamoa havolani yo‘qotsa — shuni yuboring</span></div>
              <div className="card-pad stack" style={{ gap: 12 }}>
                <a className="rep-url" href={a.rep_url} target="_blank" rel="noopener noreferrer">{a.rep_url}</a>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button className="btn btn-sm" onClick={() => copy(a.rep_url, toast)}><I.copy size={15} /> Nusxalash</button>
                  <a className="btn btn-sm" href={tgShare(a.rep_url, `United MFL: «${a.team.name}» arizasi`)} target="_blank" rel="noopener noreferrer"><I.telegram size={15} /> Telegram orqali yuborish</a>
                </div>
              </div>
            </div>
          )}
          <div className="card">
            <div className="card-head"><h3>O‘yinchilar <span className="muted small">· {field.length}</span></h3><span className="muted small">{media.length} media · {a.staff.length} murabbiy</span></div>
            {field.length ? table(field) : <div className="card-pad muted">O‘yinchi yo‘q</div>}
          </div>
          {media.length > 0 && <div className="card"><div className="card-head"><h3>Media shaxslar <span className="muted small">· {media.length}</span></h3></div>{table(media)}</div>}
          <div className="card">
            <div className="card-head"><h3>Murabbiylar shtabi</h3></div>
            <div className="kv-list">
              {a.staff.length ? a.staff.map((s, i) => <div key={i}><span>{STAFF_ROLES[s.role] || s.role}</span><span>{fullName(s)}{s.birth_date ? ` · ${fmtBirth(s.birth_date)}` : ""}{s.kit_size ? ` · ${s.kit_size}` : ""}{s.phone ? ` · ${s.phone}` : ""}</span></div>) : <div><span>Ko‘rsatilmagan</span><span /></div>}
            </div>
          </div>
        </div>
        <aside>
          <div className="card">
            <div className="card-head"><h3>Holat</h3><Badge tone={st?.tone}>{st?.label || a.status}</Badge></div>
            <div className="kv-list">
              <div><span>Ariza</span><span>{a.number}</span></div>
              {a.link && <div><span>Havola</span><span><Link to={`/applications/links/${a.link.id}`}>{a.link.code}</Link></span></div>}
              {a.status === "changes" && a.changes_deadline && <div><span>Tuzatish muddati</span><span>{fmtDateTime(a.changes_deadline)}</span></div>}
              {a.decided_at && <div><span>Qaror</span><span>{fmtDateTime(a.decided_at)}</span></div>}
              {a.reject_reason && <div><span>Sabab</span><span style={{ fontWeight: 400 }}>{a.reject_reason}</span></div>}
            </div>
            {a.comments.length > 0 && <div className="card-pad stack" style={{ gap: 8, borderTop: "1px solid var(--n-100)" }}>
              <b className="small">Vakilga yuborilgan izohlar</b>
              {a.comments.map((c, i) => <div key={i} className="small"><b>{SECTIONS[c.section]}:</b> {c.text}</div>)}
            </div>}
          </div>
          <RosterLimitCard app={a} onSaved={d.reload} />
          <div className="card">
            <div className="card-head"><h3>Forma va hujjatlar</h3></div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              <div className="size-bars">{sizes.length ? sizes.map(([s, n]) => <div key={s}><span style={{ width: 34 }}>{s}</span><i><b style={{ width: `${(n / maxSize) * 100}%` }} /></i><span className="muted">{n}</span></div>) : <span className="muted small">O‘lchamlar kiritilmagan</span>}</div>
              <div className="row" style={{ justifyContent: "space-between" }}><span className="muted small">O‘yinchi fotosi</span><Badge tone={photos.length === a.players.length && photos.length > 0 ? "ok" : "warn"}>{photos.length} / {a.players.length}</Badge></div>
              <div className="row" style={{ justifyContent: "space-between" }}><span className="muted small">Tibbiy ruxsatnoma</span><Badge tone={medical === a.players.length && medical > 0 ? "ok" : "warn"}>{medical} / {a.players.length}</Badge></div>
              <button className="btn btn-block" onClick={exportXlsx}><I.download size={16} /> TARKIB.xlsx yuklab olish</button>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Avtomatik tekshiruv</h3><span className="muted small">{errors.length ? `${errors.length} xato` : ""}{errors.length && a.checks.length > errors.length ? " · " : ""}{a.checks.length > errors.length ? `${a.checks.length - errors.length} ogohlantirish` : ""}</span></div>
            <div className="card-pad check-list">
              {a.checks.length === 0 && <div className="ok"><I.check size={16} /> Muammo topilmadi</div>}
              {a.checks.filter((c) => c.section !== "submit").map((c, i) => <div key={i} className={c.level}><I.alert size={16} /><span>{c.text}</span></div>)}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Tarix</h3></div>
            <div className="card-pad events">
              {a.events.map((e, i) => <div key={i}><div><b>{EVENT[e.kind] || e.kind}</b><div className="muted small">{fmtDateTime(e.created_at)}{e.user ? ` · ${e.user}` : ""}</div>{e.note && <div className="small" style={{ whiteSpace: "pre-line", marginTop: 2 }}>{e.note}</div>}</div></div>)}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Ichki izoh</h3></div>
            <div className="card-pad stack" style={{ gap: 6 }}>
              <textarea className="textarea" value={note ?? a.internal_note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote} placeholder="Faqat adminlarga ko‘rinadi" />
              <span className="muted small">Faqat adminlarga ko‘rinadi</span>
            </div>
          </div>
        </aside>
      </div>
      {photo != null && photo >= 0 && <PhotoViewer items={photos} start={photo} onClose={() => setPhoto(null)} />}
      {modal === "approve" && <ApproveModal app={a} sms={!!cfg?.sms} onClose={() => setModal("")} onDone={() => { setModal(""); d.reload(); invalidateRefs(); }} />}
      {modal === "changes" && <ChangesModal app={a} sms={!!cfg?.sms} onClose={() => setModal("")} onDone={() => { setModal(""); d.reload(); }} />}
      {modal === "delete" && <DeleteModal id={a.id} onClose={() => setModal("")} onDone={() => nav("/applications")} />}
      {modal === "reject" && <RejectModal app={a} sms={!!cfg?.sms} onClose={() => setModal("")} onDone={() => { setModal(""); d.reload(); }} />}
    </>
  );
}

/* per-team roster limit: overrides the link's «Maks. kishi» for this application only */
function RosterLimitCard({ app, onSaved }: { app: AppDetail; onSaved: () => void }) {
  const toast = useToast();
  const [val, setVal] = useState(app.max_players != null ? String(app.max_players) : "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setVal(app.max_players != null ? String(app.max_players) : ""), [app.max_players]);
  const linkMax = app.link?.max_players ?? 21;
  const total = app.players.length + app.staff.length;
  const locked = app.status === "approved" || app.status === "rejected";
  const next = val.trim() === "" ? null : Number(val);
  const dirty = next !== app.max_players;

  async function save(v: number | null) {
    setErr("");
    if (v != null && (!Number.isInteger(v) || v < 1 || v > 70)) { setErr("1 dan 70 gacha son kiriting"); return; }
    setBusy(true);
    try {
      await api.patch(`/admin/applications/${app.id}`, { max_players: v });
      toast(v == null ? "Havola limiti qaytarildi" : `Limit: ${v} kishi`);
      onSaved();
    } catch (e: any) {
      if (e?.fields?.max_players) setErr(e.fields.max_players);
      toast(e instanceof Error ? e.message : "Saqlanmadi", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head"><h3>Tarkib limiti</h3><Badge tone={total > app.roster_max ? "danger" : "ok"}>{total} / {app.roster_max}</Badge></div>
      <div className="card-pad stack" style={{ gap: 10 }}>
        <Field label="Shu jamoa uchun maks. kishi" error={err} hint={`bo‘sh — havola bo‘yicha (${linkMax}); o‘yinchilar + media + murabbiylar`}>
          <input className="input" inputMode="numeric" value={val} placeholder={String(linkMax)} disabled={locked || busy}
            onChange={(e) => setVal(e.target.value.replace(/\D/g, "").slice(0, 2))}
            onKeyDown={(e) => { if (e.key === "Enter" && dirty) save(next); }} />
        </Field>
        {!locked && <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-sm btn-primary" disabled={!dirty || busy} onClick={() => save(next)}>Saqlash</button>
          {app.max_players != null && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => save(null)}>Havola limitiga qaytarish</button>}
        </div>}
        {app.max_players != null && <span className="muted small">Bu jamoa uchun alohida limit: {app.max_players} kishi (havolada {linkMax})</span>}
      </div>
    </div>
  );
}

function Toggle({ label, sub, checked, onChange }: { label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row"><span><b>{label}</b>{sub && <small>{sub}</small>}</span><input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} /></label>
  );
}

function ApproveModal({ app, sms, onClose, onDone }: { app: AppDetail; sms: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { groups } = useRefs();
  const [group, setGroup] = useState("");
  const [notify, setNotify] = useState(sms);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<Record<string, number>>(() => Object.fromEntries(app.duplicates.map((d) => [String(d.index), d.matches[0].player_id])));
  const field = app.players.filter((p) => p.role !== "media").length;
  const media = app.players.length - field;
  const skipped = Object.values(choice).filter((v) => v < 0).length;
  const moved = Object.values(choice).filter((v) => v > 0).length;
  async function go() {
    setBusy(true);
    try {
      await api.post(`/admin/applications/${app.id}/approve`, { group_id: group ? Number(group) : null, players: choice, notify });
      toast(`«${app.team.name}» jamoasi yaratildi`);
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Tasdiqlanmadi", "error");
      setBusy(false);
    }
  }
  return (
    <Modal wide title={`${app.team.name}’ni tasdiqlash`} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Bekor qilish</button>
      <button className="btn btn-primary" onClick={go} disabled={busy}>{busy ? "Yaratilmoqda…" : "Tasdiqlash va jamoani yaratish"}</button>
    </>}>
      <div className="stack" style={{ gap: 16 }}>
        <div className="check-list">
          <b className="small">Tasdiqlangandan keyin:</b>
          {[`«${app.team.name}» jamoasi yaratiladi`, `${app.players.length - skipped - moved} ta yangi o‘yinchi (${field} o‘yinchi, ${media} media shaxs, ko‘chirilganlardan tashqari) va ${app.staff.length} murabbiy qo‘shiladi`,
            moved ? `${moved} ta mavjud o‘yinchi boshqa jamoadan ko‘chiriladi` : "", "Logotip, ranglar, futbolka yozuvlari, o‘lchamlar va tibbiy fayllar o‘yinchi kartochkalariga o‘tadi"].filter(Boolean).map((t) => <div key={t} className="ok"><I.check size={16} /><span>{t}</span></div>)}
        </div>
        {app.duplicates.map((d) => {
          const p = app.players[d.index];
          const key = String(d.index);
          return (
            <div key={key} className="dup-box">
              <b className="small row" style={{ gap: 8 }}><span style={{ color: "var(--amber-500)" }}><I.alert size={16} /></span>{fullName(p)} — ligada shu ismli o‘yinchi bor</b>
              {d.matches.map((m) => (
                <label key={m.player_id} className="radio-line"><input type="radio" name={key} checked={choice[key] === m.player_id} onChange={() => setChoice({ ...choice, [key]: m.player_id })} />
                  <span><b>{m.team_name ? `«${m.team_name}»dan ko‘chirish` : "Jamoasiz o‘yinchini biriktirish"}</b>{m.number != null && ` (#${m.number})`}<div className="muted small">{m.birth_date ? `${m.full_name}, ${fmtBirth(m.birth_date)} · ` : ""}Statistika va matchlar tarixi saqlanadi</div></span></label>
              ))}
              <label className="radio-line"><input type="radio" name={key} checked={!choice[key]} onChange={() => setChoice({ ...choice, [key]: 0 })} /><span><b>Yangi o‘yinchi sifatida yaratish</b><div className="muted small">Boshqa odam bo‘lsa</div></span></label>
              <label className="radio-line"><input type="radio" name={key} checked={choice[key] === -1} onChange={() => setChoice({ ...choice, [key]: -1 })} /><span><b>Tarkibga qo‘shmaslik</b></span></label>
            </div>
          );
        })}
        <Field label="Guruh" hint="Bo‘sh qoldirsangiz — jamoa guruhsiz qo‘shiladi, keyin «Guruhlar»da biriktirasiz">
          <select className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Keyinroq — qur’adan keyin</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.code}</option>)}
          </select>
        </Field>
        {sms && <Toggle label="Vakilga SMS yuborish" sub="«Arizangiz tasdiqlandi» + holat sahifasi havolasi" checked={notify} onChange={setNotify} />}
      </div>
    </Modal>
  );
}

function ChangesModal({ app, sms, onClose, onDone }: { app: AppDetail; sms: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const suggest = (sec: string) => app.checks.filter((c) => c.section === sec).map((c) => c.text).join("\n");
  const [items, setItems] = useState<Record<string, { on: boolean; text: string }>>(() => Object.fromEntries(["team", "rep", "roster"].map((s) => {
    const t = suggest(s);
    return [s, { on: !!t, text: t }];
  })));
  const [days, setDays] = useState(7);
  const [notify, setNotify] = useState(sms);
  const [busy, setBusy] = useState(false);
  const comments = Object.entries(items).filter(([, v]) => v.on && v.text.trim()).map(([section, v]) => ({ section, text: v.text.trim() }));
  async function go() {
    setBusy(true);
    try {
      await api.post(`/admin/applications/${app.id}/request-changes`, { comments, days, notify });
      toast("Ariza tuzatishga qaytarildi");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
      setBusy(false);
    }
  }
  return (
    <Modal wide title="Tuzatishga qaytarish" onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Bekor qilish</button>
      <button className="btn btn-primary" onClick={go} disabled={busy || !comments.length}>{busy ? "Yuborilmoqda…" : "Tuzatishga yuborish"}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <span className="muted">Tuzatish kerak bo‘lgan bo‘limlarni belgilang va izoh yozing. Vakil faqat shu bo‘limlarni tahrirlay oladi, qolgani qulflanadi.</span>
        {Object.entries(SECTIONS).map(([s, label]) => (
          <div key={s} className={`sec-item${items[s].on ? " on" : ""}`}>
            <label className="check"><input type="checkbox" checked={items[s].on} onChange={(e) => setItems({ ...items, [s]: { ...items[s], on: e.target.checked } })} /> {label}</label>
            {items[s].on && <textarea className="textarea" value={items[s].text} onChange={(e) => setItems({ ...items, [s]: { ...items[s], text: e.target.value } })} placeholder="Nimani tuzatish kerak — vakil shu matnni ko‘radi" maxLength={1000} />}
          </div>
        ))}
        <Field label="Tuzatish muddati" hint="Muddat o‘tsa, ariza avtomatik «Rad etilgan» bo‘ladi">
          <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[3, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n} kun</option>)}</select>
        </Field>
        {sms && <Toggle label="Vakilga SMS yuborish" sub="Izohlar holat sahifasida ko‘rinadi" checked={notify} onChange={setNotify} />}
      </div>
    </Modal>
  );
}

function RejectModal({ app, sms, onClose, onDone }: { app: AppDetail; sms: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(sms);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await api.post(`/admin/applications/${app.id}/reject`, { reason, notify });
      toast("Ariza rad etildi");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
      setBusy(false);
    }
  }
  return (
    <Modal title="Arizani rad etish" onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Bekor qilish</button>
      <button className="btn btn-danger" onClick={go} disabled={busy || !reason.trim()}>Rad etish</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <Field label="Sabab" hint="Vakil shu matnni holat sahifasida ko‘radi"><textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} autoFocus /></Field>
        {sms && <Toggle label="Vakilga SMS yuborish" checked={notify} onChange={setNotify} />}
      </div>
    </Modal>
  );
}

/* ---------- links list ---------- */
function LinksList() {
  const nav = useNavigate();
  const links = useLoad(() => api.get<{ items: RegLink[] }>("/admin/registration/links"), []);
  return (
    <>
      <div className="crumbs small" style={{ marginBottom: 8 }}><Link to="/applications">Arizalar</Link> / <b>Havolalar</b></div>
      <PageHead title="Ro‘yxatga olish havolalari" sub="Har bir havola — alohida qabul: o‘z mavsumi, muddati, joylar soni va talablari bilan. Faol havola bo‘lmasa, ariza sayti «ro‘yxatdan o‘tish yopiq» deb ko‘rsatadi."
        actions={<Link className="btn btn-primary" to="/applications/links/new"><I.plus size={16} /> Yangi havola</Link>} />
      <div className="card">
        {links.error ? <div className="card-pad"><ErrorBox error={links.error} retry={links.reload} /></div> : !links.data ? <Loading /> : !links.data.items.length ? (
          <Empty title="Hali havola yo‘q" text="Havola yarating — jamoalar u orqali ariza yuboradi." action={<Link className="btn btn-primary" to="/applications/links/new"><I.plus size={16} /> Yangi havola</Link>} />
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Havola</th><th className="hide-mobile">Mavsum / bosqich</th><th className="hide-mobile">Qabul muddati</th><th>Joylar</th><th>Arizalar</th><th>Holat</th><th /></tr></thead>
            <tbody>{links.data.items.map((l) => (
              <tr key={l.id} className="clickable" onClick={() => nav(`/applications/links/${l.id}`)}>
                <td><div className="row"><I.link size={16} /><div><b>{l.title}</b>{l.is_default && <span className="tag-mini">Asosiy</span>}<div className="muted small">{l.url || `Kod: ${l.code}`}</div></div></div></td>
                <td className="hide-mobile">{l.season || "—"}<div className="muted small">{l.stage || "—"}</div></td>
                <td className="hide-mobile nowrap">{l.closes_at ? fmtDateTime(l.closes_at) : "Cheklanmagan"}{l.opens_at && <div className="muted small">{fmtDateTime(l.opens_at)} dan</div>}</td>
                <td className="nowrap">{l.max_teams ? `${l.approved} / ${l.max_teams} band` : `${l.approved} tasdiqlangan`}</td>
                <td className="nowrap">{l.sent}<div className="muted small">{l.drafts} qoralama</div></td>
                <td><Badge tone={LINK_STATE[l.state].tone}>{LINK_STATE[l.state].label}</Badge></td>
                <td className="actions" onClick={(e) => e.stopPropagation()}>{l.url && <LinkActions link={l} small />}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <div className="note-box" style={{ marginTop: 16 }}>«Joylar» — tasdiqlangan jamoalar. Limitga yetganda ariza sayti «Barcha joylar band» sahifasini ko‘rsatadi. «Asosiy» havola ariza saytining bosh sahifasida ochiladi.</div>
    </>
  );
}

/* ---------- link edit page ---------- */
const LINK_DEFAULTS: Partial<RegLink> = {
  title: "", kind: "multi", is_active: false, is_default: false, opens_at: null, closes_at: null, max_teams: null,
  min_players: 8, max_players: 21, min_age: null, require_logo: true, require_photo: false, require_medical: false, require_phone: true,
  check_duplicates: true, heading: "", description: "", rules_url: "", season_id: null, stage_id: null,
};

function LinkEdit() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { seasons, stages } = useRefs();
  const cfg = useRegConfig();
  const loaded = useLoad(() => (isNew ? Promise.resolve(null) : api.get<RegLink>(`/admin/registration/links/${id}`)), [id]);
  const [v, setV] = useState<Partial<RegLink> | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState(false);
  useEffect(() => {
    if (isNew) setV({ ...LINK_DEFAULTS, season_id: seasons.find((s) => s.is_active)?.id ?? seasons[0]?.id ?? null });
    else if (loaded.data) setV(loaded.data);
  }, [isNew, loaded.data, seasons]);
  const seasonStages = useMemo(() => stages.filter((s) => !v?.season_id || s.season_id === v.season_id), [stages, v?.season_id]);

  if (loaded.error) return <ErrorBox error={loaded.error} retry={loaded.reload} />;
  if (!v) return <Loading />;
  const set = <K extends keyof RegLink>(k: K, val: RegLink[K] | null) => setV((x) => ({ ...x!, [k]: val }));
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const saved = loaded.data;

  async function save() {
    setBusy(true);
    setErrs({});
    const body: Record<string, unknown> = {};
    for (const k of Object.keys(LINK_DEFAULTS) as (keyof RegLink)[]) body[k] = v![k] ?? null;
    for (const k of ["heading", "description", "rules_url", "title"]) body[k] = (v![k as keyof RegLink] as string) || "";
    try {
      if (isNew) {
        const r = await api.post<{ id: number }>("/admin/registration/links", body);
        toast("Havola yaratildi");
        nav(`/applications/links/${r.id}`, { replace: true });
      } else {
        await api.patch(`/admin/registration/links/${id}`, body);
        toast("Saqlandi");
        loaded.reload();
      }
    } catch (e: any) {
      if (e?.fields) setErrs(e.fields);
      toast(e instanceof Error ? e.message : "Saqlanmadi", "error");
    } finally {
      setBusy(false);
    }
  }
  async function regenerate() {
    if (!(await confirm({ title: "Havolani yangilash?", text: "Yangi kod yaratiladi, eski havola ishlamay qoladi. Boshlangan arizalar o‘z sahifasida davom etadi.", ok: "Yangilash", danger: true }))) return;
    try {
      await api.post(`/admin/registration/links/${id}/regenerate`);
      toast("Yangi havola yaratildi");
      loaded.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }
  async function remove() {
    if (!(await confirm({ title: "Havolani o‘chirish?", text: "Faqat ariza yuborilmagan havolani o‘chirish mumkin. Qoralamalar ham o‘chadi.", ok: "O‘chirish", danger: true }))) return;
    try {
      await api.del(`/admin/registration/links/${id}`);
      nav("/applications/links");
    } catch (e) {
      toast(e instanceof Error ? e.message : "O‘chirilmadi", "error");
    }
  }
  const card = (title: string, body: ReactNode) => <div className="card"><div className="card-head"><h3>{title}</h3></div><div className="card-pad stack" style={{ gap: 16 }}>{body}</div></div>;

  return (
    <>
      <div className="crumbs small" style={{ marginBottom: 8 }}><Link to="/applications">Arizalar</Link> / <Link to="/applications/links">Havolalar</Link> / <b>{isNew ? "Yangi" : saved?.code}</b></div>
      <PageHead title={isNew ? "Yangi havola" : saved?.title || "Havola"} actions={<>
        <Link className="btn btn-ghost" to="/applications/links">Bekor qilish</Link>
        <button className="btn btn-primary" onClick={save} disabled={busy || !v.title?.trim()}>{busy ? "Saqlanmoqda…" : isNew ? "Saqlash va havolani yaratish" : "Saqlash"}</button>
      </>} />
      <div className="app-layout">
        <div className="stack" style={{ gap: 24 }}>
          {card("Asosiy", <>
            <Field label="Nomi *" error={errs.title} hint="Faqat adminkada ko‘rinadi"><input className="input" value={v.title || ""} onChange={(e) => set("title", e.target.value)} placeholder="Mavsum 2027 — umumiy qabul" maxLength={120} /></Field>
            <div className="form-grid">
              <Field label="Mavsum"><select className="select" value={v.season_id ?? ""} onChange={(e) => { set("season_id", num(e.target.value)); set("stage_id", null); }}><option value="">—</option>{seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
              <Field label="Bosqich" hint="ariza sahifasida ko‘rsatiladi"><select className="select" value={v.stage_id ?? ""} onChange={(e) => set("stage_id", num(e.target.value))}><option value="">—</option>{seasonStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
              <Field label="Qabul boshlanishi" hint="bo‘sh — darhol"><input className="input" type="datetime-local" value={toLocalInput(v.opens_at)} onChange={(e) => set("opens_at", fromLocalInput(e.target.value))} /></Field>
              <Field label="Qabul tugashi" hint="bo‘sh — cheklanmagan" error={errs.closes_at}><input className="input" type="datetime-local" value={toLocalInput(v.closes_at)} onChange={(e) => set("closes_at", fromLocalInput(e.target.value))} /></Field>
              <Field label="Jamoalar limiti" hint="tasdiqlanganlar soni; bo‘sh — cheklanmagan" error={errs.max_teams}><input className="input" inputMode="numeric" value={v.max_teams ?? ""} onChange={(e) => set("max_teams", num(e.target.value.replace(/\D/g, "")))} /></Field>
            </div>
            <div className="field"><span className="label">Havola turi</span>
              <div className="seg seg-wide">
                <button type="button" aria-pressed={v.kind === "multi"} onClick={() => set("kind", "multi")}>Ko‘p martalik — barcha jamoalar uchun</button>
                <button type="button" aria-pressed={v.kind === "single"} onClick={() => set("kind", "single")}>Bir martalik — bitta jamoa uchun</button>
              </div>
            </div>
          </>)}
          {card("Talablar", <>
            <div className="form-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
              <Field label="Min. kishi" error={errs.min_players}><input className="input" inputMode="numeric" value={v.min_players ?? ""} onChange={(e) => set("min_players", num(e.target.value.replace(/\D/g, "")) ?? 0)} /></Field>
              <Field label="Maks. kishi" hint="o‘yinchilar + media + murabbiylar; alohida jamoaga — arizadagi «Tarkib limiti»" error={errs.max_players}><input className="input" inputMode="numeric" value={v.max_players ?? ""} onChange={(e) => set("max_players", num(e.target.value.replace(/\D/g, "")) ?? 0)} /></Field>
              <Field label="Min. yosh" hint="bo‘sh — tekshirilmaydi" error={errs.min_age}><input className="input" inputMode="numeric" value={v.min_age ?? ""} onChange={(e) => set("min_age", num(e.target.value.replace(/\D/g, "")))} /></Field>
            </div>
            <Toggle label="Logotip majburiy" sub="PNG/JPG, kamida 512×512 tavsiya etiladi" checked={!!v.require_logo} onChange={(x) => set("require_logo", x)} />
            <Toggle label="O‘yinchi fotosi majburiy" sub="O‘chiq bo‘lsa — ixtiyoriy" checked={!!v.require_photo} onChange={(x) => set("require_photo", x)} />
            <Toggle label="Tibbiy ruxsatnoma yuborishdan oldin majburiy" sub="O‘chiq bo‘lsa — keyin yuklash mumkin, ogohlantirish chiqadi" checked={!!v.require_medical} onChange={(x) => set("require_medical", x)} />
            <Toggle label="Telefonni SMS-kod bilan tasdiqlash" sub={cfg?.sms === "eskiz" ? "Eskiz orqali" : cfg?.sms === "dev" ? "Sinov rejimi: SMS yuborilmaydi, kod sahifada ko‘rinadi" : "SMS sozlanmagan (ESKIZ_EMAIL) — tasdiqlash so‘ralmaydi"} checked={!!v.require_phone} onChange={(x) => set("require_phone", x)} />
            <Toggle label="Boshqa jamoalardagi o‘yinchilarni tekshirish" sub="Ism-familiya bo‘yicha moslik" checked={!!v.check_duplicates} onChange={(x) => set("check_duplicates", x)} />
          </>)}
          {card("Sahifa matni", <>
            <Field label="Sarlavha" hint="bo‘sh — «Jamoangizni United MFL’ga ro‘yxatdan o‘tkazing»"><input className="input" value={v.heading || ""} onChange={(e) => set("heading", e.target.value)} maxLength={160} /></Field>
            <Field label="Tavsif"><textarea className="textarea" value={v.description || ""} onChange={(e) => set("description", e.target.value)} maxLength={2000} placeholder="Ariza 4 qadamda to‘ldiriladi, taxminan 10 daqiqa…" /></Field>
            <Field label="Reglament havolasi" hint="4-qadamda «Reglament bilan tanishdim» yonida chiqadi" error={errs.rules_url}><input className="input" type="url" value={v.rules_url || ""} onChange={(e) => set("rules_url", e.target.value)} placeholder="https://…" /></Field>
          </>)}
        </div>
        <aside>
          <div className="card">
            <div className="card-head"><h3>Holat</h3>{saved && <Badge tone={LINK_STATE[saved.state].tone}>{LINK_STATE[saved.state].label}</Badge>}</div>
            <div className="card-pad stack" style={{ gap: 14 }}>
              <Toggle label="Qabul ochiq" sub="O‘chiq bo‘lsa, havola «Ro‘yxatdan o‘tish hozircha yopiq» deb ko‘rsatadi" checked={!!v.is_active} onChange={(x) => set("is_active", x)} />
              <Toggle label="Asosiy sahifada ko‘rsatish" sub="Ariza saytining bosh sahifasi shu havolani ochadi" checked={!!v.is_default} onChange={(x) => set("is_default", x)} />
              {saved && (saved.is_active !== v.is_active || saved.is_default !== v.is_default) && <span className="small" style={{ color: "var(--amber-800)" }}>O‘zgarish «Saqlash»dan keyin kuchga kiradi</span>}
            </div>
          </div>
          {saved && (
            <div className="card">
              <div className="card-head"><h3>Havola</h3></div>
              <div className="card-pad stack" style={{ gap: 10 }}>
                <div className="url-box"><I.link size={16} /><b className="grow">{saved.url || saved.code}</b></div>
                {!saved.url && <span className="muted small">Ariza sayti manzili sozlanmagan (REGISTER_PUBLIC_URL) — hozircha faqat kod: <b>{saved.code}</b></span>}
                {saved.url && <div className="row wrap"><button className="btn btn-sm" onClick={() => copy(saved.url, toast)}><I.copy size={15} /> Nusxa olish</button><button className="btn btn-sm" onClick={() => setQr(true)}><I.qr size={15} /> QR-kod</button>
                  <a className="btn btn-sm" href={tgShare(saved.url, "United MFL: jamoa arizasi")} target="_blank" rel="noopener noreferrer"><I.telegram size={15} /> Ulashish</a></div>}
                <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                  <button className="link-btn danger-text small" style={{ alignSelf: "flex-start" }} onClick={regenerate}>Havolani yangilash</button>
                  <span className="muted small">Yangi kod yaratiladi, eski havola ishlamay qoladi.</span>
                </div>
                <div className="muted small">{saved.sent} ariza · {saved.drafts} qoralama · {saved.approved} tasdiqlangan</div>
              </div>
            </div>
          )}
          {saved && saved.sent === 0 && <button className="btn btn-ghost danger-text" onClick={remove}><I.trash size={16} /> Havolani o‘chirish</button>}
          <div className="note-box">Arizalar «Administrator» va «Muharrir» rollariga ko‘rinadi — «Rollar va huquqlar»da «Jamoa arizalari».</div>
        </aside>
      </div>
      {qr && saved?.url && <QrModal url={saved.url} title={saved.title} onClose={() => setQr(false)} />}
    </>
  );
}

export function ApplicationsSection() {
  return (
    <Routes>
      <Route index element={<ApplicationsList />} />
      <Route path="links" element={<LinksList />} />
      <Route path="links/new" element={<LinkEdit />} />
      <Route path="links/:id" element={<LinkEdit />} />
      <Route path="changes" element={<ChangesList />} />
      <Route path="changes/:id" element={<ChangeReview />} />
      <Route path="cabinets" element={<CabinetsList />} />
      <Route path="cabinets/:id" element={<CabinetPage />} />
      <Route path=":id" element={<ApplicationReview />} />
    </Routes>
  );
}
