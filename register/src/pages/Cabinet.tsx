import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { ApiError, type ImportResult } from "@/lib/api";
import { emptyCabPlayer, forgetSession, savedSession, setToken, team, type CabCheck, type CabDoc, type CabPlayer, type CabStaff, type ChangeItem, type TeamView } from "@/lib/team";
import { HELP_URL, Page, StateCard } from "@/components/Shell";
import { ImportButton, ImportModal, Jersey, PlayerModal, StaffModal, type Uploader } from "@/components/Roster";
import { CheckLine, Field, Loading, Modal, Pill, Spinner, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { STAFF_ROLES, fmtBirth, fmtDateTime, fullName, initials } from "@/lib/format";

import { tx } from "@/lib/i18n";
/* Team cabinet: /jamoa/{login}. The team signs in with the league's login and
   password, edits a draft (team info, roster, staff, kit) and sends it for
   review; nothing reaches the site before the league approves it. */

export function CabinetPage() {
  const { login: raw = "" } = useParams();
  const login = raw.toLowerCase();
  const [authed, setAuthed] = useState(() => {
    const s = savedSession(login || undefined);
    if (s) setToken(s.token);
    return !!s;
  });
  if (!authed) return <LoginView login={login} onIn={() => setAuthed(true)} />;
  return <Cabinet onOut={() => { setToken(""); forgetSession(); setAuthed(false); }} />;
}

/* ---------- K1: sign in ---------- */

function LoginView({ login: urlLogin, onIn }: { login: string; onIn: () => void }) {
  const navigate = useNavigate();
  const [info, setInfo] = useState<{ name: string; crest_url: string; enabled: boolean } | null | undefined>(urlLogin ? undefined : null);
  const [login, setLogin] = useState(urlLogin);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!urlLogin) return;
    team.account(urlLogin).then(setInfo).catch((e) => {
      setInfo(null);
      if (e instanceof ApiError && e.status === 404) setMissing(true);
    });
  }, [urlLogin]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!login.trim() || !password) {
      setError(tx("Login va parolni kiriting"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await team.login(login, password, remember);
      if (r.team.login !== urlLogin) navigate(`/jamoa/${r.team.login}`, { replace: true });
      onIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : tx("Xato"));
      setBusy(false);
    }
  }

  if (missing) {
    return (
      <Page tag="Jamoa kabineti">
        <StateCard state="missing" />
      </Page>
    );
  }
  if (info === undefined) return <Page tag="Jamoa kabineti"><Loading /></Page>;
  const closed = info && !info.enabled;
  return (
    <Page tag="Jamoa kabineti">
      <section className="hero compact">
        <div className="grow">
          <div className="over">{tx("Jamoa kabineti")}</div>
          <h1>{info?.name || tx("Kabinetga kirish")}</h1>
        </div>
      </section>
      <div className="wrap">
        <form className="login-card" onSubmit={submit} noValidate>
          <div className="row" style={{ gap: 14 }}>
            {info?.crest_url ? <img className="login-crest" src={info.crest_url} alt="" /> : <span className="login-ic"><I.lock size={20} /></span>}
            <div className="grow">
              <h2>{tx("Jamoa kabinetiga kirish")}</h2>
              <p className="sec small">{tx("Login va parolni liga ma’muriyati beradi.")}</p>
            </div>
          </div>
          {closed && <div className="box err"><CheckLine level="error">{tx("Kabinet yopilgan. Savollar bo‘lsa — liga ma’muriyatiga yozing.")}</CheckLine></div>}
          {error && <div className="box err" role="alert"><CheckLine level="error">{error}</CheckLine></div>}
          <Field label={tx("Login")} hint={urlLogin ? tx("Havoladan to‘ldirildi") : undefined}>
            <input className="input" value={login} onChange={(e) => setLogin(e.target.value)} autoCapitalize="none" autoCorrect="off" autoComplete="username" spellCheck={false} />
          </Field>
          <div className="field">
            <label htmlFor="pw">{tx("Parol")}</label>
            <div className="pw">
              <input id="pw" className="input" type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus={!!urlLogin} aria-invalid={!!error} />
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setShow(!show)} aria-label={show ? tx("Parolni yashirish") : tx("Parolni ko‘rsatish")}><I.eye size={16} /></button>
            </div>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span>{tx("Eslab qolish")}</span></label>
            <a className="small accent-text" href={HELP_URL} target="_blank" rel="noopener noreferrer"><b>{tx("Parolni unutdingizmi?")}</b></a>
          </div>
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !!closed}>{busy ? <Spinner /> : tx("Kirish")}</button>
          <div className="note"><I.lock size={16} /><span>{tx("Parolni unutsangiz — liga menejeriga yozing, admin yangi parol beradi. Login va parolni boshqalarga bermang.")}</span></div>
        </form>
      </div>
    </Page>
  );
}

/* ---------- the cabinet ---------- */

type Section = "team" | "roster" | "staff" | "kit";
const SECTIONS: { key: Section; title: string; sub: string; icon: ReactNode }[] = [
  { key: "team", title: tx("Jamoa"), sub: tx("Logotip, nomi, aloqa"), icon: <I.trophy size={18} /> },
  { key: "roster", title: tx("Tarkib"), sub: tx("O‘yinchilar va media"), icon: <I.users size={18} /> },
  { key: "staff", title: tx("Shtab"), sub: tx("Murabbiy va yordamchilar"), icon: <I.user size={18} /> },
  { key: "kit", title: tx("Forma"), sub: tx("Ranglar va forma rasmi"), icon: <I.shirt size={18} /> },
];
const KIT_FIELDS = ["team.colors", "team.kit_url"];

