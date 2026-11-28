import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router";
import QRCode from "qrcode";
import { api, blobUrl } from "@/lib/api";
import { useAuth, Allowed } from "@/lib/auth";
import { useDebounced, useLoad } from "@/lib/hooks";
import { fmtDateTime, fmtShort, fromLocalInput, initials, toLocalInput } from "@/lib/format";
import { invalidateRefs, useRefs } from "@/lib/refs";
import { PageHead } from "@/components/Layout";
import { Badge, Empty, ErrorBox, Field, Loading, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { PhotoThumb, PhotoViewer, type PhotoItem } from "@/components/PlayerPhotos";
import { ArizalarTabs, CabinetPage, CabinetsList, ChangeReview, ChangesList } from "./TeamCabinets";

import { tx } from "@/lib/i18n";
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
  draft: { label: tx("Qoralama"), tone: "" },
  submitted: { label: tx("Yangi"), tone: "dark" },
  review: { label: tx("Ko‘rib chiqilmoqda"), tone: "info" },
  changes: { label: tx("Tuzatish kerak"), tone: "warn" },
  approved: { label: tx("Tasdiqlangan"), tone: "ok" },
  rejected: { label: tx("Rad etilgan"), tone: "danger" },
};
const LINK_STATE: Record<LinkState, { label: string; tone: string }> = {
  open: { label: tx("Faol"), tone: "ok" },
  paused: { label: tx("To‘xtatilgan"), tone: "" },
  soon: { label: tx("Hali boshlanmagan"), tone: "info" },
  closed: { label: tx("Muddati tugagan"), tone: "danger" },
  full: { label: tx("Joylar to‘ldi"), tone: "warn" },
  used: { label: tx("Ishlatilgan"), tone: "" },
};
const EVENT: Record<string, string> = {
  created: tx("Qoralama yaratildi"), phone_verified: tx("Telefon tasdiqlandi"), submitted: tx("Ariza yuborildi"), resubmitted: tx("Tuzatilib qayta yuborildi"),
  review: tx("Ko‘rib chiqish boshlandi"), changes: tx("Tuzatishga qaytarildi"), approved: tx("Tasdiqlandi"), rejected: tx("Rad etildi"), expired: tx("Tuzatish muddati o‘tdi"),
  limit: tx("Tarkib limiti o‘zgartirildi"),
};
const SECTIONS: Record<string, string> = { team: tx("Jamoa"), rep: tx("Vakil"), roster: tx("Tarkib") };
const STAFF_ROLES: Record<string, string> = { head_coach: tx("Bosh murabbiy"), assistant: tx("Yordamchi"), gk_coach: tx("Darvozabonlar murabbiyi"), fitness: tx("Jismoniy tayyorgarlik"), doctor: tx("Shifokor"), manager: tx("Menejer"), other: tx("Boshqa") };
const KIT_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];
const fullName = (p: { first_name: string; last_name: string }) => `${p.first_name} ${p.last_name}`.trim();
const ROLE_NAME: Record<Player["role"], string> = { player: tx("Maydon o‘yinchisi"), goalkeeper: tx("Darvozabon"), media: tx("Media shaxs") };
const fmtBirth = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split("-").reverse().join(".") : d || "—");

function useRegConfig() {
  return useLoad(() => api.get<{ register_url: string; sms: string }>("/admin/registration/config"), []).data;
}

/* ---------- shared: copy / QR / share ---------- */
async function copy(text: string, toast: (t: string, k?: "ok" | "error") => void) {
  try {
    await navigator.clipboard.writeText(text);
    toast(tx("Havola nusxalandi"));
  } catch {
    toast(tx("Nusxalab bo‘lmadi — havolani qo‘lda belgilang"), "error");
  }
}
function QrModal({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(url, { width: 880, margin: 2, errorCorrectionLevel: "M" }).then(setSrc).catch(() => setSrc(""));
  }, [url]);
  return (
    <Modal title={tx("QR-kod")} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{tx("Yopish")}</button>
      {src && <a className="btn btn-primary" href={src} download={`QR-${title.replace(/[^\p{L}\p{N}]+/gu, "-")}.png`}><I.download size={16} />{" "}{tx("PNG yuklab olish")}</a>}
    </>}>
      <div className="stack" style={{ alignItems: "center", gap: 12 }}>
        {src ? <img className="qr-img" src={src} alt={tx("QR: {0}", url)} /> : <Loading />}
        <b style={{ wordBreak: "break-all", textAlign: "center" }}>{url}</b>
        <span className="muted small" style={{ textAlign: "center" }}>{tx("Afisha, post yoki chatga qo‘ying — skaner qilganda ariza sahifasi ochiladi.")}</span>
      </div>
    </Modal>
  );
}
const tgShare = (url: string, text: string) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;

