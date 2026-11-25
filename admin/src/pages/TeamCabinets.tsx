import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, blobUrl } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { fmtDateTime, fmtShort, initials } from "@/lib/format";
import { invalidateRefs } from "@/lib/refs";
import { PageHead } from "@/components/Layout";
import { Badge, Empty, ErrorBox, Loading, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

/* Team cabinet in the admin (design A11–A13):
   /applications/changes       — requests from the cabinets (O‘zgarishlar)
   /applications/changes/:id   — review: item by item, «was → becomes»
   /applications/cabinets      — every team and its cabinet (Kabinetlar)
   /applications/cabinets/:id  — login, password, link, security, history */

/* ---------- types ---------- */
type FieldChange = { field: string; label: string; before: string; after: string };
type Item = {
  key: string; kind: "team" | "player" | "staff"; op: "update" | "add" | "remove"; title: string; fields: FieldChange[];
  player?: { id?: number; first_name: string; last_name: string; number: string | null; role: string; jersey_name: string; birth_date: string; kit_size: string; workplace: string; photo_url: string; medical: { file: string; name: string } | null; has_medical: boolean };
  staff?: { id?: number; first_name: string; last_name: string; role: string; birth_date: string; kit_size: string };
  decision?: "approved" | "rejected" | "fix";
};
type Check = { level: "error" | "warn"; key?: string; text: string };
type ReqSummary = { id: number; number: string; status: string; team: { id: number; name: string; crest_url: string }; summary: string; counts: Record<string, number>; submitted_at: string | null; decided_at: string | null; updated_at: string };
type ReqDetail = {
  request: { id: number; number: string; status: string; items: Item[]; comment: string; submitted_at: string | null; decided_at: string | null };
  internal_note: string;
  team: { id: number; name: string; slug: string; crest_url: string; login: string; site_url: string };
  checks: Check[]; stale: string[];
  events: CabEvent[];
  previous?: { id: number; number: string; status: string };
};
type CabEvent = { kind: string; note: string; number?: string; user_name: string; created_at: string };
type Account = { login: string; enabled: boolean; failed_attempts: number; locked_until: string | null; password_set_at: string; last_login_at: string | null; last_device: string; created_at: string; created_by: string; sessions: number; url: string };
type CabinetInfo = {
  team: { id: number; name: string; slug: string; crest_url: string };
  account: Account | null; requests: { id: number; number: string; status: string; submitted_at: string | null; decided_at: string | null; counts: Record<string, number>; summary: string }[];
  events: CabEvent[]; has_draft: boolean; register_url: string; suggested_login: string;
};
type Credentials = { login: string; password: string; url: string; message: string };

export const REQ_STATUS: Record<string, { label: string; tone: string }> = {
  submitted: { label: "Yangi", tone: "dark" },
  changes: { label: "Tuzatishda", tone: "warn" },
  approved: { label: "Tasdiqlandi", tone: "ok" },
  partial: { label: "Qisman", tone: "warn" },
  rejected: { label: "Rad etildi", tone: "danger" },
  withdrawn: { label: "Bekor qilindi", tone: "" },
  draft: { label: "Qoralama", tone: "" },
};
const CAB_EVENT: Record<string, string> = {
  created: "Kabinet yaratildi", password: "Parol yangilandi", login: "Kabinetga kirildi", locked: "Kirish vaqtincha to‘xtatildi",
  enabled: "Kabinet yoqildi", disabled: "Kabinet o‘chirildi", login_changed: "Login o‘zgartirildi",
  submitted: "So‘rov yuborildi", withdrawn: "So‘rov qaytarib olindi", approved: "Tasdiqlandi", partial: "Qisman tasdiqlandi",
  returned: "Tuzatishga qaytarildi", rejected: "Rad etildi",
};
const OP: Record<string, { label: string; tone: string }> = { add: { label: "Yangi", tone: "ok" }, update: { label: "O‘zgardi", tone: "warn" }, remove: { label: "Chiqariladi", tone: "danger" } };
const DECISION: Record<string, { label: string; tone: string }> = { approved: { label: "Saytga chiqdi", tone: "ok" }, rejected: { label: "Rad etildi", tone: "danger" }, fix: { label: "Tuzatishga", tone: "warn" } };
const IMG = ["crest_url", "kit_url", "photo_url"];
const fmtBirth = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split("-").reverse().join(".") : d || "—");

async function copyText(text: string, toast: (t: string, k?: "ok" | "error") => void, ok = "Nusxalandi") {
  try {
    await navigator.clipboard.writeText(text);
    toast(ok);
  } catch {
    toast("Nusxalab bo‘lmadi — matnni qo‘lda belgilang", "error");
  }
}
const tgShare = (url: string, text: string) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;