function sectionOf(it: { key: string; kind: string }): Section {
  if (it.kind === "player") return "roster";
  if (it.kind === "staff") return "staff";
  return KIT_FIELDS.includes(it.key) ? "kit" : "team";
}

const cabUploader: Uploader = {
  photo: (f) => team.image("photo", f),
  medical: (f) => team.medical(f),
  importRoster: (f) => team.importRoster(f),
};

function Cabinet({ onOut }: { onOut: () => void }) {
  const toast = useToast();
  const [view, setView] = useState<TeamView | null>(null);
  const [doc, setDoc] = useState<CabDoc | null>(null);
  const [section, setSection] = useState<Section>("roster");
  const [saving, setSaving] = useState<"" | "saving" | "error">("");
  const [savedAt, setSavedAt] = useState<string>("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const docRef = useRef<CabDoc | null>(null);
  const version = useRef(0);
  const saved = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) {
      onOut();
      return;
    }
    toast(e instanceof Error ? e.message : tx("Xato"), "error");
  }, [onOut, toast]);

  const adopt = useCallback((v: TeamView) => {
    setView(v);
    setDoc(v.draft);
    docRef.current = v.draft;
    version.current++;
    saved.current = version.current;
  }, []);

  useEffect(() => {
    team.me().then(adopt).catch(fail);
  }, [adopt, fail]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (saved.current === version.current || !docRef.current) return;
    const v = version.current;
    setSaving("saving");
    try {
      const r = await team.save(docRef.current);
      saved.current = v;
      // keep what the team typed; take the server's verdict (items, checks)
      setView(r);
      if (v === version.current) {
        setDoc(r.draft);
        docRef.current = r.draft;
      }
      setSaving("");
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setSaving("error");
      fail(e);
    }
  }, [fail]);

  const update = useCallback((fn: (d: CabDoc) => CabDoc) => {
    setDoc((d) => {
      if (!d) return d;
      const n = fn(d);
      docRef.current = n;
      return n;
    });
    version.current++;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flush(); }, 700);
  }, [flush]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function act(fn: () => Promise<TeamView>, ok: string) {
    setBusy(true);
    try {
      await flush();
      adopt(await fn());
      if (ok) toast(ok);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && e.body?.checks) {
        setView((v) => (v ? { ...v, checks: e.body.checks } : v));
      }
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!view || !doc) return <Page tag="Jamoa kabineti"><Loading /></Page>;

  const req = view.request;
  const editable = view.editable;
  const items = view.items;
  const counts: Record<Section, number> = { team: 0, roster: 0, staff: 0, kit: 0 };
  for (const it of items) counts[sectionOf(it)]++;
  const errors = view.checks.filter((c) => c.level === "error");
  const statusPill = req?.status === "submitted" ? <Pill tone="info">{tx("Tekshiruvda")}</Pill> : req?.status === "changes" ? <Pill tone="warn">{tx("Tuzatish kerak")}</Pill> : items.length ? <Pill tone="neutral">{tx("Qoralama")}</Pill> : null;

  const sectionView = {
    team: <TeamSection doc={doc} live={view.live} update={update} locked={!editable} checks={view.checks} />,
    roster: <RosterSection doc={doc} live={view.live} items={items} update={update} locked={!editable} checks={view.checks} />,
    staff: <StaffSection doc={doc} items={items} update={update} locked={!editable} />,
    kit: <KitSection doc={doc} live={view.live} update={update} locked={!editable} />,
  }[section];

  return (
    <Page tag="Jamoa kabineti">
      <section className="hero compact">
        <div className="grow">
          <div className="over">{tx("Jamoa kabineti")}</div>
          <h1>{view.team.name}</h1>
        </div>
        <div className="hero-meta">
          {view.last?.decided_at && <span className="hero-pill"><I.check size={16} />{tx("Oxirgi tasdiq:")}{" "}{fmtDateTime(view.last.decided_at)}</span>}
          {view.team.site_url && <a className="hero-pill" href={view.team.site_url} target="_blank" rel="noopener noreferrer"><I.globe size={16} />{tx("Saytda")}</a>}
          <button type="button" className="hero-pill" onClick={() => { void team.logout().finally(onOut); }}><I.logout size={16} />{view.team.login}{" "}{tx("· Chiqish")}</button>
        </div>
      </section>
      <div className="wrap">
        <div className="cols wide">
          <aside className="stack">
            <nav className="stepper" aria-label={tx("Bo‘limlar")}>
              {SECTIONS.map((s) => (
                <button key={s.key} type="button" className={`step${section === s.key ? " cur" : ""}`} onClick={() => setSection(s.key)}>
                  <span className="nav-ic">{s.icon}</span>
                  <div className="grow"><b>{s.title}</b><small>{s.sub}</small></div>
                  {counts[s.key] > 0 && <span className="flag"><Pill tone="warn">{counts[s.key]}{" "}{tx("o‘zg.")}</Pill></span>}
                </button>
              ))}
            </nav>
            {(items.length > 0 || req) && (
              <div className="card d-only">
                <div className="card-head"><h3>{tx("O‘zgarishlar")}</h3>{statusPill}</div>
                <div className="card-pad stack" style={{ gap: 10 }}>
                  {items.length ? <ItemList items={items.slice(0, 8)} compact /> : <span className="small sec">{tx("Hali o‘zgarish yo‘q")}</span>}
                  {items.length > 8 && <span className="small sec">{tx("Yana {0} ta…", items.length - 8)}</span>}
                  <span className="small sec">{req?.status === "submitted" ? tx("Yuborildi {0}. Tekshiruv paytida tahrirlash yopiq.", fmtDateTime(req.submitted_at)) : tx("Saqlangan, lekin hali yuborilmagan. Saytda hozirgi ma’lumotlar turadi — o‘zgarishlar liga tasdiqlagandan keyin chiqadi.")}</span>
                  {req?.status === "submitted"
                    ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act(team.withdraw, tx("So‘rov qaytarib olindi — tahrirlash mumkin"))}>{tx("Qaytarib olish")}</button>
                    : items.length > 0 && <DiscardButton busy={busy} onConfirm={() => act(team.discard, tx("O‘zgarishlar bekor qilindi"))} returned={req?.status === "changes"} />}
                </div>
              </div>
            )}
          </aside>
          <main className="stack" style={{ minWidth: 0 }}>
            <div className="cab-chips m-only" role="tablist">
              {SECTIONS.map((s) => (
                <button key={s.key} type="button" className={`chip${section === s.key ? " on" : ""}`} onClick={() => setSection(s.key)} role="tab" aria-selected={section === s.key}>
                  {s.title}{counts[s.key] > 0 && <span className="cnt">{counts[s.key]}</span>}
                </button>
              ))}
            </div>
            <StatusBanner view={view} busy={busy} onWithdraw={() => act(team.withdraw, tx("So‘rov qaytarib olindi — tahrirlash mumkin"))} />
            {items.length > 0 && editable && (
              <div className="note m-only" style={{ borderColor: "var(--amber-500)" }}>
                <I.edit size={16} />
                <span className="grow"><b style={{ color: "var(--text)" }}>{items.length}{" "}{tx("ta o‘zgarish · qoralama")}</b><br />{tx("Saytda hozirgi ma’lumotlar — tasdiqlangach yangilanadi")}</span>
              </div>
            )}
            {sectionView}
            {editable && (
              <div className="cab-bar">
                {saving === "saving" ? <Spinner /> : saving === "error" ? <I.alert size={16} /> : <I.check size={16} />}
                <div className="grow">
                  <b>{items.length ? tx("{0} ta o‘zgarish", items.length) : tx("O‘zgarish yo‘q")}</b>
                  <small>{saving === "saving" ? tx("Saqlanmoqda…") : saving === "error" ? tx("Saqlanmadi — internetni tekshiring") : savedAt ? tx("Avtomatik saqlandi · {0}", fmtDateTime(savedAt).split(", ")[1]) : tx("O‘zgarishlar avtomatik saqlanadi")}</small>
                </div>
                <button type="button" className="btn btn-primary" disabled={!items.length || busy} onClick={async () => { await flush(); setReview(true); }}>
                  <span className="d-only">{tx("Ko‘rib chiqish va yuborish")}</span><span className="m-only">{tx("Yuborish")}</span>
                </button>
              </div>
            )}
          </main>
        </div>
      </div>
      {review && (
        <Modal title={tx("Tekshiruvga yuborish")} onClose={() => setReview(false)}
          footer={<>
            <button type="button" className="btn btn-ghost" onClick={() => setReview(false)}>{tx("Orqaga")}</button>
            <button type="button" className="btn btn-primary" disabled={busy || !!errors.length || !items.length}
              onClick={async () => { if (await act(team.submit, tx("Yuborildi — liga tekshiradi"))) setReview(false); }}>{busy ? <Spinner /> : tx("Tekshiruvga yuborish")}</button>
          </>}>
          <p className="sec">{tx("Liga quyidagi o‘zgarishlarni ko‘rib chiqadi. Tasdiqlangan bandlar saytga chiqadi, qolganlari izoh bilan qaytadi. Tekshiruv paytida tahrirlash yopiq.")}</p>
          {!!view.checks.length && (
            <div className={`box ${errors.length ? "err" : "warn"}`}>
              {view.checks.map((c, i) => <CheckLine key={i} level={c.level}>{c.text}</CheckLine>)}
            </div>
          )}
          <div className="sum"><div className="sum-head">{items.length}{" "}{tx("ta o‘zgarish")}</div><div className="card-pad"><ItemList items={items} /></div></div>
        </Modal>
      )}
    </Page>
  );
}