function LinkActions({ link, small }: { link: RegLink; small?: boolean }) {
  const toast = useToast();
  const [qr, setQr] = useState(false);
  if (!link.url) return <span className="muted small">{tx("Kod:")}{" "}<b>{link.code}</b></span>;
  const cls = tx("btn{0}", small ? " btn-sm" : "");
  return (
    <>
      <button className={`${cls} btn-ghost`} onClick={(e) => { e.stopPropagation(); copy(link.url, toast); }}><I.copy size={15} />{" "}{tx("Nusxa olish")}</button>
      <button className={cls} onClick={(e) => { e.stopPropagation(); setQr(true); }}><I.qr size={15} />{" "}{tx("QR-kod")}</button>
      <a className={cls} href={tgShare(link.url, tx("United MFL: jamoa arizasi"))} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}><I.telegram size={15} />{" "}{tx("Telegramda ulashish")}</a>
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

// with «Arizalar — o‘chirish» any application; drafts and rejected ones also with «tahrirlash»
const mayDelete = (can: (perm: string) => boolean, status: string) => can("applications:delete") || ((status === "draft" || status === "rejected") && can("applications:edit"));

async function downloadXlsx(id: number, name: string, toast: ToastFn) {
  try {
    const u = await blobUrl(`/admin/applications/${id}/export.xlsx`);
    const el = document.createElement("a");
    el.href = u;
    el.download = `TARKIB-${name}.xlsx`;
    el.click();
  } catch (e) {
    toast(e instanceof Error ? e.message : tx("Yuklab bo‘lmadi"), "error");
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
      <button ref={btn} type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={tx("Amallar")} aria-haspopup="menu" aria-expanded={!!pos} onClick={toggle}><I.more size={16} /></button>
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
  const name = info?.team_name || tx("Nomsiz jamoa");

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
      toast(tx("«{0}» arizasi o‘chirildi{1}", name, res?.team_deleted ? " — jamoa ham o‘chirildi" : ""));
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("O‘chirilmadi"), "error");
      setBusy(false);
    }
  }

  const teamText = team ? tx("{0} o‘yinchi{1}{2} bilan birga. ", team.players, team.media ? `, ${team.media} media shaxs` : "", team.staff ? ` va ${team.staff} murabbiy` : "") +
    (team.played ? tx("Jamoa {0} ta matchda o‘ynagan.", team.played) : tx("Jamoa hali birorta matchda o‘ynamagan.")) : "";
  return (
    <Modal title={info?.confirm_number ? tx("Tasdiqlangan arizani o‘chirish") : tx("Arizani o‘chirish")} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{tx("Bekor qilish")}</button>
      <button className="btn btn-destructive" onClick={go} disabled={!info || !info.can_delete || !numberOk || busy}>
        {busy ? tx("O‘chirilmoqda…") : teamOn ? tx("Ariza va jamoani o‘chirish") : tx("Arizani o‘chirish")}
      </button>
    </>}>
      {d.error ? <ErrorBox error={d.error} retry={d.reload} /> : !info ? <Loading /> : (
        <div className="stack" style={{ gap: 16 }}>
          {!info.can_delete && <div className="alert danger"><I.lock size={16} /><div>{tx("Bu arizani faqat administrator o‘chira oladi.")}</div></div>}
          {!info.confirm_number ? (
            <>
              <div className="muted">{tx("«{0}» ({1}) arizasi butunlay o‘chiriladi. Bu amalni qaytarib bo‘lmaydi.", name, info.number)}</div>
              <b className="small">{tx("O‘chiriladi:")}</b>
              <div className="del-list">
                <div><I.trash size={16} /><span>{tx("Ariza va tarkib — {0} kishi", info.players)}{info.staff ? tx(", {0} murabbiy", info.staff) : ""}</span></div>
                <div><I.trash size={16} /><span>{tx("Yuklangan logotip, fotolar")}{info.medical_files ? tx(" va {0} ta tibbiy ruxsatnoma", info.medical_files) : ""}</span></div>
                <div><I.trash size={16} /><span>{tx("Tarix va ichki izoh")}</span></div>
              </div>
              {!team && <div className="muted small">{tx("Jamoa yaratilmagan: ariza hali tasdiqlanmagan, saytga hech narsa chiqmagan.")}</div>}
            </>
          ) : (
            <>
              {team ? (
                <div className="alert danger"><I.alert size={16} /><div><b>{tx("Ariza asosida «{0}» jamoasi yaratilgan.", team.name)}</b><div>{tx("Faqat ariza o‘chirilsa, jamoa, o‘yinchilar va shtab saytda qoladi.")}</div></div></div>
              ) : (
                <div className="del-note"><I.alert size={16} />{tx("Ariza asosida yaratilgan jamoa allaqachon o‘chirilgan.")}</div>
              )}
              <b className="small">{tx("Nimani o‘chiramiz?")}</b>
              <label className="del-opt locked"><input type="checkbox" checked disabled /><span><b>{tx("Arizani o‘chirish")}</b><small>{info.number}{tx(", tarkib, fayllar, tarix va ichki izoh. Doim o‘chiriladi.")}</small></span></label>
              {team && (
                <label className={`del-opt${teamOn ? " on" : ""}${info.can_delete_team ? "" : " locked"}`}>
                  <input type="checkbox" checked={teamOn} disabled={!info.can_delete_team} onChange={(e) => setWithTeam(e.target.checked)} />
                  <span><b>{tx("«{0}» jamoasini ham o‘chirish", team.name)}</b><small>{teamText}</small></span>
                </label>
              )}
              {team && team.played > 0 && <div className="del-note"><I.lock size={16} />{tx("Jamoa matchlarda o‘ynagan — statistika buzilmasligi uchun jamoa o‘chirilmaydi, faqat ariza o‘chadi.")}</div>}
              {teamOn && team && team.kept > 0 && <div className="del-note"><I.users size={16} />{team.kept}{" "}{tx("ta o‘yinchi boshqa jamoadan ko‘chirilgan yoki keyin qo‘shilgan — ular o‘chirilmaydi, jamoasiz qoladi.")}</div>}
              {teamOn && team && team.scheduled > 0 && <div className="del-note"><I.calendar size={16} />{team.scheduled}{" "}{tx("ta rejadagi matchda bu jamoa o‘rni bo‘sh qoladi.")}</div>}
              {info.frees_slot && <div className="del-note"><I.link size={16} />{tx("Havolada 1 joy bo‘shaydi.")}</div>}
              <Field label={tx("Tasdiqlash uchun ariza raqamini yozing: {0}", info.number)} hint={tx("Raqam to‘g‘ri yozilmaguncha «O‘chirish» tugmasi faol bo‘lmaydi")}>
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
  const chips: [string, string, number][] = [["", tx("Hammasi"), sent], ["submitted", tx("Yangi"), c.submitted || 0], ["review", tx("Ko‘rib chiqilmoqda"), c.review || 0],
    ["changes", tx("Tuzatishda"), c.changes || 0], ["approved", tx("Tasdiqlangan"), c.approved || 0], ["rejected", tx("Rad etilgan"), c.rejected || 0], ["draft", tx("Qoralamalar"), c.draft || 0]];
  const active = open[0];

  return (
    <>
      <PageHead title={tx("Jamoa arizalari")} sub={active ? tx("{0} · {1} ta ariza{2}", active.title, sent, active.max_teams ? ` · ${active.max_teams} joydan ${active.slots_left} tasi bo‘sh` : "") : tx("Jamoalar alohida ro‘yxatdan o‘tish sayti orqali ariza yuboradi")}
        actions={<>
          <Link className="btn" to="/applications/links"><I.link size={16} />{" "}{tx("Havolalar")}</Link>
          <Allowed to="create"><Link className="btn btn-primary" to="/applications/links/new"><I.plus size={16} />{" "}{tx("Yangi havola")}</Link></Allowed>
        </>} />
      <ArizalarTabs current="apps" />
      {links.data && (active ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="link-banner">
            <span className="ic"><I.link size={20} /></span>
            <div className="grow" style={{ minWidth: 220 }}>
              <div className="row" style={{ gap: 8 }}><b>{active.title}</b><Badge tone="ok">{tx("Faol")}</Badge>{active.is_default && <Badge plain>{tx("Asosiy sahifada")}</Badge>}</div>
              <div className="muted small" style={{ marginTop: 2 }}>{active.url || tx("Kod: {0}", active.code)}{active.closes_at ? tx(" · {0} gacha", fmtDateTime(active.closes_at)) : ""}{" "}{tx("· {0} ariza", active.sent)}{active.max_teams ? tx(" · {0}/{1} joy", active.approved, active.max_teams) : ""}</div>
            </div>
            <LinkActions link={active} />
          </div>
        </div>
      ) : (
        <div className="alert warn" style={{ marginBottom: 16 }}>
          <I.lock size={16} />
          <div className="grow"><b>{tx("Ro‘yxatdan o‘tish yopiq.")}</b>{" "}{tx("Ariza sayti hozir «Ro‘yxatdan o‘tish hozircha yopiq» deb ko‘rsatadi. Qabulni ochish uchun havola yarating va uni faollashtiring.")}</div>
          <Link className="btn btn-sm" to={links.data.items.length ? "/applications/links" : "/applications/links/new"}>{links.data.items.length ? tx("Havolalarni ochish") : tx("Havola yaratish")}</Link>
        </div>
      ))}
      <div className="card">
        <div className="toolbar">
          <div className="search" style={{ width: 280 }}><I.search size={16} /><input className="input input-sm" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={tx("Jamoa, vakil yoki telefon…")} aria-label={tx("Qidirish")} /></div>
          <div className="chips">
            {chips.map(([k, label, n]) => <button key={k} className="chip" aria-pressed={status === k} onClick={() => { setStatus(k); setPage(1); }}>{label} <span className="muted">{n}</span></button>)}
          </div>
        </div>
        {data.error ? <div className="card-pad"><ErrorBox error={data.error} retry={data.reload} /></div> : !data.data ? <Loading /> : !data.data.items.length ? (
          <Empty title={status === "draft" ? tx("Qoralama yo‘q") : tx("Hali ariza yo‘q")} text={tx("Jamoa vakillari havola orqali ariza yuborganda shu yerda ko‘rinadi.")} />
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{tx("Jamoa")}</th><th>{tx("Vakil")}</th><th>{tx("Tarkib")}</th><th className="hide-mobile">{tx("Tekshiruv")}</th><th className="hide-mobile">{tx("Yuborilgan")}</th><th>{tx("Holat")}</th><th /></tr></thead>
            <tbody>{data.data.items.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => nav(`/applications/${a.id}`)}>
                <td><div className="row">
                  <span className="crest" style={{ width: 32, height: 32, fontSize: 11 }}>{a.team.crest_url ? <img src={a.team.crest_url} alt="" /> : a.team.short_name || initials(a.team.name || "?")}</span>
                  <div><b>{a.team.name || tx("Nomsiz")}</b><div className="muted small">{a.number}{a.link ? ` · ${a.link.title}` : ""}</div></div>
                </div></td>
                <td>{a.rep.name || <span className="muted">—</span>}<div className="muted small">{a.rep.phone}{a.phone_verified && " ✓"}</div></td>
                <td className="nowrap">{a.players}{" "}{tx("o‘yinchi")}<div className="muted small">{a.media}{" "}{tx("media · {0} murabbiy", a.staff)}</div></td>
                <td className="hide-mobile">{a.errors ? <span className="danger-text small row" style={{ gap: 6 }}><I.alert size={14} />{" "}{tx("{0} xato", a.errors)}</span> : a.warnings ? <span className="small row" style={{ gap: 6 }}><span style={{ color: "var(--amber-500)" }}><I.alert size={14} /></span>{" "}{tx("{0} ogohlantirish", a.warnings)}</span> : <span className="small row" style={{ gap: 6, color: "var(--text-accent)" }}><I.check size={14} />{" "}{tx("Muammo yo‘q")}</span>}</td>
                <td className="hide-mobile nowrap">{fmtShort(a.submitted_at || a.updated_at)}</td>
                <td><Badge tone={STATUS[a.status]?.tone}>{STATUS[a.status]?.label || a.status}</Badge>{a.status === "changes" && a.changes_deadline && <div className="muted small">{tx("{0} gacha", fmtShort(a.changes_deadline))}</div>}</td>
                <td className="actions"><RowMenu items={[
                  { label: tx("Ko‘rish"), icon: <I.eye size={16} />, onClick: () => nav(`/applications/${a.id}`) },
                  { label: tx("TARKIB.xlsx yuklab olish"), icon: <I.download size={16} />, onClick: () => downloadXlsx(a.id, a.team.short_name || String(a.id), toast) },
                  ...(mayDelete(can, a.status) ? ["sep" as const, { label: tx("O‘chirish…"), icon: <I.trash size={16} />, danger: true, onClick: () => setDelId(a.id) }] : []),
                ]} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {data.data && data.data.total > 50 && (
          <div className="row" style={{ justifyContent: "space-between", padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
            <span className="muted small">{tx("Jami:")}{" "}{data.data.total}</span>
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
      toast(e instanceof Error ? e.message : tx("Fayl ochilmadi"), "error");
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
      toast(e instanceof Error ? e.message : tx("Yuklab bo‘lmadi"), "error");
    }
  }
  async function saveNote() {
    if (note == null || note === a.internal_note) return;
    try {
      await api.patch(`/admin/applications/${a.id}`, { internal_note: note });
      toast(tx("Izoh saqlandi"));
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Saqlanmadi"), "error");
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
      <thead><tr><th>№</th><th>{tx("Foto · o‘yinchi · ish joyi")}</th><th>{tx("Futbolkada")}</th><th className="hide-mobile">{tx("Tug‘ilgan")}</th><th>{tx("O‘lcham")}</th><th>{tx("Tibbiy")}</th><th>{tx("Tekshiruv")}</th></tr></thead>
      <tbody>{rows.map(({ p, i }) => {
        const c = rowCheck(i);
        const dup = dupFor(i);
        return (
          <tr key={i} className={c?.level === "error" ? "row-err" : c || dup ? "row-warn" : ""}>
            <td><span className="num-box">{p.number ?? "—"}</span></td>
            <td><div className="pl-cell"><PhotoThumb src={p.photo_url} name={fullName(p)} onOpen={() => setPhoto(photos.findIndex((x) => x.i === i))} /><div><b>{fullName(p)}</b>{p.role === "goalkeeper" && <span className="tag-mini">{tx("GK")}</span>}{p.role === "media" && <span className="tag-mini dark">{tx("Media")}</span>}<div className="muted small">{p.workplace || tx("ish joyi yo‘q")}</div></div></div></td>
            <td className="small"><b>{p.jersey_name || "—"}</b></td>
            <td className="hide-mobile nowrap">{fmtBirth(p.birth_date)}</td>
            <td>{p.kit_size ? <Badge plain>{p.kit_size}</Badge> : "—"}</td>
            <td>{p.medical ? <button className="link-btn small" onClick={() => openFile(p.medical!.file)}>{tx("Ochish")}</button> : <span className="muted small">{tx("Yo‘q")}</span>}</td>
            <td className="small">{dup ? <span>⚠ {dup.matches.map((m) => `${m.team_name || tx("jamoasiz")}${m.number != null ? ` #${m.number}` : ""}`).join(", ")}</span> : c ? <span className={c.level === "error" ? "danger-text" : ""}>{c.text.replace(/^[^:]+: /, "")}</span> : <span style={{ color: "var(--text-accent)" }}>✓</span>}</td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );

  return (
    <>
      <div className="crumbs small" style={{ marginBottom: 8 }}><Link to="/applications">{tx("Arizalar")}</Link> / <b>{a.number}</b></div>
      <PageHead title={a.team.name || tx("Nomsiz jamoa")} sub={<>{a.submitted_at ? tx("Yuborilgan {0}", fmtDateTime(a.submitted_at)) : tx("Yaratilgan {0}", fmtDateTime(a.created_at))}{a.link ? tx(" · havola «{0}»", a.link.title) : ""}</>}
        actions={<>
          {mayDelete(can, a.status) && <button className="btn btn-icon danger-text" title={tx("Arizani o‘chirish")} aria-label={tx("Arizani o‘chirish")} onClick={() => setModal("delete")}><I.trash size={16} /></button>}
          <button className="btn btn-ghost" onClick={exportXlsx}><I.download size={16} />{" "}{tx("TARKIB.xlsx")}</button>
          {canDecide && <>
            <button className="btn btn-ghost danger-text" onClick={() => setModal("reject")}>{tx("Rad etish")}</button>
            <button className="btn" onClick={() => setModal("changes")}>{tx("Tuzatishga qaytarish")}</button>
            <button className="btn btn-primary" onClick={() => setModal("approve")} disabled={errors.length > 0} title={errors.length ? tx("Avval xatolarni tuzatishga qaytaring") : undefined}>{tx("Tasdiqlash")}</button>
          </>}
          {a.status === "changes" && <button className="btn btn-ghost danger-text" onClick={() => setModal("reject")}>{tx("Rad etish")}</button>}
          {a.created_team && <Link className="btn btn-primary" to={`/teams/${a.created_team.id}`}>{tx("Jamoani ochish")}</Link>}
        </>} />
      {canDecide && errors.length > 0 && <div className="alert danger" style={{ marginBottom: 16 }}><I.alert size={16} /><div>{tx("Arizada {0} ta xato bor — tasdiqlash mumkin emas. Tuzatishga qaytaring yoki rad eting.", errors.length)}</div></div>}
      <div className="app-layout">
        <div className="stack" style={{ gap: 24 }}>
          <div className="card">
            <div className="card-head"><h3>{tx("Jamoa")}</h3></div>
            <div className="row card-pad" style={{ gap: 16 }}>
              <span className="crest" style={{ width: 72, height: 72, fontSize: 20 }}>{a.team.crest_url ? <img src={a.team.crest_url} alt="" /> : a.team.short_name}</span>
              <div><h3 style={{ fontSize: 22 }}>{a.team.name}</h3><div className="muted">{[a.team.short_name, a.team.city].filter(Boolean).join(" · ")}</div></div>
            </div>
            <div className="kv-list">
              <div><span>{tx("Logotip")}</span><span>{a.team.crest_url ? `${a.team.crest_w || "?"}×${a.team.crest_h || "?"}${a.team.crest_w && a.team.crest_w < 512 ? tx(" (min 512)") : ""}` : tx("yuklanmagan")}</span></div>
              {a.team.instagram && <div><span>{tx("Instagram")}</span><span>{a.team.instagram}</span></div>}
              {a.team.about && <div><span>{tx("Jamoa haqida")}</span><span style={{ fontWeight: 400 }}>{a.team.about}</span></div>}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>{tx("Vakil")}</h3></div>
            <div className="kv-list">
              <div><span>{tx("Ism")}</span><span>{a.rep.name || "—"} · {{ captain: tx("Kapitan"), manager: tx("Menejer"), coach: tx("Murabbiy"), other: tx("Boshqa") }[a.rep.role] || a.rep.role}</span></div>
              <div><span>{tx("Telefon")}</span><span className="row" style={{ gap: 8 }}>{a.rep.phone || "—"}{a.phone_verified ? <Badge tone="ok">{tx("SMS orqali tasdiqlangan")}</Badge> : a.rep.phone && <Badge tone="warn">{tx("Tasdiqlanmagan")}</Badge>}</span></div>
              {a.rep.telegram && <div><span>{tx("Telegram")}</span><span>{a.rep.telegram}</span></div>}
              {a.rep.email && <div><span>{tx("Email")}</span><span>{a.rep.email}</span></div>}
            </div>
          </div>
          {a.rep_url && (
            <div className="card">
              <div className="card-head"><h3>{tx("Vakil havolasi")}</h3><span className="muted small">{tx("Jamoa havolani yo‘qotsa — shuni yuboring")}</span></div>
              <div className="card-pad stack" style={{ gap: 12 }}>
                <a className="rep-url" href={a.rep_url} target="_blank" rel="noopener noreferrer">{a.rep_url}</a>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button className="btn btn-sm" onClick={() => copy(a.rep_url, toast)}><I.copy size={15} />{" "}{tx("Nusxalash")}</button>
                  <a className="btn btn-sm" href={tgShare(a.rep_url, tx("United MFL: «{0}» arizasi", a.team.name))} target="_blank" rel="noopener noreferrer"><I.telegram size={15} />{" "}{tx("Telegram orqali yuborish")}</a>
                </div>
              </div>
            </div>
          )}
          <div className="card">
            <div className="card-head"><h3>{tx("O‘yinchilar")}{" "}<span className="muted small">· {field.length}</span></h3><span className="muted small">{media.length}{" "}{tx("media · {0} murabbiy", a.staff.length)}</span></div>
            {field.length ? table(field) : <div className="card-pad muted">{tx("O‘yinchi yo‘q")}</div>}
          </div>
          {media.length > 0 && <div className="card"><div className="card-head"><h3>{tx("Media shaxslar")}{" "}<span className="muted small">· {media.length}</span></h3></div>{table(media)}</div>}
          <div className="card">
            <div className="card-head"><h3>{tx("Murabbiylar shtabi")}</h3></div>
            <div className="kv-list">
              {a.staff.length ? a.staff.map((s, i) => <div key={i}><span>{STAFF_ROLES[s.role] || s.role}</span><span>{fullName(s)}{s.birth_date ? ` · ${fmtBirth(s.birth_date)}` : ""}{s.kit_size ? ` · ${s.kit_size}` : ""}{s.phone ? ` · ${s.phone}` : ""}</span></div>) : <div><span>{tx("Ko‘rsatilmagan")}</span><span /></div>}
            </div>
          </div>
        </div>
        <aside>
          <div className="card">
            <div className="card-head"><h3>{tx("Holat")}</h3><Badge tone={st?.tone}>{st?.label || a.status}</Badge></div>
            <div className="kv-list">
              <div><span>{tx("Ariza")}</span><span>{a.number}</span></div>
              {a.link && <div><span>{tx("Havola")}</span><span><Link to={`/applications/links/${a.link.id}`}>{a.link.code}</Link></span></div>}
              {a.status === "changes" && a.changes_deadline && <div><span>{tx("Tuzatish muddati")}</span><span>{fmtDateTime(a.changes_deadline)}</span></div>}
              {a.decided_at && <div><span>{tx("Qaror")}</span><span>{fmtDateTime(a.decided_at)}</span></div>}
              {a.reject_reason && <div><span>{tx("Sabab")}</span><span style={{ fontWeight: 400 }}>{a.reject_reason}</span></div>}
            </div>
            {a.comments.length > 0 && <div className="card-pad stack" style={{ gap: 8, borderTop: "1px solid var(--n-100)" }}>
              <b className="small">{tx("Vakilga yuborilgan izohlar")}</b>
              {a.comments.map((c, i) => <div key={i} className="small"><b>{SECTIONS[c.section]}:</b> {c.text}</div>)}
            </div>}
          </div>
          <RosterLimitCard app={a} onSaved={d.reload} />
          <div className="card">
            <div className="card-head"><h3>{tx("Forma va hujjatlar")}</h3></div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              <div className="size-bars">{sizes.length ? sizes.map(([s, n]) => <div key={s}><span style={{ width: 34 }}>{s}</span><i><b style={{ width: `${(n / maxSize) * 100}%` }} /></i><span className="muted">{n}</span></div>) : <span className="muted small">{tx("O‘lchamlar kiritilmagan")}</span>}</div>
              <div className="row" style={{ justifyContent: "space-between" }}><span className="muted small">{tx("O‘yinchi fotosi")}</span><Badge tone={photos.length === a.players.length && photos.length > 0 ? "ok" : "warn"}>{photos.length} / {a.players.length}</Badge></div>
              <div className="row" style={{ justifyContent: "space-between" }}><span className="muted small">{tx("Tibbiy ruxsatnoma")}</span><Badge tone={medical === a.players.length && medical > 0 ? "ok" : "warn"}>{medical} / {a.players.length}</Badge></div>
              <button className="btn btn-block" onClick={exportXlsx}><I.download size={16} />{" "}{tx("TARKIB.xlsx yuklab olish")}</button>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>{tx("Avtomatik tekshiruv")}</h3><span className="muted small">{errors.length ? tx("{0} xato", errors.length) : ""}{errors.length && a.checks.length > errors.length ? " · " : ""}{a.checks.length > errors.length ? tx("{0} ogohlantirish", a.checks.length - errors.length) : ""}</span></div>
            <div className="card-pad check-list">
              {a.checks.length === 0 && <div className="ok"><I.check size={16} />{" "}{tx("Muammo topilmadi")}</div>}
              {a.checks.filter((c) => c.section !== "submit").map((c, i) => <div key={i} className={c.level}><I.alert size={16} /><span>{c.text}</span></div>)}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>{tx("Tarix")}</h3></div>
            <div className="card-pad events">
              {a.events.map((e, i) => <div key={i}><div><b>{EVENT[e.kind] || e.kind}</b><div className="muted small">{fmtDateTime(e.created_at)}{e.user ? ` · ${e.user}` : ""}</div>{e.note && <div className="small" style={{ whiteSpace: "pre-line", marginTop: 2 }}>{e.note}</div>}</div></div>)}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>{tx("Ichki izoh")}</h3></div>
            <div className="card-pad stack" style={{ gap: 6 }}>
              <textarea className="textarea" value={note ?? a.internal_note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote} placeholder={tx("Faqat adminlarga ko‘rinadi")} />
              <span className="muted small">{tx("Faqat adminlarga ko‘rinadi")}</span>
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
    if (v != null && (!Number.isInteger(v) || v < 1 || v > 70)) { setErr(tx("1 dan 70 gacha son kiriting")); return; }
    setBusy(true);
    try {
      await api.patch(`/admin/applications/${app.id}`, { max_players: v });
      toast(v == null ? tx("Havola limiti qaytarildi") : tx("Limit: {0} kishi", v));
      onSaved();
    } catch (e: any) {
      if (e?.fields?.max_players) setErr(e.fields.max_players);
      toast(e instanceof Error ? e.message : tx("Saqlanmadi"), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head"><h3>{tx("Tarkib limiti")}</h3><Badge tone={total > app.roster_max ? "danger" : "ok"}>{total} / {app.roster_max}</Badge></div>
      <div className="card-pad stack" style={{ gap: 10 }}>
        <Field label={tx("Shu jamoa uchun maks. kishi")} error={err} hint={tx("bo‘sh — havola bo‘yicha ({0}); o‘yinchilar + media + murabbiylar", linkMax)}>
          <input className="input" inputMode="numeric" value={val} placeholder={String(linkMax)} disabled={locked || busy}
            onChange={(e) => setVal(e.target.value.replace(/\D/g, "").slice(0, 2))}
            onKeyDown={(e) => { if (e.key === "Enter" && dirty) save(next); }} />
        </Field>
        {!locked && <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-sm btn-primary" disabled={!dirty || busy} onClick={() => save(next)}>{tx("Saqlash")}</button>
          {app.max_players != null && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => save(null)}>{tx("Havola limitiga qaytarish")}</button>}
        </div>}
        {app.max_players != null && <span className="muted small">{tx("Bu jamoa uchun alohida limit: {0} kishi (havolada {1})", app.max_players, linkMax)}</span>}
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
      toast(tx("«{0}» jamoasi yaratildi", app.team.name));
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Tasdiqlanmadi"), "error");
      setBusy(false);
    }
  }
  return (
    <Modal wide title={tx("{0}’ni tasdiqlash", app.team.name)} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{tx("Bekor qilish")}</button>
      <button className="btn btn-primary" onClick={go} disabled={busy}>{busy ? tx("Yaratilmoqda…") : tx("Tasdiqlash va jamoani yaratish")}</button>
    </>}>
      <div className="stack" style={{ gap: 16 }}>
        <div className="check-list">
          <b className="small">{tx("Tasdiqlangandan keyin:")}</b>
          {[tx("«{0}» jamoasi yaratiladi", app.team.name), tx("{0} ta yangi o‘yinchi ({1} o‘yinchi, {2} media shaxs, ko‘chirilganlardan tashqari) va {3} murabbiy qo‘shiladi", app.players.length - skipped - moved, field, media, app.staff.length),
            moved ? tx("{0} ta mavjud o‘yinchi boshqa jamoadan ko‘chiriladi", moved) : "", tx("Logotip, ranglar, futbolka yozuvlari, o‘lchamlar va tibbiy fayllar o‘yinchi kartochkalariga o‘tadi")].filter(Boolean).map((t) => <div key={t} className="ok"><I.check size={16} /><span>{t}</span></div>)}
        </div>
        {app.duplicates.map((d) => {
          const p = app.players[d.index];
          const key = String(d.index);
          return (
            <div key={key} className="dup-box">
              <b className="small row" style={{ gap: 8 }}><span style={{ color: "var(--amber-500)" }}><I.alert size={16} /></span>{fullName(p)}{" "}{tx("— ligada shu ismli o‘yinchi bor")}</b>
              {d.matches.map((m) => (
                <label key={m.player_id} className="radio-line"><input type="radio" name={key} checked={choice[key] === m.player_id} onChange={() => setChoice({ ...choice, [key]: m.player_id })} />
                  <span><b>{m.team_name ? tx("«{0}»dan ko‘chirish", m.team_name) : tx("Jamoasiz o‘yinchini biriktirish")}</b>{m.number != null && ` (#${m.number})`}<div className="muted small">{m.birth_date ? `${m.full_name}, ${fmtBirth(m.birth_date)} · ` : ""}{tx("Statistika va matchlar tarixi saqlanadi")}</div></span></label>
              ))}
              <label className="radio-line"><input type="radio" name={key} checked={!choice[key]} onChange={() => setChoice({ ...choice, [key]: 0 })} /><span><b>{tx("Yangi o‘yinchi sifatida yaratish")}</b><div className="muted small">{tx("Boshqa odam bo‘lsa")}</div></span></label>
              <label className="radio-line"><input type="radio" name={key} checked={choice[key] === -1} onChange={() => setChoice({ ...choice, [key]: -1 })} /><span><b>{tx("Tarkibga qo‘shmaslik")}</b></span></label>
            </div>
          );
        })}
        <Field label={tx("Guruh")} hint={tx("Bo‘sh qoldirsangiz — jamoa guruhsiz qo‘shiladi, keyin «Guruhlar»da biriktirasiz")}>
          <select className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">{tx("Keyinroq — qur’adan keyin")}</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.code}</option>)}
          </select>
        </Field>
        {sms && <Toggle label={tx("Vakilga SMS yuborish")} sub={tx("«Arizangiz tasdiqlandi» + holat sahifasi havolasi")} checked={notify} onChange={setNotify} />}
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
      toast(tx("Ariza tuzatishga qaytarildi"));
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
      setBusy(false);
    }
  }
  return (
    <Modal wide title={tx("Tuzatishga qaytarish")} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{tx("Bekor qilish")}</button>
      <button className="btn btn-primary" onClick={go} disabled={busy || !comments.length}>{busy ? tx("Yuborilmoqda…") : tx("Tuzatishga yuborish")}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <span className="muted">{tx("Tuzatish kerak bo‘lgan bo‘limlarni belgilang va izoh yozing. Vakil faqat shu bo‘limlarni tahrirlay oladi, qolgani qulflanadi.")}</span>
        {Object.entries(SECTIONS).map(([s, label]) => (
          <div key={s} className={`sec-item${items[s].on ? " on" : ""}`}>
            <label className="check"><input type="checkbox" checked={items[s].on} onChange={(e) => setItems({ ...items, [s]: { ...items[s], on: e.target.checked } })} /> {label}</label>
            {items[s].on && <textarea className="textarea" value={items[s].text} onChange={(e) => setItems({ ...items, [s]: { ...items[s], text: e.target.value } })} placeholder={tx("Nimani tuzatish kerak — vakil shu matnni ko‘radi")} maxLength={1000} />}
          </div>
        ))}
        <Field label={tx("Tuzatish muddati")} hint={tx("Muddat o‘tsa, ariza avtomatik «Rad etilgan» bo‘ladi")}>
          <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[3, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n}{" "}{tx("kun")}</option>)}</select>
        </Field>
        {sms && <Toggle label={tx("Vakilga SMS yuborish")} sub={tx("Izohlar holat sahifasida ko‘rinadi")} checked={notify} onChange={setNotify} />}
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
      toast(tx("Ariza rad etildi"));
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
      setBusy(false);
    }
  }
  return (
    <Modal title={tx("Arizani rad etish")} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{tx("Bekor qilish")}</button>
      <button className="btn btn-danger" onClick={go} disabled={busy || !reason.trim()}>{tx("Rad etish")}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <Field label={tx("Sabab")} hint={tx("Vakil shu matnni holat sahifasida ko‘radi")}><textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} autoFocus /></Field>
        {sms && <Toggle label={tx("Vakilga SMS yuborish")} checked={notify} onChange={setNotify} />}
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
      <div className="crumbs small" style={{ marginBottom: 8 }}><Link to="/applications">{tx("Arizalar")}</Link> / <b>{tx("Havolalar")}</b></div>
      <PageHead title={tx("Ro‘yxatga olish havolalari")} sub={tx("Har bir havola — alohida qabul: o‘z mavsumi, muddati, joylar soni va talablari bilan. Faol havola bo‘lmasa, ariza sayti «ro‘yxatdan o‘tish yopiq» deb ko‘rsatadi.")}
        actions={<Allowed to="create"><Link className="btn btn-primary" to="/applications/links/new"><I.plus size={16} />{" "}{tx("Yangi havola")}</Link></Allowed>} />
      <div className="card">
        {links.error ? <div className="card-pad"><ErrorBox error={links.error} retry={links.reload} /></div> : !links.data ? <Loading /> : !links.data.items.length ? (
          <Empty title={tx("Hali havola yo‘q")} text={tx("Havola yarating — jamoalar u orqali ariza yuboradi.")} action={<Allowed to="create"><Link className="btn btn-primary" to="/applications/links/new"><I.plus size={16} />{" "}{tx("Yangi havola")}</Link></Allowed>} />
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{tx("Havola")}</th><th className="hide-mobile">{tx("Mavsum / bosqich")}</th><th className="hide-mobile">{tx("Qabul muddati")}</th><th>{tx("Joylar")}</th><th>{tx("Arizalar")}</th><th>{tx("Holat")}</th><th /></tr></thead>
            <tbody>{links.data.items.map((l) => (
              <tr key={l.id} className="clickable" onClick={() => nav(`/applications/links/${l.id}`)}>
                <td><div className="row"><I.link size={16} /><div><b>{l.title}</b>{l.is_default && <span className="tag-mini">{tx("Asosiy")}</span>}<div className="muted small">{l.url || tx("Kod: {0}", l.code)}</div></div></div></td>
                <td className="hide-mobile">{l.season || "—"}<div className="muted small">{l.stage || "—"}</div></td>
                <td className="hide-mobile nowrap">{l.closes_at ? fmtDateTime(l.closes_at) : tx("Cheklanmagan")}{l.opens_at && <div className="muted small">{tx("{0} dan", fmtDateTime(l.opens_at))}</div>}</td>
                <td className="nowrap">{l.max_teams ? `${l.approved} / ${l.max_teams} band` : tx("{0} tasdiqlangan", l.approved)}</td>
                <td className="nowrap">{l.sent}<div className="muted small">{l.drafts}{" "}{tx("qoralama")}</div></td>
                <td><Badge tone={LINK_STATE[l.state].tone}>{LINK_STATE[l.state].label}</Badge></td>
                <td className="actions" onClick={(e) => e.stopPropagation()}>{l.url && <LinkActions link={l} small />}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <div className="note-box" style={{ marginTop: 16 }}>{tx("«Joylar» — tasdiqlangan jamoalar. Limitga yetganda ariza sayti «Barcha joylar band» sahifasini ko‘rsatadi. «Asosiy» havola ariza saytining bosh sahifasida ochiladi.")}</div>
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
        toast(tx("Havola yaratildi"));
        nav(`/applications/links/${r.id}`, { replace: true });
      } else {
        await api.patch(`/admin/registration/links/${id}`, body);
        toast(tx("Saqlandi"));
        loaded.reload();
      }
    } catch (e: any) {
      if (e?.fields) setErrs(e.fields);
      toast(e instanceof Error ? e.message : tx("Saqlanmadi"), "error");
    } finally {
      setBusy(false);
    }
  }
  async function regenerate() {
    if (!(await confirm({ title: tx("Havolani yangilash?"), text: tx("Yangi kod yaratiladi, eski havola ishlamay qoladi. Boshlangan arizalar o‘z sahifasida davom etadi."), ok: tx("Yangilash"), danger: true }))) return;
    try {
      await api.post(`/admin/registration/links/${id}/regenerate`);
      toast(tx("Yangi havola yaratildi"));
      loaded.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    }
  }
  async function remove() {
    if (!(await confirm({ title: tx("Havolani o‘chirish?"), text: tx("Faqat ariza yuborilmagan havolani o‘chirish mumkin. Qoralamalar ham o‘chadi."), ok: tx("O‘chirish"), danger: true }))) return;
    try {
      await api.del(`/admin/registration/links/${id}`);
      nav("/applications/links");
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("O‘chirilmadi"), "error");
    }
  }
  const card = (title: string, body: ReactNode) => <div className="card"><div className="card-head"><h3>{title}</h3></div><div className="card-pad stack" style={{ gap: 16 }}>{body}</div></div>;

  return (
    <>
      <div className="crumbs small" style={{ marginBottom: 8 }}><Link to="/applications">{tx("Arizalar")}</Link> / <Link to="/applications/links">{tx("Havolalar")}</Link> / <b>{isNew ? tx("Yangi") : saved?.code}</b></div>
      <PageHead title={isNew ? tx("Yangi havola") : saved?.title || tx("Havola")} actions={<>
        <Link className="btn btn-ghost" to="/applications/links">{tx("Bekor qilish")}</Link>
        <button className="btn btn-primary" onClick={save} disabled={busy || !v.title?.trim()}>{busy ? tx("Saqlanmoqda…") : isNew ? tx("Saqlash va havolani yaratish") : tx("Saqlash")}</button>
      </>} />
      <div className="app-layout">
        <div className="stack" style={{ gap: 24 }}>
          {card(tx("Asosiy"), <>
            <Field label={tx("Nomi *")} error={errs.title} hint={tx("Faqat adminkada ko‘rinadi")}><input className="input" value={v.title || ""} onChange={(e) => set("title", e.target.value)} placeholder={tx("Mavsum 2027 — umumiy qabul")} maxLength={120} /></Field>
            <div className="form-grid">
              <Field label={tx("Mavsum")}><select className="select" value={v.season_id ?? ""} onChange={(e) => { set("season_id", num(e.target.value)); set("stage_id", null); }}><option value="">—</option>{seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
              <Field label={tx("Bosqich")} hint={tx("ariza sahifasida ko‘rsatiladi")}><select className="select" value={v.stage_id ?? ""} onChange={(e) => set("stage_id", num(e.target.value))}><option value="">—</option>{seasonStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
              <Field label={tx("Qabul boshlanishi")} hint={tx("bo‘sh — darhol")}><input className="input" type="datetime-local" value={toLocalInput(v.opens_at)} onChange={(e) => set("opens_at", fromLocalInput(e.target.value))} /></Field>
              <Field label={tx("Qabul tugashi")} hint={tx("bo‘sh — cheklanmagan")} error={errs.closes_at}><input className="input" type="datetime-local" value={toLocalInput(v.closes_at)} onChange={(e) => set("closes_at", fromLocalInput(e.target.value))} /></Field>
              <Field label={tx("Jamoalar limiti")} hint={tx("tasdiqlanganlar soni; bo‘sh — cheklanmagan")} error={errs.max_teams}><input className="input" inputMode="numeric" value={v.max_teams ?? ""} onChange={(e) => set("max_teams", num(e.target.value.replace(/\D/g, "")))} /></Field>
            </div>
            <div className="field"><span className="label">{tx("Havola turi")}</span>
              <div className="seg seg-wide">
                <button type="button" aria-pressed={v.kind === "multi"} onClick={() => set("kind", "multi")}>{tx("Ko‘p martalik — barcha jamoalar uchun")}</button>
                <button type="button" aria-pressed={v.kind === "single"} onClick={() => set("kind", "single")}>{tx("Bir martalik — bitta jamoa uchun")}</button>
              </div>
            </div>
          </>)}
          {card(tx("Talablar"), <>
            <div className="form-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
              <Field label={tx("Min. kishi")} error={errs.min_players}><input className="input" inputMode="numeric" value={v.min_players ?? ""} onChange={(e) => set("min_players", num(e.target.value.replace(/\D/g, "")) ?? 0)} /></Field>
              <Field label={tx("Maks. kishi")} hint={tx("o‘yinchilar + media + murabbiylar; alohida jamoaga — arizadagi «Tarkib limiti»")} error={errs.max_players}><input className="input" inputMode="numeric" value={v.max_players ?? ""} onChange={(e) => set("max_players", num(e.target.value.replace(/\D/g, "")) ?? 0)} /></Field>
              <Field label={tx("Min. yosh")} hint={tx("bo‘sh — tekshirilmaydi")} error={errs.min_age}><input className="input" inputMode="numeric" value={v.min_age ?? ""} onChange={(e) => set("min_age", num(e.target.value.replace(/\D/g, "")))} /></Field>
            </div>
            <Toggle label={tx("Logotip majburiy")} sub={tx("PNG/JPG, kamida 512×512 tavsiya etiladi")} checked={!!v.require_logo} onChange={(x) => set("require_logo", x)} />
            <Toggle label={tx("O‘yinchi fotosi majburiy")} sub={tx("O‘chiq bo‘lsa — ixtiyoriy")} checked={!!v.require_photo} onChange={(x) => set("require_photo", x)} />
            <Toggle label={tx("Tibbiy ruxsatnoma yuborishdan oldin majburiy")} sub={tx("O‘chiq bo‘lsa — keyin yuklash mumkin, ogohlantirish chiqadi")} checked={!!v.require_medical} onChange={(x) => set("require_medical", x)} />
            <Toggle label={tx("Telefonni SMS-kod bilan tasdiqlash")} sub={cfg?.sms === "eskiz" ? tx("Eskiz orqali") : cfg?.sms === "dev" ? tx("Sinov rejimi: SMS yuborilmaydi, kod sahifada ko‘rinadi") : tx("SMS sozlanmagan (ESKIZ_EMAIL) — tasdiqlash so‘ralmaydi")} checked={!!v.require_phone} onChange={(x) => set("require_phone", x)} />
            <Toggle label={tx("Boshqa jamoalardagi o‘yinchilarni tekshirish")} sub={tx("Ism-familiya bo‘yicha moslik")} checked={!!v.check_duplicates} onChange={(x) => set("check_duplicates", x)} />
          </>)}
          {card(tx("Sahifa matni"), <>
            <Field label={tx("Sarlavha")} hint={tx("bo‘sh — «Jamoangizni United MFL’ga ro‘yxatdan o‘tkazing»")}><input className="input" value={v.heading || ""} onChange={(e) => set("heading", e.target.value)} maxLength={160} /></Field>
            <Field label={tx("Tavsif")}><textarea className="textarea" value={v.description || ""} onChange={(e) => set("description", e.target.value)} maxLength={2000} placeholder={tx("Ariza 4 qadamda to‘ldiriladi, taxminan 10 daqiqa…")} /></Field>
            <Field label={tx("Reglament havolasi")} hint={tx("4-qadamda «Reglament bilan tanishdim» yonida chiqadi")} error={errs.rules_url}><input className="input" type="url" value={v.rules_url || ""} onChange={(e) => set("rules_url", e.target.value)} placeholder="https://…" /></Field>
          </>)}
        </div>
        <aside>
          <div className="card">
            <div className="card-head"><h3>{tx("Holat")}</h3>{saved && <Badge tone={LINK_STATE[saved.state].tone}>{LINK_STATE[saved.state].label}</Badge>}</div>
            <div className="card-pad stack" style={{ gap: 14 }}>
              <Toggle label={tx("Qabul ochiq")} sub={tx("O‘chiq bo‘lsa, havola «Ro‘yxatdan o‘tish hozircha yopiq» deb ko‘rsatadi")} checked={!!v.is_active} onChange={(x) => set("is_active", x)} />
              <Toggle label={tx("Asosiy sahifada ko‘rsatish")} sub={tx("Ariza saytining bosh sahifasi shu havolani ochadi")} checked={!!v.is_default} onChange={(x) => set("is_default", x)} />
              {saved && (saved.is_active !== v.is_active || saved.is_default !== v.is_default) && <span className="small" style={{ color: "var(--amber-800)" }}>{tx("O‘zgarish «Saqlash»dan keyin kuchga kiradi")}</span>}
            </div>
          </div>
          {saved && (
            <div className="card">
              <div className="card-head"><h3>{tx("Havola")}</h3></div>
              <div className="card-pad stack" style={{ gap: 10 }}>
                <div className="url-box"><I.link size={16} /><b className="grow">{saved.url || saved.code}</b></div>
                {!saved.url && <span className="muted small">{tx("Ariza sayti manzili sozlanmagan (REGISTER_PUBLIC_URL) — hozircha faqat kod:")}{" "}<b>{saved.code}</b></span>}
                {saved.url && <div className="row wrap"><button className="btn btn-sm" onClick={() => copy(saved.url, toast)}><I.copy size={15} />{" "}{tx("Nusxa olish")}</button><button className="btn btn-sm" onClick={() => setQr(true)}><I.qr size={15} />{" "}{tx("QR-kod")}</button>
                  <a className="btn btn-sm" href={tgShare(saved.url, tx("United MFL: jamoa arizasi"))} target="_blank" rel="noopener noreferrer"><I.telegram size={15} />{" "}{tx("Ulashish")}</a></div>}
                <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                  <button className="link-btn danger-text small" style={{ alignSelf: "flex-start" }} onClick={regenerate}>{tx("Havolani yangilash")}</button>
                  <span className="muted small">{tx("Yangi kod yaratiladi, eski havola ishlamay qoladi.")}</span>
                </div>
                <div className="muted small">{saved.sent}{" "}{tx("ariza · {0} qoralama · {1} tasdiqlangan", saved.drafts, saved.approved)}</div>
              </div>
            </div>
          )}
          {saved && saved.sent === 0 && <Allowed to="delete"><button className="btn btn-ghost danger-text" onClick={remove}><I.trash size={16} />{" "}{tx("Havolani o‘chirish")}</button></Allowed>}
          <div className="note-box">{tx("Arizalarni kim ko‘rishi va boshqarishi «Rollar va huquqlar»da — «Arizalar» qatorida belgilanadi.")}</div>
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