/* ---------- A13: tabs over the Arizalar section ---------- */
export function ArizalarTabs({ current }: { current: "apps" | "changes" | "cabinets" }) {
  const counts = useLoad(() => api.get<{ counts: Record<string, number> }>("/admin/team-changes?status=submitted").catch(() => null), []).data?.counts;
  const tabs: [typeof current, string, string, number | undefined][] = [
    ["apps", "/applications", "Yangi jamoalar", undefined],
    ["changes", "/applications/changes", "O‘zgarishlar", counts?.submitted],
    ["cabinets", "/applications/cabinets", "Kabinetlar", undefined],
  ];
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, to, label, n]) => (
        <Link key={k} to={to} className={`tab-link${current === k ? " on" : ""}`} role="tab" aria-selected={current === k}>
          {label}{n ? <span className="tab-count">{n}</span> : null}
        </Link>
      ))}
    </div>
  );
}

function TeamCrest({ name, url, size = 32 }: { name: string; url: string; size?: number }) {
  return <span className="crest" style={{ width: size, height: size, fontSize: Math.round(size / 3) }}>{url ? <img src={url} alt="" /> : initials(name || "?")}</span>;
}

/* ---------- O‘zgarishlar list ---------- */
export function ChangesList() {
  const nav = useNavigate();
  const [status, setStatus] = useState("submitted");
  const data = useLoad(() => api.get<{ items: ReqSummary[]; counts: Record<string, number> }>(`/admin/team-changes?status=${status || "all"}`), [status]);
  const c = data.data?.counts || {};
  const all = Object.values(c).reduce((s, n) => s + n, 0);
  const chips: [string, string, number][] = [["submitted", "Yangi", c.submitted || 0], ["changes", "Tuzatishda", c.changes || 0], ["approved", "Tasdiqlangan", c.approved || 0],
    ["partial", "Qisman", c.partial || 0], ["rejected", "Rad etilgan", c.rejected || 0], ["", "Hammasi", all]];
  return (
    <>
      <PageHead title="Arizalar" sub="Yangi jamoalar arizalari va kabinetlardan kelgan o‘zgarishlar" actions={<Link className="btn" to="/applications/cabinets"><I.lock size={16} /> Jamoalar kabinetlari</Link>} />
      <ArizalarTabs current="changes" />
      <div className="card">
        <div className="toolbar">
          <div className="chips">{chips.map(([k, label, n]) => <button key={k} className="chip" aria-pressed={status === k} onClick={() => setStatus(k)}>{label} <span className="muted">{n}</span></button>)}</div>
        </div>
        {data.error ? <div className="card-pad"><ErrorBox error={data.error} retry={data.reload} /></div> : !data.data ? <Loading /> : !data.data.items.length ? (
          <Empty title={status === "submitted" ? "Yangi so‘rov yo‘q" : "So‘rov yo‘q"} text="Jamoa kabinetida o‘zgarishlarni yuborganda shu yerda ko‘rinadi." />
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>So‘rov</th><th>Jamoa</th><th>Nima o‘zgardi</th><th className="hide-mobile">Yuborildi</th><th>Holat</th></tr></thead>
            <tbody>{data.data.items.map((r) => (
              <tr key={r.id} className={`clickable${r.status === "submitted" ? " row-new" : ""}`} onClick={() => nav(`/applications/changes/${r.id}`)}>
                <td className="nowrap"><b>{r.number}</b></td>
                <td><div className="row"><TeamCrest name={r.team.name} url={r.team.crest_url} size={28} /><b>{r.team.name}</b></div></td>
                <td className="muted">{r.summary}</td>
                <td className="hide-mobile nowrap">{fmtShort(r.submitted_at || r.updated_at)}</td>
                <td><Badge tone={REQ_STATUS[r.status]?.tone}>{REQ_STATUS[r.status]?.label || r.status}</Badge></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

/* ---------- A12: review ---------- */
function Swatches({ value }: { value: string }) {
  const list = value.split(/\s+/).filter(Boolean);
  if (!list.length) return <span className="muted">—</span>;
  return <span className="row" style={{ gap: 4 }}>{list.map((c) => <i key={c} className="swatch" style={{ background: c }} title={c} />)}</span>;
}

function Before({ f }: { f: FieldChange }) {
  if (IMG.includes(f.field)) return f.before ? <img className="chg-img" src={f.before} alt="" /> : <span className="muted">yo‘q</span>;
  if (f.field === "colors") return <Swatches value={f.before} />;
  if (f.field === "birth_date") return <s className="muted">{fmtBirth(f.before)}</s>;
  return f.before ? <s className="muted">{f.before}</s> : <span className="muted">—</span>;
}
function After({ f, openMedical }: { f: FieldChange; openMedical?: () => void }) {
  if (IMG.includes(f.field)) return f.after ? <img className="chg-img" src={f.after} alt="" /> : <span className="muted">olib tashlanadi</span>;
  if (f.field === "colors") return <Swatches value={f.after} />;
  if (f.field === "birth_date") return <b>{fmtBirth(f.after)}</b>;
  if (f.field === "medical" && openMedical) return <button className="link-btn small" onClick={openMedical}>Yangi fayl — ochish</button>;
  return <b>{f.after || "—"}</b>;
}

function ItemRow({ it, checked, onToggle, decide, stale, checks, teamId }: {
  it: Item; checked: boolean; onToggle: () => void; decide: boolean; stale: boolean; checks: Check[]; teamId: number;
}) {
  const toast = useToast();
  async function openMedical() {
    const f = it.player?.medical?.file;
    if (!f) return;
    try {
      window.open(await blobUrl(`/admin/team-cabinet/${teamId}/files/${encodeURIComponent(f)}`), "_blank");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Fayl ochilmadi", "error");
    }
  }
  const p = it.player;
  const err = checks.some((c) => c.level === "error");
  return (
    <div className={`chg-row${it.op === "remove" ? " remove" : ""}${checks.length ? (err ? " err" : " warn") : ""}`}>
      {decide ? <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`«${it.title}» bandini tasdiqlash`} /> : <span style={{ width: 18 }} />}
      <div className="grow stack" style={{ gap: 6 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <Badge tone={OP[it.op].tone}>{OP[it.op].label}</Badge>
          <b>{it.title}</b>
          {it.decision && <Badge tone={DECISION[it.decision].tone}>{DECISION[it.decision].label}</Badge>}
          {stale && <Badge plain>Allaqachon saytda</Badge>}
        </div>
        {it.op === "add" && p && (
          <div className="row wrap small" style={{ gap: 10 }}>
            {p.photo_url && <img className="chg-img sm" src={p.photo_url} alt="" />}
            <span className="muted">{[p.jersey_name, p.kit_size, fmtBirth(p.birth_date), p.workplace, p.role === "goalkeeper" ? "darvozabon" : p.role === "media" ? "media shaxs" : ""].filter((x) => x && x !== "—").join(" · ")}</span>
            {p.medical ? <button className="link-btn small" onClick={openMedical}>Tibbiy ruxsatnoma — ochish</button> : <span className="muted">tibbiy ruxsatnoma yo‘q</span>}
          </div>
        )}
        {it.op === "add" && it.staff && <span className="muted small">{[fmtBirth(it.staff.birth_date), it.staff.kit_size].filter((x) => x && x !== "—").join(" · ") || "—"}</span>}
        {it.op === "update" && (
          <div className="chg-fields">
            {it.fields.map((f) => (
              <div key={f.field}>{it.kind !== "team" && <span className="muted">{f.label}:</span>}<Before f={f} /><span className="muted">→</span><After f={f} openMedical={openMedical} /></div>
            ))}
          </div>
        )}
        {it.op === "remove" && <span className="muted small">{it.kind === "staff" ? "Shtabdan o‘chiriladi" : "Saytdagi profili qoladi, jamoasi bo‘sh bo‘ladi"}</span>}
        {checks.map((c, i) => <span key={i} className={`small ${c.level === "error" ? "danger-text" : ""}`}><I.alert size={13} /> {c.text}</span>)}
      </div>
    </div>
  );
}

export function ChangeReview() {
  const { id } = useParams();
  const toast = useToast();
  const d = useLoad(() => api.get<ReqDetail>(`/admin/team-changes/${id}`), [id]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"" | "return" | "reject">("");
  const [note, setNote] = useState<string | null>(null);

  const r = d.data?.request;
  const defaults = useMemo(() => {
    if (!d.data || !r) return new Set<string>();
    const stale = new Set(d.data.stale);
    // everything without an error is ticked by default
    return new Set(r.items.filter((it) => !stale.has(it.key) && !d.data!.checks.some((c) => c.key === it.key && c.level === "error")).map((it) => it.key));
  }, [d.data, r]);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data || !r) return <Loading />;
  const data = d.data;
  const sel = picked ?? defaults;
  const decide = r.status === "submitted";
  const stale = new Set(data.stale);
  const toggle = (k: string) => {
    const n = new Set(sel);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setPicked(n);
  };
  const groups: [string, Item[]][] = [["Jamoa va forma", r.items.filter((x) => x.kind === "team")], ["Tarkib", r.items.filter((x) => x.kind === "player")], ["Shtab", r.items.filter((x) => x.kind === "staff")]];
  const general = data.checks.filter((c) => !c.key);
  const errors = data.checks.filter((c) => c.level === "error");

  async function send(action: "approve" | "return" | "reject") {
    setBusy(true);
    try {
      const res = await api.post<{ status: string; approved: number }>(`/admin/team-changes/${r!.id}/decide`, { action, approve: action === "reject" ? [] : [...sel], comment });
      toast(res.status === "approved" ? "Hammasi saytga chiqdi" : res.status === "partial" ? `${res.approved} ta band saytga chiqdi` : res.status === "changes" ? "Jamoaga tuzatishga qaytarildi" : "So‘rov rad etildi");
      if (res.approved) invalidateRefs();
      setModal("");
      setPicked(null);
      d.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  async function saveNote() {
    if (note == null || note === data.internal_note) return;
    try {
      await api.patch(`/admin/team-changes/${r!.id}`, { internal_note: note });
      toast("Izoh saqlandi");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Saqlanmadi", "error");
    }
  }

  return (
    <>
      <div className="crumbs small" style={{ marginBottom: 8 }}><Link to="/applications">Arizalar</Link> / <Link to="/applications/changes">O‘zgarishlar</Link> / <b>{r.number}</b></div>
      <PageHead title={`${data.team.name} — o‘zgarishlar`} sub={`Kabinetdan yuborilgan ${fmtDateTime(r.submitted_at)} · ${r.items.length} band`}
        actions={decide ? <>
          <button className="btn btn-ghost danger-text" onClick={() => setModal("reject")}>Rad etish</button>
          <button className="btn" onClick={() => setModal("return")}>Tuzatishga qaytarish</button>
          <button className="btn btn-primary" disabled={!sel.size || busy} onClick={() => send("approve")}>Tanlanganlarni tasdiqlash ({sel.size})</button>
        </> : <Link className="btn" to={`/applications/cabinets/${data.team.id}`}><I.lock size={16} /> Kabinet</Link>} />
      {decide && errors.length > 0 && <div className="alert danger" style={{ marginBottom: 16 }}><I.alert size={16} /><div>{errors.length} ta xato bor — xatoli bandlar belgilanmagan. Ularni tuzatishga qaytaring.</div></div>}
      {!decide && r.comment && <div className="alert info" style={{ marginBottom: 16 }}><I.inbox size={16} /><div><b>Jamoaga izoh:</b> {r.comment}</div></div>}
      <div className="app-layout">
        <div className="stack" style={{ gap: 16 }}>
          {groups.filter(([, list]) => list.length).map(([title, list]) => (
            <div className="card" key={title}>
              <div className="card-head">
                <h3>{title}</h3>
                {decide ? <button className="link-btn small" onClick={() => { const n = new Set(sel); const all = list.every((x) => n.has(x.key)); list.forEach((x) => (all ? n.delete(x.key) : n.add(x.key))); setPicked(n); }}>{list.every((x) => sel.has(x.key)) ? "Belgini olib tashlash" : "Hammasini belgilash"}</button> : <span className="muted small">{list.length} band</span>}
              </div>
              {list.map((it) => <ItemRow key={it.key} it={it} checked={sel.has(it.key)} onToggle={() => toggle(it.key)} decide={decide} stale={stale.has(it.key)} checks={data.checks.filter((c) => c.key === it.key)} teamId={data.team.id} />)}
            </div>
          ))}
          {decide && <div className="muted small">Belgilangan bandlar «Tasdiqlash»da saytga chiqadi. Belgilanmagani: «Tasdiqlash»da — rad etiladi, «Tuzatishga qaytarish»da — jamoaga izoh bilan qaytadi.</div>}
        </div>
        <aside>
          <div className="card">
            <div className="card-head"><h3>Holat</h3><Badge tone={REQ_STATUS[r.status]?.tone}>{REQ_STATUS[r.status]?.label || r.status}</Badge></div>
            <div className="kv-list">
              <div><span>So‘rov</span><span>{r.number}</span></div>
              <div><span>Jamoa</span><span><Link to={`/teams/${data.team.id}`}>{data.team.name}</Link></span></div>
              <div><span>Yubordi</span><span>Kabinet · {data.team.login || "—"}</span></div>
              {data.previous && <div><span>Oldingi</span><span><Link to={`/applications/changes/${data.previous.id}`}>{data.previous.number}</Link> · {REQ_STATUS[data.previous.status]?.label}</span></div>}
              {r.decided_at && <div><span>Qaror</span><span>{fmtDateTime(r.decided_at)}</span></div>}
            </div>
          </div>
          {decide && (
            <div className="card">
              <div className="card-head"><h3>Avtomatik tekshiruv</h3><span className="muted small">{data.checks.length ? `${data.checks.length} ta` : ""}</span></div>
              <div className="card-pad check-list">
                {!data.checks.length && <div className="ok"><I.check size={16} /> Muammo topilmadi</div>}
                {data.checks.map((c, i) => <div key={i} className={c.level}><I.alert size={16} /><span>{c.text}</span></div>)}
                {!general.length && data.checks.length > 0 && null}
              </div>
            </div>
          )}
          {decide && (
            <div className="card">
              <div className="card-head"><h3>Jamoaga izoh</h3></div>
              <div className="card-pad stack" style={{ gap: 6 }}>
                <textarea className="textarea" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Masalan: Toxirni diskvalifikatsiya tugagach chiqaring" />
                <span className="muted small">Tuzatishga qaytarishda yoki qisman tasdiqlashda jamoa kabinetida ko‘rinadi.</span>
              </div>
            </div>
          )}
          <div className="card">
            <div className="card-head"><h3>Tarix</h3></div>
            <div className="card-pad events">
              {data.events.map((e, i) => <div key={i}><div><b>{CAB_EVENT[e.kind] || e.kind}</b><div className="muted small">{fmtDateTime(e.created_at)}{e.user_name ? ` · ${e.user_name}` : ""}</div>{e.note && <div className="small" style={{ marginTop: 2 }}>{e.note}</div>}</div></div>)}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Ichki izoh</h3></div>
            <div className="card-pad stack" style={{ gap: 6 }}>
              <textarea className="textarea" value={note ?? data.internal_note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote} placeholder="Faqat adminlarga ko‘rinadi" />
            </div>
          </div>
        </aside>
      </div>
      {modal === "return" && (
        <Modal title="Tuzatishga qaytarish" onClose={() => setModal("")} footer={<>
          <button className="btn btn-ghost" onClick={() => setModal("")}>Bekor qilish</button>
          <button className="btn btn-primary" disabled={!comment.trim() || busy} onClick={() => send("return")}>Qaytarish</button>
        </>}>
          <div className="stack" style={{ gap: 12 }}>
            <p className="sec" style={{ margin: 0 }}>{sel.size ? `Belgilangan ${sel.size} ta band hozir saytga chiqadi, qolgan ${r.items.length - sel.size} tasi jamoaga tuzatish uchun qaytadi.` : "Hech narsa saytga chiqmaydi — barcha bandlar jamoaga qaytadi."}</p>
            <textarea className="textarea" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Jamoa nimani tuzatishi kerak?" autoFocus />
          </div>
        </Modal>
      )}
      {modal === "reject" && (
        <Modal title="So‘rovni rad etish" onClose={() => setModal("")} footer={<>
          <button className="btn btn-ghost" onClick={() => setModal("")}>Bekor qilish</button>
          <button className="btn btn-destructive" disabled={busy} onClick={() => send("reject")}>Rad etish</button>
        </>}>
          <div className="stack" style={{ gap: 12 }}>
            <p className="sec" style={{ margin: 0 }}>Hech bir band saytga chiqmaydi. Jamoa sababni kabinetida ko‘radi va keyin yangi so‘rov yuborishi mumkin.</p>
            <textarea className="textarea" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Sabab (ixtiyoriy)" />
          </div>
        </Modal>
      )}
    </>
  );
}

/* ---------- Kabinetlar list ---------- */
type CabRow = { team: { id: number; name: string; slug: string; crest_url: string; is_active: boolean }; state: "none" | "active" | "disabled"; login: string; last_login_at: string | null; request_status: string };
const CAB_STATE: Record<CabRow["state"], { label: string; tone: string }> = { active: { label: "Faol", tone: "ok" }, disabled: { label: "O‘chirilgan", tone: "" }, none: { label: "Yaratilmagan", tone: "" } };

export function CabinetsList() {
  const nav = useNavigate();
  const [state, setState] = useState("");
  const data = useLoad(() => api.get<{ items: CabRow[]; register_url: string }>("/admin/team-cabinets"), []);
  const items = (data.data?.items || []).filter((x) => !state || x.state === state);
  const n = (s: string) => (data.data?.items || []).filter((x) => x.state === s).length;
  return (
    <>
      <PageHead title="Arizalar" sub="Jamoalar kabinetlari: havola, login va parol" />
      <ArizalarTabs current="cabinets" />
      {data.data && !data.data.register_url && <div className="alert warn" style={{ marginBottom: 16 }}><I.alert size={16} /><div>REGISTER_PUBLIC_URL sozlanmagan — havola o‘rniga faqat login va parol ko‘rsatiladi.</div></div>}
      <div className="card">
        <div className="toolbar">
          <div className="chips">
            {([["", "Hammasi", data.data?.items.length || 0], ["active", "Faol", n("active")], ["disabled", "O‘chirilgan", n("disabled")], ["none", "Yaratilmagan", n("none")]] as [string, string, number][])
              .map(([k, label, c]) => <button key={k} className="chip" aria-pressed={state === k} onClick={() => setState(k)}>{label} <span className="muted">{c}</span></button>)}
          </div>
        </div>
        {data.error ? <div className="card-pad"><ErrorBox error={data.error} retry={data.reload} /></div> : !data.data ? <Loading /> : !items.length ? <Empty title="Jamoa yo‘q" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Jamoa</th><th>Login</th><th>Kabinet</th><th className="hide-mobile">Oxirgi kirish</th><th className="hide-mobile">So‘rov</th></tr></thead>
            <tbody>{items.map((r) => (
              <tr key={r.team.id} className="clickable" onClick={() => nav(`/applications/cabinets/${r.team.id}`)}>
                <td><div className="row"><TeamCrest name={r.team.name} url={r.team.crest_url} size={28} /><b>{r.team.name}</b>{!r.team.is_active && <Badge plain>nofaol</Badge>}</div></td>
                <td>{r.login ? <code>{r.login}</code> : <span className="muted">—</span>}</td>
                <td>{r.state === "none" ? <span className="link-btn small">Parol yaratish →</span> : <Badge tone={CAB_STATE[r.state].tone}>{CAB_STATE[r.state].label}</Badge>}</td>
                <td className="hide-mobile nowrap">{r.last_login_at ? fmtShort(r.last_login_at) : <span className="muted">—</span>}</td>
                <td className="hide-mobile">{r.request_status && r.request_status !== "draft" ? <Badge tone={REQ_STATUS[r.request_status]?.tone}>{REQ_STATUS[r.request_status]?.label}</Badge> : r.request_status === "draft" ? <span className="muted small">qoralama</span> : <span className="muted">—</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

/* ---------- A11: one team's cabinet ---------- */
function CopyField({ label, value, extra }: { label: string; value: string; extra?: ReactNode }) {
  const toast = useToast();
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="small" style={{ fontWeight: 600, color: "var(--text-2)" }}>{label}</span>
      <div className="copy-field">
        <span className="grow">{value}</span>
        {extra}
        <button className="btn btn-ghost btn-sm" onClick={() => copyText(value, toast)}><I.copy size={14} /> Nusxa</button>
      </div>
    </div>
  );
}

export function CabinetPage() {
  const { id } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const d = useLoad(() => api.get<CabinetInfo>(`/admin/teams/${id}/cabinet`), [id]);
  const [cred, setCred] = useState<Credentials | null>(null);
  const [busy, setBusy] = useState(false);
  const [loginEdit, setLoginEdit] = useState<string | null>(null);
  const [newLogin, setNewLogin] = useState("");

  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Loading />;
  const info = d.data;
  const acc = info.account;

  async function run<T>(fn: () => Promise<T>, ok?: string) {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(ok);
      d.reload();
      return r;
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
      return null;
    } finally {
      setBusy(false);
    }
  }
  const create = async () => {
    const r = await run(() => api.post<Credentials>(`/admin/teams/${id}/cabinet`, { login: newLogin.trim() }), "Kabinet yaratildi");
    if (r) setCred(r);
  };
  const reset = async () => {
    if (!(await confirm({ title: "Parolni yangilash", text: "Eski parol ishlamay qoladi, jamoa barcha qurilmalardan chiqadi. Yangi parolni jamoaga yuborishingiz kerak bo‘ladi.", ok: "Yangi parol" }))) return;
    const r = await run(() => api.post<Credentials>(`/admin/teams/${id}/cabinet/password`), "Yangi parol yaratildi");
    if (r) setCred(r);
  };
  const toggle = async (enabled: boolean) => {
    if (!enabled && !(await confirm({ title: "Kabinetni o‘chirish", text: "Jamoa kira olmaydi va barcha qurilmalardan chiqadi. Qoralama va yuborilgan so‘rovlar saqlanib qoladi.", ok: "O‘chirish", danger: true }))) return;
    await run(() => api.patch(`/admin/teams/${id}/cabinet`, { enabled }), enabled ? "Kabinet yoqildi" : "Kabinet o‘chirildi");
  };
  const saveLogin = async () => {
    if (loginEdit == null) return;
    const r = await run(() => api.patch(`/admin/teams/${id}/cabinet`, { login: loginEdit }), "Login o‘zgartirildi");
    if (r) setLoginEdit(null);
  };

  const shown = cred && acc && cred.login === acc.login ? cred : null;
  const url = shown?.url || acc?.url || "";
  return (
    <>
      <div className="crumbs small" style={{ marginBottom: 8 }}><Link to="/applications/cabinets">Kabinetlar</Link> / <Link to={`/teams/${info.team.id}`}>{info.team.name}</Link> / <b>Kabinet</b></div>
      <PageHead title={`${info.team.name} — kabinet`} sub="Jamoa o‘zi tarkib, shtab, forma va ma’lumotlarni tahrirlaydi. O‘zgarishlar «Arizalar → O‘zgarishlar»ga tushadi."
        actions={<>
          <Link className="btn" to={`/teams/${info.team.id}`}>Jamoa sahifasi</Link>
          {url && <a className="btn" href={url} target="_blank" rel="noopener noreferrer"><I.eye size={16} /> Kabinet sahifasi</a>}
        </>} />
      <div className="app-layout">
        <div className="stack" style={{ gap: 16 }}>
          {!acc ? (
            <div className="card">
              <div className="card-head"><h3>Kabinetga kirish</h3><Badge plain>Yaratilmagan</Badge></div>
              <div className="card-pad stack" style={{ gap: 16 }}>
                <p className="sec" style={{ margin: 0 }}>Jamoaga havola, login va parol beriladi. Parol faqat yaratilganda bir marta ko‘rsatiladi — keyin uni faqat yangilash mumkin.</p>
                <div className="stack" style={{ gap: 6, maxWidth: 420 }}>
                  <span className="small" style={{ fontWeight: 600, color: "var(--text-2)" }}>Login</span>
                  <input className="input" value={newLogin} onChange={(e) => setNewLogin(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder={info.suggested_login} />
                  <span className="muted small">Bo‘sh qoldirsangiz — {info.suggested_login}. Havola: {info.register_url ? `${info.register_url}/jamoa/${newLogin || info.suggested_login}` : "REGISTER_PUBLIC_URL sozlanmagan"}</span>
                </div>
                <div><button className="btn btn-primary" disabled={busy} onClick={create}><I.lock size={16} /> Kabinet va parol yaratish</button></div>
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-head">
                <h3>Kabinetga kirish</h3>
                <label className="toggle-row" style={{ gap: 10 }}><span><b className="small">Kabinet yoqilgan</b></span><input type="checkbox" className="switch" checked={acc.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} /></label>
              </div>
              <div className="card-pad stack" style={{ gap: 16 }}>
                <p className="sec" style={{ margin: 0 }}>Jamoaga havola, login va parol yuboring. Parolni faqat admin yaratadi va yangilaydi. Kabinetni o‘chirsangiz — jamoa kira olmaydi, qoralamasi saqlanib qoladi.</p>
                {!acc.enabled && <div className="alert warn"><I.lock size={16} /><div>Kabinet o‘chirilgan — jamoa kira olmaydi.</div></div>}
                {url && <CopyField label="Havola" value={url} />}
                <CopyField label="Login" value={acc.login} />
                {shown ? (
                  <>
                    <CopyField label="Parol" value={shown.password} extra={<Badge tone="ok">Yangi</Badge>} />
                    <div className="alert danger"><I.alert size={16} /><div>Parol faqat hozir ko‘rinadi. Sahifadan chiqsangiz uni ko‘rib bo‘lmaydi — faqat yangilash mumkin.</div></div>
                    <span className="small" style={{ fontWeight: 600, color: "var(--text-2)" }}>JAMOAGA YUBORILADIGAN XABAR</span>
                    <pre className="cab-msg">{shown.message}</pre>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <button className="btn btn-primary" onClick={() => copyText(shown.message, toast, "Xabar nusxalandi")}><I.copy size={16} /> Hammasini nusxalash</button>
                      <a className="btn" href={tgShare(shown.url || "", shown.message)} target="_blank" rel="noopener noreferrer"><I.telegram size={16} /> Telegramda ulashish</a>
                      <a className="btn" href={`sms:?&body=${encodeURIComponent(shown.message)}`}><I.inbox size={16} /> SMS yuborish</a>
                    </div>
                  </>
                ) : (
                  <div className="stack" style={{ gap: 6 }}>
                    <span className="small" style={{ fontWeight: 600, color: "var(--text-2)" }}>Parol</span>
                    <div className="copy-field"><span className="grow muted">•••••••••• · {fmtDateTime(acc.password_set_at)} da o‘rnatilgan</span><button className="btn btn-sm" disabled={busy} onClick={reset}>Yangi parol</button></div>
                    <span className="muted small">Parol saqlanmaydi, uni ko‘rib bo‘lmaydi. Jamoa unutgan bo‘lsa — yangisini yarating va yuboring.</span>
                  </div>
                )}
              </div>
            </div>
          )}
          {acc && (
            <div className="card">
              <div className="card-head"><h3>Xavfsizlik</h3></div>
              <div className="kv-list sec-list">
                <div><span><b>Parolni yangilash</b><small>Eski parol ishlamay qoladi, jamoa barcha qurilmalardan chiqadi.</small></span><span><button className="btn btn-sm" disabled={busy} onClick={reset}>Yangi parol</button></span></div>
                <div>
                  <span><b>Loginni o‘zgartirish</b><small>Havola ham o‘zgaradi: …/jamoa/&lt;login&gt;. Eski havola ishlamaydi.</small></span>
                  <span>{loginEdit == null ? <button className="btn btn-sm" onClick={() => setLoginEdit(acc.login)}>O‘zgartirish</button> : (
                    <span className="row" style={{ gap: 6 }}>
                      <input className="input input-sm" style={{ width: 180 }} value={loginEdit} onChange={(e) => setLoginEdit(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} autoFocus />
                      <button className="btn btn-sm btn-primary" disabled={busy || loginEdit.length < 3} onClick={saveLogin}>Saqlash</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => setLoginEdit(null)}>✕</button>
                    </span>
                  )}</span>
                </div>
                <div><span><b>Kabinetni {acc.enabled ? "o‘chirish" : "yoqish"}</b><small>{acc.enabled ? "Kirish yopiladi. Yuborilgan so‘rovlar va qoralama saqlanib qoladi." : "Jamoa yana o‘z login va paroli bilan kira oladi."}</small></span>
                  <span>{acc.enabled ? <button className="btn btn-sm btn-destructive" disabled={busy} onClick={() => toggle(false)}>O‘chirish</button> : <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => toggle(true)}>Yoqish</button>}</span></div>
              </div>
            </div>
          )}
        </div>
        <aside>
          {acc && (
            <div className="card">
              <div className="card-head"><h3>Holat</h3><Badge tone={acc.enabled ? "ok" : ""}>{acc.enabled ? "Faol" : "O‘chirilgan"}</Badge></div>
              <div className="kv-list">
                <div><span>Yaratildi</span><span>{fmtShort(acc.created_at)}{acc.created_by ? ` · ${acc.created_by}` : ""}</span></div>
                <div><span>Oxirgi kirish</span><span>{acc.last_login_at ? `${fmtDateTime(acc.last_login_at)}${acc.last_device ? ` · ${acc.last_device}` : ""}` : "hali kirilmagan"}</span></div>
                <div><span>Faol seanslar</span><span>{acc.sessions} ta qurilma</span></div>
                <div><span>Xato urinishlar</span><span>{acc.locked_until && new Date(acc.locked_until) > new Date() ? `bloklangan ${fmtDateTime(acc.locked_until)} gacha` : acc.failed_attempts}</span></div>
                {info.has_draft && <div><span>Qoralama</span><span>jamoa tahrirlamoqda</span></div>}
              </div>
            </div>
          )}
          <div className="card">
            <div className="card-head"><h3>O‘zgarishlar so‘rovlari</h3></div>
            {info.requests.length ? (
              <div className="kv-list">
                {info.requests.map((q) => <div key={q.id}><span><Link to={`/applications/changes/${q.id}`}><b>{q.number}</b></Link><small className="muted" style={{ display: "block" }}>{fmtShort(q.submitted_at || q.decided_at)} · {q.counts.total} band</small></span><span><Badge tone={REQ_STATUS[q.status]?.tone}>{REQ_STATUS[q.status]?.label || q.status}</Badge></span></div>)}
              </div>
            ) : <div className="card-pad muted small">Hali so‘rov yo‘q</div>}
          </div>
          <div className="card">
            <div className="card-head"><h3>Tarix</h3></div>
            <div className="card-pad events">
              {info.events.length ? info.events.map((e, i) => <div key={i}><div><b>{CAB_EVENT[e.kind] || e.kind}{e.number ? ` · ${e.number}` : ""}</b><div className="muted small">{fmtDateTime(e.created_at)}{e.user_name ? ` · ${e.user_name}` : ""}</div>{e.note && <div className="small" style={{ marginTop: 2 }}>{e.note}</div>}</div></div>) : <span className="muted small">Bo‘sh</span>}
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

/* ---------- side card on the team edit page ---------- */
export function TeamCabinetCard({ teamId }: { teamId: number }) {
  const { data } = useLoad(() => api.get<CabinetInfo>(`/admin/teams/${teamId}/cabinet`).catch(() => null), [teamId]);
  if (!data) return null;
  const acc = data.account;
  const open = data.requests.find((q) => q.status === "submitted");
  return (
    <div className="card">
      <div className="card-head"><h3>Jamoa kabineti</h3>{acc ? <Badge tone={acc.enabled ? "ok" : ""}>{acc.enabled ? "Faol" : "O‘chirilgan"}</Badge> : <Badge plain>Yo‘q</Badge>}</div>
      <div className="card-pad stack" style={{ gap: 10 }}>
        {acc ? <span className="small">Login: <code>{acc.login}</code>{acc.last_login_at ? <span className="muted"> · oxirgi kirish {fmtShort(acc.last_login_at)}</span> : null}</span>
          : <span className="muted small">Jamoa o‘zi tarkib va ma’lumotlarni tahrirlashi uchun login va parol bering.</span>}
        {open && <Link className="alert warn small" to={`/applications/changes/${open.id}`}><I.inbox size={14} /><span>{open.number} — yangi o‘zgarishlar</span></Link>}
        <Link className="btn btn-block" to={`/applications/cabinets/${teamId}`}>{acc ? "Kabinetni boshqarish" : "Login va parol yaratish"}</Link>
      </div>
    </div>
  );
}