function DiscardButton({ busy, onConfirm, returned }: { busy: boolean; onConfirm: () => void; returned: boolean }) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setAsk(true)}>{tx("Hammasini bekor qilish")}</button>;
  return (
    <div className="box sub">
      <span className="small">{returned ? tx("So‘rov yopiladi, tuzatilmagan bandlar o‘chadi. Davom etasizmi?") : tx("Barcha saqlangan o‘zgarishlar o‘chadi. Davom etasizmi?")}</span>
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={() => setAsk(false)}>{tx("Yo‘q")}</button>
        <button type="button" className="btn btn-sm btn-dark" disabled={busy} onClick={onConfirm}>{tx("Ha, bekor qilish")}</button>
      </div>
    </div>
  );
}

/* ---------- K4: request state ---------- */

const DECISION: Record<string, { tone: string; label: string }> = {
  approved: { tone: "ok", label: tx("Qabul qilindi") },
  rejected: { tone: "danger", label: tx("Rad etildi") },
  fix: { tone: "danger", label: tx("Tuzatish kerak") },
};

function StatusBanner({ view, busy, onWithdraw }: { view: TeamView; busy: boolean; onWithdraw: () => void }) {
  const req = view.request;
  if (req?.status === "submitted") {
    return (
      <div className="card">
        <div className="banner sub">
          <I.clock size={20} />
          <div className="grow">
            <div className="row wrapx" style={{ gap: 8 }}><b>{tx("So‘rov {0} yuborildi", req.number)}</b><Pill tone="info">{tx("Tekshiruvda")}</Pill></div>
            <p className="sec">{fmtDateTime(req.submitted_at)}{tx(". Liga odatda 1 kun ichida ko‘rib chiqadi. Tekshiruv paytida tahrirlash yopiq — o‘zgartirish kerak bo‘lsa, so‘rovni qaytarib oling.")}</p>
          </div>
        </div>
        <div className="card-pad"><ItemList items={req.items} /></div>
        <div className="form-foot">
          <span className="grow">{tx("Natija shu sahifada ko‘rinadi.")}</span>
          <button type="button" className="btn" disabled={busy} onClick={onWithdraw}>{tx("Qaytarib olish")}</button>
        </div>
      </div>
    );
  }
  if (req?.status === "changes") {
    return (
      <div className="card">
        <div className="banner err">
          <I.alert size={20} />
          <div className="grow">
            <div className="row wrapx" style={{ gap: 8 }}><b>{tx("Liga so‘rovni tuzatishga qaytardi")}</b><Pill tone="warn">{tx("Tuzatish kerak")}</Pill></div>
            {req.comment && <p>«{req.comment}»</p>}
            <p className="sec small">{fmtDateTime(req.decided_at)}{tx(". Qabul qilingan bandlar allaqachon saytda. Qolganlarini tuzating va qayta yuboring.")}</p>
          </div>
        </div>
        <div className="card-pad"><ItemList items={req.items} decisions /></div>
      </div>
    );
  }
  const last = view.last;
  if (!req && last?.decided_at && Date.now() - new Date(last.decided_at).getTime() < 30 * 86400e3) {
    const tone = last.status === "approved" ? "ok" : last.status === "partial" ? "warn" : "err";
    const title = last.status === "approved" ? tx("O‘zgarishlar saytda") : last.status === "partial" ? tx("So‘rov qisman tasdiqlandi") : tx("So‘rov rad etildi");
    return (
      <div className="card">
        <div className={`banner ${tone}`}>
          {last.status === "rejected" ? <I.alert size={20} /> : <I.check size={20} />}
          <div className="grow">
            <div className="row wrapx" style={{ gap: 8 }}><b>{title}</b><span className="small sec">{last.number} · {fmtDateTime(last.decided_at)}</span></div>
            {last.comment && <p>«{last.comment}»</p>}
            {last.status !== "approved" && <details><summary className="small">{tx("Bandlar")}</summary><div style={{ marginTop: 10 }}><ItemList items={last.items} decisions /></div></details>}
          </div>
        </div>
      </div>
    );
  }
  return null;
}

/* ---------- change lists ---------- */

const IMAGE_FIELDS = ["crest_url", "kit_url", "photo_url"];
function fieldText(f: { field: string; before: string; after: string }) {
  if (IMAGE_FIELDS.includes(f.field)) return f.after ? (f.before ? tx("yangi rasm") : tx("rasm qo‘shildi")) : tx("rasm olib tashlandi");
  if (f.field === "birth_date") return `${fmtBirth(f.before) || "—"} → ${fmtBirth(f.after)}`;
  if (f.field === "medical") return tx("yangi fayl");
  return `${f.before || "—"} → ${f.after || "—"}`;
}

export function ItemList({ items, compact, decisions }: { items: ChangeItem[]; compact?: boolean; decisions?: boolean }) {
  return (
    <div className="items">
      {items.map((it) => {
        const sign = it.op === "add" ? "+" : it.op === "remove" ? "−" : "✎";
        const detail = it.op === "update" ? it.fields.map((f) => (it.kind === "team" ? fieldText(f) : `${f.label}: ${fieldText(f)}`)).join(" · ") : it.op === "remove" ? (it.kind === "staff" ? tx("shtabdan chiqadi") : tx("tarkibdan chiqadi")) : it.kind === "staff" ? tx("yangi shtab a’zosi") : tx("yangi o‘yinchi");
        const d = decisions && it.decision ? DECISION[it.decision] : null;
        return (
          <div key={it.key} className="item">
            <span className={`sign ${it.op}`}>{sign}</span>
            <div className="grow">
              <b>{it.title}</b>
              {!compact && <small>{detail}</small>}
              {compact && it.op === "update" && it.kind !== "team" && <small>{detail}</small>}
            </div>
            {d && <Pill tone={d.tone}>{d.label}</Pill>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- sections ---------- */

function useKeyed(items: ChangeItem[]) {
  return useMemo(() => {
    const m: Record<string, ChangeItem> = {};
    for (const it of items) m[it.key] = it;
    return m;
  }, [items]);
}

function Was({ before, now }: { before: string; now: string }) {
  if (before === now) return null;
  return <span className="hint warn-text">{tx("Avval:")}{" "}{before || "—"}{" "}{tx("· tasdiqlangach saytda")}</span>;
}

function SectionCard({ over, title, sub, actions, children }: { over: string; title: string; sub: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      <div className="form-head row top wrapx" style={{ gap: 12 }}>
        <div className="grow" style={{ minWidth: 240 }}>
          <div className="over">{over}</div>
          <h2>{title}</h2>
          <p>{sub}</p>
        </div>
        {actions && <div className="row wrapx">{actions}</div>}
      </div>
      <div className="form-body">{children}</div>
    </div>
  );
}

function ImagePick({ label, hint, value, live, kind, locked, onChange, round }: {
  label: string; hint: string; value: string; live: string; kind: "logo" | "kit"; locked: boolean; onChange: (url: string) => void; round?: boolean;
}) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function pick(f?: File) {
    if (!f) return;
    setBusy(true);
    try {
      onChange((await team.image(kind, f)).url);
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Yuklashda xato"), "error");
    } finally {
      setBusy(false);
    }
  }
  const changed = value !== live;
  const box = (url: string, dim?: boolean) => <div className={`logo-prev${round ? " round" : ""}${dim ? " dim" : ""}`}>{url ? <img src={url} alt="" /> : <I.image size={22} />}</div>;
  return (
    <div className="field">
      <span className="lbl">{label}</span>
      <div className="logo-row cab-logo">
        {changed && live && <>{box(live, true)}<span className="arrow"><I.arrow size={18} /></span></>}
        {box(value)}
        <div className="stack grow" style={{ gap: 8 }}>
          {changed ? <span><Pill tone="warn">{tx("O‘zgartirildi")}</Pill></span> : null}
          <span className="small sec">{changed ? tx("Tasdiqlangunga qadar saytda eskisi turadi.") : hint}</span>
          {!locked && (
            <div className="row wrapx">
              <button type="button" className="btn btn-sm" onClick={() => ref.current?.click()} disabled={busy}>{busy ? <Spinner /> : <I.upload size={14} />} {value ? tx("Boshqa rasm") : tx("Yuklash")}</button>
              {changed && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(live)}>{tx("Qaytarish")}</button>}
            </div>
          )}
        </div>
      </div>
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
    </div>
  );
}

function TeamSection({ doc, live, update, locked, checks }: { doc: CabDoc; live: CabDoc; update: (fn: (d: CabDoc) => CabDoc) => void; locked: boolean; checks: CabCheck[] }) {
  const t = doc.team;
  const set = <K extends keyof CabDoc["team"]>(k: K, v: CabDoc["team"][K]) => update((d) => ({ ...d, team: { ...d.team, [k]: v } }));
  const err = (k: string) => checks.find((c) => c.key === k && c.level === "error")?.text;
  return (
    <SectionCard over={tx("Jamoa")} title={tx("Jamoa ma’lumotlari")} sub={tx("Saytdagi jamoa sahifasida, jadvalda va match kartochkalarida ko‘rinadi.")}>
      <ImagePick label={tx("Logotip")} hint={tx("PNG yoki JPG · kamida 512×512 · shaffof fon")} value={t.crest_url} live={live.team.crest_url} kind="logo" locked={locked} onChange={(u) => set("crest_url", u)} />
      <div className="g2">
        <Field label={tx("Jamoa nomi")} hint={tx("Nomni faqat liga o‘zgartiradi")}><input className="input" value={t.name} disabled /></Field>
        <div className="field">
          <label>{tx("Qisqa nomi")}</label>
          <input className="input" value={t.short_name} disabled={locked} aria-invalid={!!err("team.short_name")} onChange={(e) => set("short_name", e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4))} />
          {err("team.short_name") ? <span className="err">{err("team.short_name")}</span> : t.short_name !== live.team.short_name ? <Was before={live.team.short_name} now={t.short_name} /> : <span className="hint">{tx("2–4 lotin harfi, jadvalda ko‘rinadi")}</span>}
        </div>
      </div>
      <div className="g2">
        <div className="field">
          <label>{tx("Instagram")}</label>
          <input className="input" value={t.instagram} disabled={locked} maxLength={200} placeholder="@jamoa" onChange={(e) => set("instagram", e.target.value)} />
          <Was before={live.team.instagram} now={t.instagram} />
        </div>
        <div className="field">
          <label>{tx("Telegram")}</label>
          <input className="input" value={t.telegram} disabled={locked} maxLength={200} placeholder="@jamoa" onChange={(e) => set("telegram", e.target.value)} />
          <Was before={live.team.telegram} now={t.telegram} />
        </div>
      </div>
      <div className="field">
        <label>{tx("Jamoa lideri")}</label>
        <input className="input" value={t.leader} disabled={locked} maxLength={120} onChange={(e) => set("leader", e.target.value)} />
        <Was before={live.team.leader} now={t.leader} />
      </div>
    </SectionCard>
  );
}

const COLOR_LABELS = [tx("Asosiy rang"), tx("Ikkinchi rang"), tx("Uchinchi rang")];

function KitSection({ doc, live, update, locked }: { doc: CabDoc; live: CabDoc; update: (fn: (d: CabDoc) => CabDoc) => void; locked: boolean }) {
  const colors = doc.team.colors;
  const setColors = (c: string[]) => update((d) => ({ ...d, team: { ...d.team, colors: c } }));
  const changed = colors.join(" ") !== live.team.colors.join(" ");
  return (
    <SectionCard over={tx("Forma")} title={tx("Jamoa formasi")} sub={tx("Ranglar jadvalda, match kartochkalarida va o‘yinchi kartalarida ishlatiladi.")}>
      <div className="row top wrapx" style={{ gap: 24 }}>
        <div className="stack grow" style={{ minWidth: 240 }}>
          <span className="lbl">{tx("Forma ranglari")}{" "}{changed && <Pill tone="warn">{tx("O‘zgartirildi")}</Pill>}</span>
          {colors.map((c, i) => (
            <div key={i} className="row">
              <label className="color-pick">
                <input type="color" value={c} disabled={locked} onChange={(e) => setColors(colors.map((x, j) => (j === i ? e.target.value.toUpperCase() : x)))} />
                <span><b>{COLOR_LABELS[i]}</b><span className="small sec">{c}</span></span>
              </label>
              {!locked && (i > 0 ? <button type="button" className="btn btn-ghost btn-icon" aria-label={tx("Rangni olib tashlash")} onClick={() => setColors(colors.filter((_, j) => j !== i))}><I.x size={16} /></button> : <span style={{ width: 32, flex: "none" }} />)}
            </div>
          ))}
          {!locked && colors.length < 3 && <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setColors([...colors, colors.length ? "#FFFFFF" : "#1D4ED8"])}><I.plus size={14} />{" "}{tx("Rang qo‘shish")}</button>}
          {changed && <span className="hint warn-text">{tx("Avval:")}{" "}{live.team.colors.join(", ") || "—"}{tx(". Tasdiqlangunga qadar saytda eski ranglar.")}</span>}
        </div>
        <div style={{ width: 200, background: "var(--subtle)", borderRadius: 6, padding: "20px 0" }}><Jersey color={colors[0] || "#1D4ED8"} name="FAMILIYA" number="10" /></div>
      </div>
      <ImagePick label={tx("Forma rasmi")} hint={tx("Futbolkaning old tomoni, tekis fonda. Liga o‘yinchilar fotolarini shu formada tayyorlaydi.")} value={doc.team.kit_url} live={live.team.kit_url} kind="kit" locked={locked}
        onChange={(u) => update((d) => ({ ...d, team: { ...d.team, kit_url: u } }))} />
    </SectionCard>
  );
}

type RowState = { label: string; tone: string } | null;

function RosterSection({ doc, live, items, update, locked, checks }: {
  doc: CabDoc; live: CabDoc; items: ChangeItem[]; update: (fn: (d: CabDoc) => CabDoc) => void; locked: boolean; checks: CabCheck[];
}) {
  const keyed = useKeyed(items);
  const [edit, setEdit] = useState<{ i: number; p: CabPlayer } | null>(null);
  const [imp, setImp] = useState<{ file: string; r: ImportResult } | null>(null);
  const color = doc.team.colors[0] || "#1D4ED8";
  const keyOf = (p: CabPlayer, i: number) => (p.id ? `player:${p.id}` : `player:new:${i}`);
  const state = (p: CabPlayer, i: number): RowState => {
    if (p.removed) return { label: tx("Chiqariladi"), tone: "danger" };
    if (!p.id) return { label: tx("Yangi"), tone: "ok" };
    if (keyed[keyOf(p, i)]) return { label: tx("O‘zgartirildi"), tone: "warn" };
    return null;
  };
  const flags: Record<number, string> = {};
  doc.players.forEach((p, i) => {
    const cs = checks.filter((c) => c.key === keyOf(p, i));
    if (cs.some((c) => c.level === "error")) flags[i] = "err";
    else if (cs.length) flags[i] = "warn";
  });
  const taken = (i: number) => doc.players.filter((p, j) => j !== i && !p.removed && p.number).map((p) => p.number!);
  const liveById = useMemo(() => Object.fromEntries(live.players.map((p) => [p.id, p])), [live.players]);

  function open(i: number) {
    const p = i < 0 ? emptyCabPlayer() : doc.players[i];
    // a medical file already on the site shows as «Yuklangan»; it is not sent back
    setEdit({ i, p: { ...p, medical: p.medical || (p.has_medical ? { file: "", name: "Yuklangan" } : null) } });
  }
  function save(p: CabPlayer, more: boolean) {
    const clean = { ...p, medical: p.medical?.file ? p.medical : null };
    update((d) => {
      const players = [...d.players];
      if (edit && edit.i >= 0) players[edit.i] = clean;
      else players.push(clean);
      return { ...d, players };
    });
    if (!more) setEdit(null);
  }
  function remove(i: number) {
    update((d) => {
      const p = d.players[i];
      if (!p.id) return { ...d, players: d.players.filter((_, j) => j !== i) };
      return { ...d, players: d.players.map((x, j) => (j === i ? { ...x, removed: true } : x)) };
    });
  }
  function restore(i: number) {
    update((d) => ({ ...d, players: d.players.map((x, j) => (j === i ? { ...x, removed: false } : x)) }));
  }
  function undo(i: number) {
    const p = doc.players[i];
    const orig = p.id ? liveById[p.id] : null;
    if (orig) update((d) => ({ ...d, players: d.players.map((x, j) => (j === i ? { ...orig } : x)) }));
  }
  function applyImport(mode: "replace" | "append") {
    if (!imp) return;
    const add: CabPlayer[] = imp.r.import.players.map((p) => ({ ...p, has_medical: false }));
    update((d) => ({
      ...d,
      players: mode === "replace" ? [...d.players.filter((p) => p.id).map((p) => ({ ...p, removed: true })), ...add] : [...d.players, ...add],
      staff: [...d.staff, ...imp.r.import.staff.map((s) => ({ ...s }))],
    }));
    setImp(null);
  }

  const rows = doc.players.map((p, i) => ({ p, i }));
  const field = rows.filter(({ p }) => p.role !== "media");
  const media = rows.filter(({ p }) => p.role === "media");
  const active = doc.players.filter((p) => !p.removed);
  const table = (list: typeof rows, title: string, addLabel: string, role: "player" | "media") => (
    <div className="stack" style={{ gap: 10 }}>
      <div className="sec-head">
        <h4>{title}</h4><span className="small sec">{list.filter(({ p }) => !p.removed).length}</span>
        <div className="grow" />
        {!locked && <button type="button" className="btn btn-sm" onClick={() => setEdit({ i: -1, p: emptyCabPlayer(role) })}><I.plus size={14} /> {addLabel}</button>}
      </div>
      {list.length ? (
        <div className="tbl">
          <div className="ctr head"><span>№</span><span>{tx("Ism familiya · ish joyi")}</span><span className="c-jersey">{tx("Futbolkada")}</span><span className="c-birth">{tx("Tug‘ilgan")}</span><span className="c-size">{tx("O‘lcham")}</span><span className="c-med">{tx("Tibbiy")}</span><span>{tx("Holat")}</span><span /></div>
          {list.map(({ p, i }) => {
            const st = state(p, i);
            const it = keyed[keyOf(p, i)];
            const numChange = it?.fields.find((f) => f.field === "number");
            return (
              <div key={p.id ? `id${p.id}` : `n${i}`} className={`ctr ${flags[i] || ""}${p.removed ? " removed" : ""}${!p.id ? " added" : ""}${!locked && !p.removed ? " clickable" : ""}`}
                onClick={() => !locked && !p.removed && open(i)}>
                <span className="num-cell">{numChange && <s className="muted small">{numChange.before}</s>}<span className="num-box">{p.number ?? "—"}</span></span>
                <div className="who">
                  <span className="avatar">{p.photo_url ? <img src={p.photo_url} alt="" /> : initials(fullName(p))}</span>
                  <div style={{ minWidth: 0 }}>
                    <b><span className="ellipsis nm">{fullName(p) || tx("Ismsiz")}</span>{p.role === "goalkeeper" && <span className="tag">{tx("GK")}</span>}</b>
                    <small className="ellipsis">{it && it.op === "update" ? it.fields.map((f) => f.label).join(", ") + tx(" o‘zgardi") : p.workplace || tx("Ish joyi ko‘rsatilmagan")}</small>
                  </div>
                </div>
                <b className="c-jersey small ellipsis">{p.jersey_name || <span className="muted">—</span>}</b>
                <span className="c-birth tnum">{fmtBirth(p.birth_date)}</span>
                <span className="c-size">{p.kit_size ? <span className="size-tag">{p.kit_size}</span> : <span className="muted">—</span>}</span>
                <span className="c-med small">{p.medical ? <span className="accent-text">{tx("✓ Yangi")}</span> : p.has_medical ? <span className="sec">{tx("✓ Bor")}</span> : <span className="muted">{tx("Yo‘q")}</span>}</span>
                <span className="c-st">{st ? <Pill tone={st.tone}>{st.label}</Pill> : <span className="small muted">{tx("Saytda")}</span>}</span>
                <span className="acts" onClick={(e) => e.stopPropagation()}>
                  {!locked && (p.removed
                    ? <button type="button" className="link-btn accent-text" onClick={() => restore(i)}>{tx("Qaytarish")}</button>
                    : <>
                      {it && it.op === "update" && <button type="button" className="btn btn-ghost btn-icon btn-sm d-only" aria-label={tx("O‘zgarishni bekor qilish")} title={tx("O‘zgarishni bekor qilish")} onClick={() => undo(i)}><I.refresh size={16} /></button>}
                      <button type="button" className="btn btn-ghost btn-icon btn-sm d-only" aria-label={tx("Tahrirlash")} onClick={() => open(i)}><I.edit size={16} /></button>
                      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={p.id ? tx("Tarkibdan chiqarish") : tx("O‘chirish")} onClick={() => remove(i)}><I.trash size={16} /></button>
                    </>)}
                </span>
              </div>
            );
          })}
        </div>
      ) : <div className="note"><I.users size={16} /><span>{tx("Hali hech kim yo‘q")}</span></div>}
    </div>
  );

  return (
    <SectionCard over={tx("Tarkib")} title={tx("O‘yinchilar va media shaxslar")} sub={tx("O‘zgartirib saqlang — saytga liga tasdiqlagandan keyin chiqadi.")}
      actions={!locked && <>
        <ImportButton up={cabUploader} onResult={(file, r) => setImp({ file, r })} />
        <button type="button" className="btn btn-dark" onClick={() => open(-1)}><I.plus size={16} />{" "}{tx("O‘yinchi qo‘shish")}</button>
      </>}>
      <div className="note"><I.alert size={16} /><span>{tx("Tarkibda 8–20 kishi. Raqamlar takrorlanmasin. Boshqa jamoadagi o‘yinchini olish — faqat liga ruxsati bilan. Chiqarilgan o‘yinchining saytdagi profili qoladi.")}</span></div>
      {checks.some((c) => c.key?.startsWith("player") || !c.key) && (
        <div className={`box ${checks.some((c) => c.level === "error") ? "err" : "warn"}`}>
          {checks.filter((c) => !c.key?.startsWith("team")).map((c, i) => <CheckLine key={i} level={c.level}>{c.text}</CheckLine>)}
        </div>
      )}
      {table(field, tx("O‘yinchilar"), tx("O‘yinchi"), "player")}
      {table(media, tx("Media shaxslar"), tx("Media shaxs"), "media")}
      <span className="small sec">{tx("Jami: {0} kishi ·", active.length)}{" "}{active.filter((p) => p.role !== "media").length}{" "}{tx("o‘yinchi")}</span>
      {edit && <PlayerModal key={edit.i} up={cabUploader} initial={edit.p} color={color} taken={taken(edit.i)} onSave={save} onClose={() => setEdit(null)} />}
      {imp && <ImportModal file={imp.file} result={imp.r} hasRoster={doc.players.some((p) => !p.removed)} canLogo={false} onApply={(m) => applyImport(m)} onClose={() => setImp(null)} />}
    </SectionCard>
  );
}

function StaffSection({ doc, items, update, locked }: { doc: CabDoc; items: ChangeItem[]; update: (fn: (d: CabDoc) => CabDoc) => void; locked: boolean }) {
  const keyed = useKeyed(items);
  const [edit, setEdit] = useState<{ i: number; s: CabStaff } | null>(null);
  const keyOf = (s: CabStaff, i: number) => (s.id ? `staff:${s.id}` : `staff:new:${i}`);
  function save(s: CabStaff) {
    update((d) => {
      const staff = [...d.staff];
      if (edit && edit.i >= 0) staff[edit.i] = s;
      else staff.push(s);
      return { ...d, staff };
    });
    setEdit(null);
  }
  function remove(i: number) {
    update((d) => {
      const s = d.staff[i];
      if (!s.id) return { ...d, staff: d.staff.filter((_, j) => j !== i) };
      return { ...d, staff: d.staff.map((x, j) => (j === i ? { ...x, removed: true } : x)) };
    });
  }
  const restore = (i: number) => update((d) => ({ ...d, staff: d.staff.map((x, j) => (j === i ? { ...x, removed: false } : x)) }));
  const empty: CabStaff = { first_name: "", last_name: "", birth_date: "", kit_size: "", role: "head_coach", phone: "" };
  return (
    <SectionCard over={tx("Shtab")} title={tx("Murabbiylar shtabi")} sub={tx("Bosh murabbiy, yordamchilar, shifokor va menejer.")}
      actions={!locked && <button type="button" className="btn btn-dark" onClick={() => setEdit({ i: -1, s: empty })}><I.plus size={16} />{" "}{tx("Qo‘shish")}</button>}>
      {doc.staff.length ? (
        <div className="tbl">
          {doc.staff.map((s, i) => {
            const st = s.removed ? { label: tx("Chiqariladi"), tone: "danger" } : !s.id ? { label: tx("Yangi"), tone: "ok" } : keyed[keyOf(s, i)] ? { label: tx("O‘zgartirildi"), tone: "warn" } : null;
            return (
              <div key={s.id ? `id${s.id}` : `n${i}`} className={`str${s.removed ? " removed" : ""}${!s.id ? " added" : ""}`}>
                <div className="who">
                  <span className="avatar">{initials(fullName(s))}</span>
                  <div style={{ minWidth: 0 }}><b className="ellipsis nm">{fullName(s) || tx("Ismsiz")}</b><small>{STAFF_ROLES[s.role] || s.role}</small></div>
                </div>
                <span className="tnum small c-birth">{fmtBirth(s.birth_date)}</span>
                <span className="c-size">{s.kit_size ? <span className="size-tag">{s.kit_size}</span> : <span className="muted">—</span>}</span>
                <span>{st ? <Pill tone={st.tone}>{st.label}</Pill> : <span className="small muted">{tx("Saytda")}</span>}</span>
                <span className="acts">
                  {!locked && (s.removed
                    ? <button type="button" className="link-btn accent-text" onClick={() => restore(i)}>{tx("Qaytarish")}</button>
                    : <>
                      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={tx("Tahrirlash")} onClick={() => setEdit({ i, s: { ...s, phone: "" } })}><I.edit size={16} /></button>
                      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={tx("O‘chirish")} onClick={() => remove(i)}><I.trash size={16} /></button>
                    </>)}
                </span>
              </div>
            );
          })}
        </div>
      ) : <div className="note"><I.user size={16} /><span>{tx("Shtab hali kiritilmagan")}</span></div>}
      {edit && <StaffModal initial={edit.s} phone={false} onSave={save} onClose={() => setEdit(null)} />}
    </SectionCard>
  );
}
