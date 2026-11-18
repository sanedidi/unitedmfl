import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type Application, type Check, type ImportResult, type Player, type Section, type Staff } from "@/lib/api";
import { REP_ROLES, STAFF_ROLES, emptyPlayer, fmtBirth, fmtDeadline, fullName, sizeSummary } from "@/lib/format";
import { CompactHero, HELP_URL, Hero, Page } from "@/components/Shell";
import { CheckLine, Field, Spinner, useToast } from "@/components/ui";
import { ImportButton, ImportModal, PlayerModal, PlayersTable, StaffModal, StaffTable, rowFlags } from "@/components/Roster";
import { I } from "@/components/Icons";

type Doc = Pick<Application, "team" | "rep" | "players" | "staff" | "consents">;
const pick = (a: Application): Doc => ({ team: a.team, rep: a.rep, players: a.players, staff: a.staff, consents: a.consents });

const STEPS: { key: Section | "submit"; title: string; sub: string }[] = [
  { key: "team", title: "Jamoa", sub: "Nomi, logotip, forma" },
  { key: "rep", title: "Vakil", sub: "Telefon va aloqa" },
  { key: "roster", title: "Tarkib", sub: "O‘yinchilar, media, murabbiy" },
  { key: "submit", title: "Tekshirish", sub: "Yuborishdan oldin" },
];

/** The application form: four steps, saved automatically to the server. */
export function Wizard({ initial, onDone }: { initial: Application; onDone: (a: Application) => void }) {
  const toast = useToast();
  const token = initial.token;
  const [app, setApp] = useState(initial);
  const [doc, setDoc] = useState<Doc>(() => pick(initial));
  const firstOpen = STEPS.findIndex((s) => s.key !== "submit" && initial.editable[s.key as Section]);
  const [step, setStep] = useState(initial.status === "changes" && firstOpen >= 0 ? firstOpen : 0);
  const [visited, setVisited] = useState<Set<number>>(() => new Set([0]));
  // field errors are shown once a step has been left (or always while correcting)
  const [left, setLeft] = useState<Set<number>>(() => new Set(initial.status === "changes" ? [0, 1, 2] : []));
  const [bigHero] = useState(initial.status === "draft" && !initial.team.name);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [savedAt, setSavedAt] = useState(initial.updated_at);
  const docRef = useRef(doc);
  const version = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const inflight = useRef<Promise<void> | null>(null);

  const flush = useCallback(async (adopt = false) => {
    window.clearTimeout(timer.current);
    if (inflight.current) await inflight.current;
    const v = version.current;
    const run = (async () => {
      setSaveState("saving");
      try {
        const res = await api.save(token, docRef.current);
        setApp(res);
        setSavedAt(res.updated_at);
        if (version.current === v) {
          setSaveState("saved");
          if (adopt) {
            docRef.current = pick(res);
            setDoc(docRef.current);
          }
        }
      } catch (e) {
        setSaveState("error");
        toast(e instanceof Error ? e.message : "Saqlanmadi", "error");
        if (e instanceof ApiError && e.status === 409) {
          api.get(token).then(onDone).catch(() => {});
        }
      }
    })();
    inflight.current = run;
    await run;
    inflight.current = null;
  }, [token, toast, onDone]);

  const update = useCallback((fn: (d: Doc) => Doc) => {
    const next = fn(docRef.current);
    docRef.current = next;
    setDoc(next);
    version.current++;
    setSaveState("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush(), 1200);
  }, [flush]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saveState === "dirty" || saveState === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  async function go(i: number) {
    if (saveState !== "saved") await flush(true);
    setLeft((v) => new Set(v).add(step));
    setStep(i);
    setVisited((v) => new Set(v).add(i));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const bySection = (s: string) => app.checks.filter((c) => c.section === s);
  const shown = (s: string, i: number) => bySection(s).filter((c) => left.has(i) || c.level === "warn");
  const errorsIn = (s: string) => bySection(s).filter((c) => c.level === "error").length;
  const locked = (s: Section) => !app.editable[s];
  const changes = app.status === "changes";

  const saved = saveState === "saving" ? "Saqlanmoqda…" : saveState === "dirty" ? "O‘zgarishlar saqlanadi…" : saveState === "error" ? "Saqlanmadi — internetni tekshiring" : `Saqlandi · ${fmtDeadline(savedAt).split(", ")[1] || ""}`;
  const footer = (next?: ReactNode) => (
    <div className="form-foot">
      <span className="grow">{saveState === "error" ? <I.alert size={14} /> : <I.check size={14} />}{saved}</span>
      {step > 0 && <button type="button" className="btn btn-ghost" onClick={() => go(step - 1)}>Orqaga</button>}
      {next ?? <button type="button" className="btn btn-primary" onClick={() => go(step + 1)}>Davom etish</button>}
    </div>
  );

  const color = doc.team.colors[0] || "#1D4ED8";
  const steps = (
    <>
      <div className="stepper" role="tablist">
        {STEPS.map((s, i) => {
          const errs = errorsIn(s.key);
          const lockedStep = changes && s.key !== "submit" && locked(s.key as Section);
          const done = i !== step && (visited.has(i) || changes) && errs === 0;
          return (
            <button type="button" key={s.key} className={`step${i === step ? " cur" : done ? " done" : ""}${lockedStep ? " locked" : ""}`} onClick={() => go(i)} role="tab" aria-selected={i === step}>
              <span className="step-dot">{done ? <I.check size={16} /> : lockedStep ? <I.lock size={14} /> : i + 1}</span>
              <span><b>{s.title}</b><small>{s.sub}</small></span>
              {errs > 0 && visited.has(i) && i !== step ? <span className="flag danger-text">{errs} xato</span> : done ? <span className="flag accent-text">Tayyor</span> : null}
            </button>
          );
        })}
      </div>
      <div className="progress">
        <div className="row" style={{ justifyContent: "space-between" }}><b className="small">{step + 1}-qadam / 4 · {STEPS[step].title}</b><span className="small muted">{STEPS[step + 1] ? `Keyingi: ${STEPS[step + 1].title}` : "Oxirgi qadam"}</span></div>
        <div className="bars">{STEPS.map((_, i) => <i key={i} className={i < step ? "done" : i === step ? "cur" : ""} />)}</div>
      </div>
    </>
  );

  return (
    <Page>
      {step === 0 && bigHero ? <Hero link={app.link} /> : <CompactHero link={app.link} title={doc.team.name ? `${doc.team.name} — ariza` : "Jamoa arizasi"} />}
      <div className="wrap">
        <div className={`cols${step === 2 ? " wide" : ""}`}>
          <div className="stack">
            {steps}
            {step === 2 && <SizesCard players={doc.players} staff={doc.staff} />}
            <div className="note"><I.refresh size={16} /><div>Ariza avtomatik saqlanadi. Sahifa havolasini saqlab qo‘ying — u orqali istalgan qurilmadan davom etasiz va holatni kuzatasiz.</div></div>
          </div>
          <div className="stack">
            {changes && <ChangesBanner app={app} />}
            {step === 0 && <TeamStep token={token} doc={doc} update={update} locked={locked("team")} checks={shown("team", 0)} footer={footer()} />}
            {step === 1 && <RepStep app={app} setApp={setApp} doc={doc} update={update} flush={flush} locked={locked("rep")} checks={shown("rep", 1)} footer={footer()} />}
            {step === 2 && <RosterStep token={token} app={app} doc={doc} update={update} locked={locked("roster")} canLogo={!locked("team") && !doc.team.crest_url} color={color} checks={doc.players.length || doc.staff.length ? bySection("roster") : shown("roster", 2)} footer={footer()} />}
            {step === 3 && <ReviewStep app={app} setApp={setApp} doc={doc} update={update} flush={flush} go={go} onDone={onDone} footer={footer} />}
          </div>
          {step !== 2 && <Aside step={step} app={app} />}
        </div>
      </div>
    </Page>
  );
}

/* ---------- shared bits ---------- */
function FormCard({ n, title, sub, children, footer, locked }: { n: number; title: string; sub?: string; children: ReactNode; footer: ReactNode; locked?: boolean }) {
  return (
    <div className="card">
      <div className="form-head">
        <div className="over">{n}-qadam / 4</div>
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      <div className="form-body">
        {locked && <div className="note"><I.lock size={16} /><div>Bu bo‘lim qulflangan — admin faqat izoh qoldirilgan bo‘limlarni tuzatishga ochgan.</div></div>}
        {children}
      </div>
      {footer}
    </div>
  );
}

const errFor = (checks: Check[], code: string) => checks.find((c) => c.code === code && c.level === "error")?.text;

function ChangesBanner({ app }: { app: Application }) {
  const names: Record<string, string> = { team: "Jamoa", rep: "Vakil", roster: "Tarkib" };
  return (
    <div className="card">
      <div className="card-head" style={{ background: "var(--warn-subtle)" }}>
        <h3 className="row"><I.alert size={18} /> Admin tuzatish so‘radi</h3>
        {app.changes_deadline && <span className="small warn-text"><b>Muddat: {fmtDeadline(app.changes_deadline)}</b></span>}
      </div>
      {app.comments.map((c, i) => (
        <div key={i} className="comment">
          <div className="grow"><div className="over-label">{names[c.section] || c.section}</div><div style={{ marginTop: 4 }}>{c.text}</div></div>
        </div>
      ))}
    </div>
  );
}

function Aside({ step, app }: { step: number; app: Application }) {
  const r = app.link?.requirements;
  const items = step === 1
    ? ["Liga ariza holati va o‘yinlar jadvali bo‘yicha shu odam bilan bog‘lanadi", "Raqam saytda ko‘rinmaydi — faqat liga ma’muriyati uchun", ...(app.otp_required ? ["Raqam SMS-kod bilan tasdiqlanadi"] : [])]
    : step === 3
      ? ["Ariza yuboriladi va raqam beriladi", "Liga ma’muriyati arizani ko‘rib chiqadi", "Tasdiqlansa — jamoa saytda paydo bo‘ladi; tuzatish kerak bo‘lsa — izoh shu sahifada chiqadi"]
      : [
        r ? `${r.min_players} dan ${r.max_players} gacha kishi` : "",
        "Har bir o‘yinchi: ism, familiya, tug‘ilgan sana, raqam",
        r?.logo ? "Logotip PNG yoki JPG, kamida 512×512" : "",
        "Bitta o‘yinchi faqat bitta jamoada o‘ynaydi",
      ].filter(Boolean);
  const title = step === 1 ? "Nega telefon kerak?" : step === 3 ? "Keyin nima bo‘ladi?" : "Talablar";
  return (
    <div className="stack aside">
      <div className="card">
        <div className="card-head"><h3>{title}</h3></div>
        <div className="card-pad stack" style={{ gap: 12 }}>{items.map((t) => <CheckLine key={t} level="ok"><span className="sec">{t}</span></CheckLine>)}</div>
      </div>
      <div className="card"><div className="card-pad stack" style={{ gap: 10 }}>
        <b style={{ fontSize: 16 }}>Savol bormi?</b>
        <span className="sec">Liga menejeriga Telegram orqali yozing.</span>
        <a className="btn" href={HELP_URL} target="_blank" rel="noopener noreferrer"><I.telegram size={16} /> Menejerga yozish</a>
      </div></div>
    </div>
  );
}

function SizesCard({ players, staff }: { players: Player[]; staff: Staff[] }) {
  const list = sizeSummary([...players, ...staff]);
  const total = list.reduce((s, x) => s + x.n, 0);
  const maxN = Math.max(1, ...list.map((x) => x.n));
  return (
    <div className="card sizes-card">
      <div className="card-head"><h3 style={{ fontSize: 16 }}>Forma o‘lchamlari</h3><span className="small sec"><b>{total} komplekt</b></span></div>
      <div className="card-pad stack" style={{ gap: 8 }}>
        {list.length ? list.map((x) => (
          <div key={x.size} className="row" style={{ gap: 10 }}><b style={{ width: 36 }} className="small">{x.size}</b><span className="bar"><i style={{ width: `${(x.n / maxN) * 100}%` }} /></span><b className="small tnum sec">{x.n}</b></div>
        )) : <span className="small muted">O‘lchamlar hali kiritilmagan</span>}
        <span className="small sec" style={{ marginTop: 4 }}>O‘yinchilar, media shaxslar va murabbiylar — liga formani shu ro‘yxat bo‘yicha buyurtma qiladi.</span>
      </div>
    </div>
  );
}

/* ---------- step 1: team ---------- */
function TeamStep({ token, doc, update, locked, checks, footer }: { token: string; doc: Doc; update: (fn: (d: Doc) => Doc) => void; locked: boolean; checks: Check[]; footer: ReactNode }) {
  const toast = useToast();
  const t = doc.team;
  const set = <K extends keyof Doc["team"]>(k: K, v: Doc["team"][K]) => update((d) => ({ ...d, team: { ...d.team, [k]: v } }));
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  async function pickLogo(f?: File) {
    if (!f || locked) return;
    setBusy(true);
    try {
      const r = await api.uploadImage(token, "logo", f);
      update((d) => ({ ...d, team: { ...d.team, crest_url: r.url, crest_w: r.width, crest_h: r.height } }));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Yuklashda xato", "error");
    } finally {
      setBusy(false);
    }
  }
  const logoWarn = checks.find((c) => c.code === "team.crest_url");
  return (
    <FormCard n={1} title="Jamoa ma’lumotlari" sub="Bu ma’lumotlar saytdagi jamoa sahifasida, jadvalda va match kartochkalarida ko‘rinadi." footer={footer} locked={locked}>
      <div className="g-code">
        <Field label="Jamoa nomi" error={errFor(checks, "team.name")} hint={checks.find((c) => c.code === "team.name" && c.level === "warn")?.text || "Saytda shunday ko‘rinadi"}>
          <input className="input" value={t.name} onChange={(e) => set("name", e.target.value)} maxLength={80} disabled={locked} aria-invalid={!!errFor(checks, "team.name")} />
        </Field>
        <Field label="Qisqa kod" opt="ixtiyoriy" error={errFor(checks, "team.short_name")} hint="2–4 lotin harfi">
          <input className="input" value={t.short_name} onChange={(e) => set("short_name", e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4))} disabled={locked} aria-invalid={!!errFor(checks, "team.short_name")} />
        </Field>
      </div>
      <div className="field">
        <span className="lbl">Logotip{!errFor(checks, "team.crest_url") && !t.crest_url && <span className="opt">ixtiyoriy</span>}</span>
        <div className="logo-row">
          <div className="logo-prev">{t.crest_url ? <img src={t.crest_url} alt="" /> : t.short_name || "?"}</div>
          <div className={`drop${over ? " over" : ""}`} role="button" tabIndex={0} aria-disabled={locked}
            onClick={() => !locked && ref.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && !locked && ref.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); pickLogo(e.dataTransfer.files?.[0]); }}>
            {busy ? <Spinner /> : <I.upload size={22} />}
            <b>{t.crest_url ? "Boshqa fayl tanlash" : "Faylni shu yerga tashlang yoki tanlang"}</b>
            <span className="small sec">PNG yoki JPG · kamida 512×512 · shaffof fon</span>
          </div>
          <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { pickLogo(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        {logoWarn && <span className={logoWarn.level === "error" ? "err" : "hint warn-text"}>{logoWarn.text}</span>}
      </div>
      <Field label="Shahar / tuman" opt="ixtiyoriy"><input className="input" value={t.city} onChange={(e) => set("city", e.target.value)} maxLength={80} placeholder="Toshkent sh., Chilonzor tumani" disabled={locked} /></Field>
      <Field label="Jamoa haqida" opt="ixtiyoriy" hint={`${t.about.length} / 500`}>
        <textarea className="textarea" value={t.about} onChange={(e) => set("about", e.target.value)} maxLength={500} disabled={locked} />
      </Field>
      <Field label="Instagram" error={errFor(checks, "team.instagram")} hint="Jamoa sahifasida havola sifatida chiqadi"><input className="input" value={t.instagram} onChange={(e) => set("instagram", e.target.value)} maxLength={100} placeholder="@jamoa" disabled={locked} aria-invalid={!!errFor(checks, "team.instagram")} /></Field>
    </FormCard>
  );
}

/* ---------- step 2: representative ---------- */
function RepStep({ app, setApp, doc, update, flush, locked, checks, footer }: {
  app: Application; setApp: (a: Application) => void; doc: Doc; update: (fn: (d: Doc) => Doc) => void; flush: (adopt?: boolean) => Promise<void>;
  locked: boolean; checks: Check[]; footer: ReactNode;
}) {
  const toast = useToast();
  const r = doc.rep;
  const set = <K extends keyof Doc["rep"]>(k: K, v: Doc["rep"][K]) => update((d) => ({ ...d, rep: { ...d.rep, [k]: v } }));
  const [sent, setSent] = useState<{ to: string; dev?: string } | null>(null);
  const [wait, setWait] = useState(0);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [codeErr, setCodeErr] = useState("");
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function send() {
    setBusy(true);
    setCodeErr("");
    try {
      await flush();
      const res = await api.sendCode(app.token, r.phone);
      setSent({ to: res.sent_to, dev: res.dev_code });
      setWait(res.retry_after);
      setCode("");
    } catch (e) {
      if (e instanceof ApiError && e.body?.retry_after) setWait(e.body.retry_after);
      toast(e instanceof Error ? e.message : "SMS yuborilmadi", "error");
    } finally {
      setBusy(false);
    }
  }
  async function verify(c: string) {
    setBusy(true);
    try {
      const res = await api.verifyCode(app.token, c);
      setApp(res);
      setSent(null);
      toast("Telefon raqami tasdiqlandi");
    } catch (e) {
      setCodeErr(e instanceof ApiError ? e.fields.code || e.message : "Xato");
      setCode("");
    } finally {
      setBusy(false);
    }
  }
  const phoneErr = errFor(checks, "rep.phone");
  return (
    <FormCard n={2} title="Jamoa vakili" sub="Liga shu odam bilan bog‘lanadi: ariza holati, match jadvali, protokollar." footer={footer} locked={locked}>
      <div className="g2">
        <Field label="Ism va familiya" error={errFor(checks, "rep.name")}><input className="input" value={r.name} onChange={(e) => set("name", e.target.value)} maxLength={120} disabled={locked} autoComplete="name" /></Field>
        <Field label="Jamoadagi roli"><select className="select" value={r.role || "captain"} onChange={(e) => set("role", e.target.value)} disabled={locked}>{Object.entries(REP_ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      </div>
      <div className="field">
        <label htmlFor="phone">Telefon raqami</label>
        <div className="row end">
          <input id="phone" className="input grow" type="tel" inputMode="tel" autoComplete="tel" value={r.phone} placeholder="+998 90 123 45 67" disabled={locked}
            onChange={(e) => set("phone", e.target.value)} aria-invalid={!!phoneErr && !app.otp_required} />
          {app.otp_required && !app.phone_verified && !locked && (
            <button type="button" className="btn btn-dark" onClick={send} disabled={busy || wait > 0 || r.phone.replace(/\D/g, "").length < 9}>{wait > 0 ? `Qayta yuborish ${wait}s` : sent ? "Qayta yuborish" : "Kod yuborish"}</button>
          )}
        </div>
        {app.phone_verified ? <span className="verified"><I.check size={14} /> Tasdiqlangan — raqamni o‘zgartirsangiz, qayta tasdiqlanadi</span>
          : phoneErr ? <span className={app.otp_required && r.phone ? "hint" : "err"}>{phoneErr}</span> : null}
      </div>
      {sent && !app.phone_verified && (
        <div className="box sub">
          <b className="small">SMS-kodni kiriting</b>
          <OtpInput value={code} onChange={(v) => { setCode(v); setCodeErr(""); if (v.length === 6) verify(v); }} disabled={busy} />
          <span className="small sec row" style={{ gap: 6 }}><I.clock size={14} /> Kod {sent.to} raqamiga yuborildi</span>
          {sent.dev && <span className="small warn-text">Sinov rejimi: SMS yuborilmaydi, kod — <b>{sent.dev}</b></span>}
          {codeErr && <span className="err">{codeErr}</span>}
        </div>
      )}
      <Field label="Telegram" error={errFor(checks, "rep.telegram")} hint="Liga savollari shu yerga keladi"><input className="input" value={r.telegram} onChange={(e) => set("telegram", e.target.value)} maxLength={64} placeholder="@username" disabled={locked} aria-invalid={!!errFor(checks, "rep.telegram")} /></Field>
      <Field label="Email" opt="ixtiyoriy" error={errFor(checks, "rep.email")}><input className="input" type="email" value={r.email} onChange={(e) => set("email", e.target.value)} maxLength={120} disabled={locked} autoComplete="email" /></Field>
      <label className="check"><input type="checkbox" checked={r.authorized} onChange={(e) => set("authorized", e.target.checked)} disabled={locked} /><span>Men jamoa nomidan ariza berishga vakolatliman</span></label>
    </FormCard>
  );
}

function OtpInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => refs.current[Math.min(value.length, 5)]?.focus(), [value.length]);
  return (
    <div className="otp" onPaste={(e) => { const d = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6); if (d) { e.preventDefault(); onChange(d); } }}>
      {Array.from({ length: 6 }, (_, i) => (
        <input key={i} ref={(el) => { refs.current[i] = el; }} inputMode="numeric" autoComplete={i === 0 ? "one-time-code" : "off"} maxLength={1} aria-label={`${i + 1}-raqam`}
          value={value[i] || ""} disabled={disabled}
          onChange={(e) => { const d = e.target.value.replace(/\D/g, "").slice(-1); if (!d) return; onChange((value.slice(0, i) + d).slice(0, 6)); }}
          onKeyDown={(e) => { if (e.key === "Backspace") { e.preventDefault(); onChange(value.slice(0, Math.max(0, value.length - 1))); } }} />
      ))}
    </div>
  );
}

/* ---------- step 3: roster ---------- */
function RosterStep({ token, app, doc, update, locked, canLogo, color, checks, footer }: {
  token: string; app: Application; doc: Doc; update: (fn: (d: Doc) => Doc) => void; locked: boolean; canLogo: boolean; color: string; checks: Check[]; footer: ReactNode;
}) {
  const toast = useToast();
  const [edit, setEdit] = useState<{ i: number; p: Player } | null>(null);
  const [editStaff, setEditStaff] = useState<{ i: number; s: Staff } | null>(null);
  const [imp, setImp] = useState<{ file: string; r: ImportResult } | null>(null);
  const players = doc.players.map((p, i) => ({ p, i }));
  const field = players.filter((x) => x.p.role !== "media");
  const media = players.filter((x) => x.p.role === "media");
  const flags = rowFlags(checks);
  const notes = useMemo(() => {
    const m: Record<number, { text: string; level: string }> = {};
    for (const c of checks) if (c.index != null && !c.staff && (!m[c.index] || c.level === "error")) m[c.index] = { text: c.text.replace(/^[^:]+: /, ""), level: c.level };
    return m;
  }, [checks]);
  const general = checks.filter((c) => c.index == null);
  const rowErrors = checks.filter((c) => c.index != null).length;
  const r = app.link?.requirements;

  function savePlayer(p: Player, more: boolean) {
    const i = edit?.i ?? -1;
    update((d) => ({ ...d, players: i >= 0 ? d.players.map((x, j) => (j === i ? p : x)) : [...d.players, p] }));
    if (!more) setEdit(null);
    else setEdit({ i: -1, p: emptyPlayer(p.role === "goalkeeper" ? "player" : p.role) });
  }
  function del(i: number) {
    if (!window.confirm(`${fullName(doc.players[i]) || "O‘yinchi"} o‘chirilsinmi?`)) return;
    update((d) => ({ ...d, players: d.players.filter((_, j) => j !== i) }));
  }
  function swap(i: number) {
    update((d) => ({ ...d, players: d.players.map((p, j) => (j === i ? { ...p, first_name: p.last_name, last_name: p.first_name } : p)) }));
  }
  function applyImport(mode: "replace" | "append", useLogo: boolean) {
    if (!imp) return;
    const r2 = imp.r;
    update((d) => ({
      ...d,
      team: useLogo && r2.logo ? { ...d.team, crest_url: r2.logo.url, crest_w: r2.logo.width, crest_h: r2.logo.height } : d.team,
      players: mode === "replace" ? r2.import.players : [...d.players, ...r2.import.players],
      staff: mode === "replace" ? (r2.import.staff.length ? r2.import.staff : d.staff) : [...d.staff, ...r2.import.staff],
    }));
    toast(`${r2.import.players.length + r2.import.staff.length} kishi qo‘shildi`);
    setImp(null);
  }
  const taken = (i: number) => doc.players.filter((_, j) => j !== i).map((p) => p.number).filter((n): n is string => n != null);
  const swaps = checks.filter((c) => c.code === "player.swapped" && c.index != null);

  return (
    <FormCard n={3} title="Tarkib" sub="O‘yinchilar, media shaxslar va murabbiy. Futbolkadagi yozuv va o‘lcham forma tayyorlash uchun kerak." footer={footer} locked={locked}>
      <div className="row wrapx" style={{ justifyContent: "space-between" }}>
        <div>
          <b style={{ fontSize: 18 }}>{doc.players.length + doc.staff.length}{r ? ` / ${r.max_players}` : ""} kishi</b>
          <div className="small sec">{field.length} o‘yinchi · {media.length} media shaxs · {doc.staff.length} murabbiy{r ? ` · kamida ${r.min_players} kishi` : ""}</div>
        </div>
        <div className="row">
          <a className="btn btn-ghost" href={api.templateUrl}><I.download size={16} /> Shablon (.xlsx)</a>
          {!locked && <ImportButton token={token} onResult={(file, r2) => setImp({ file, r: r2 })} />}
        </div>
      </div>
      {(general.length > 0 || rowErrors > 0) && (
        <div className={`box ${checks.some((c) => c.level === "error") ? "err" : "warn"}`}>
          {general.map((c) => <CheckLine key={c.code + c.text} level={c.level}>{c.text}</CheckLine>)}
          {rowErrors > 0 && <CheckLine level={checks.some((c) => c.index != null && c.level === "error") ? "error" : "warn"}>Qatorlarda {rowErrors} ta izoh — quyida belgilangan</CheckLine>}
          {!locked && swaps.map((c) => (
            <div key={c.index} className="row" style={{ gap: 8, paddingLeft: 26 }}>
              <span className="small grow">{c.text}</span>
              <button type="button" className="btn btn-sm" onClick={() => swap(c.index!)}><I.swap size={14} /> Almashtirish</button>
            </div>
          ))}
        </div>
      )}
      {!doc.players.length && !doc.staff.length && (
        <div className="box sub" style={{ alignItems: "center", textAlign: "center", padding: 32 }}>
          <b>Tarkib hali bo‘sh</b>
          <span className="small sec">TARKIB.xlsx faylini yuklang yoki o‘yinchilarni birma-bir qo‘shing.</span>
        </div>
      )}
      <RosterSection title="O‘yinchilar" count={`${field.length}`} add={locked ? undefined : () => setEdit({ i: -1, p: emptyPlayer() })} addLabel="O‘yinchi qo‘shish">
        <PlayersTable token={token} rows={field} flags={flags} notes={notes} locked={locked} onEdit={(i) => setEdit({ i, p: doc.players[i] })} onDelete={del} />
      </RosterSection>
      <RosterSection title="Media shaxslar" count={`${media.length}`} add={locked ? undefined : () => setEdit({ i: -1, p: emptyPlayer("media") })} addLabel="Media shaxs qo‘shish">
        <PlayersTable token={token} rows={media} flags={flags} notes={notes} locked={locked} onEdit={(i) => setEdit({ i, p: doc.players[i] })} onDelete={del} />
      </RosterSection>
      <RosterSection title="Murabbiylar shtabi" count={`${doc.staff.length}`} add={locked ? undefined : () => setEditStaff({ i: -1, s: { first_name: "", last_name: "", birth_date: "", kit_size: "", role: doc.staff.length ? "assistant" : "head_coach", phone: "" } })} addLabel="Murabbiy qo‘shish">
        <StaffTable rows={doc.staff} flags={rowFlags(checks, true)} locked={locked} onEdit={(i) => setEditStaff({ i, s: doc.staff[i] })}
          onDelete={(i) => window.confirm("O‘chirilsinmi?") && update((d) => ({ ...d, staff: d.staff.filter((_, j) => j !== i) }))} />
      </RosterSection>
      {edit && <PlayerModal key={edit.i + ":" + doc.players.length} token={token} initial={edit.p} color={color} taken={taken(edit.i)} onSave={savePlayer} onClose={() => setEdit(null)} />}
      {editStaff && <StaffModal initial={editStaff.s} onClose={() => setEditStaff(null)}
        onSave={(s) => { update((d) => ({ ...d, staff: editStaff.i >= 0 ? d.staff.map((x, j) => (j === editStaff.i ? s : x)) : [...d.staff, s] })); setEditStaff(null); }} />}
      {imp && <ImportModal file={imp.file} result={imp.r} hasRoster={doc.players.length + doc.staff.length > 0} canLogo={canLogo} onApply={applyImport} onClose={() => setImp(null)} />}
    </FormCard>
  );
}

function RosterSection({ title, count, add, addLabel, children }: { title: string; count: string; add?: () => void; addLabel: string; children: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="sec-head"><h4>{title}</h4><span className="small muted">{count}</span><div className="grow" />{add && <button type="button" className="link-btn" onClick={add}><I.plus size={16} /> {addLabel}</button>}</div>
      {children}
    </div>
  );
}

/* ---------- step 4: review ---------- */
export function Summary({ doc, onEdit }: { doc: Doc; onEdit?: (step: number) => void }) {
  const t = doc.team;
  const block = (title: string, step: number, body: ReactNode) => (
    <div className="sum">
      <div className="sum-head"><span className="grow">{title}</span>{onEdit && <button type="button" className="link-btn sec" onClick={() => onEdit(step)}><I.edit size={14} /> Tahrirlash</button>}</div>
      {body}
    </div>
  );
  const sizes = sizeSummary([...doc.players, ...doc.staff]).map((x) => `${x.size} ${x.n}`).join(" · ");
  const gks = doc.players.filter((p) => p.role === "goalkeeper").map(fullName).join(", ");
  const media = doc.players.filter((p) => p.role === "media").map(fullName).join(", ");
  const med = doc.players.filter((p) => p.medical).length;
  return (
    <>
      {block("Jamoa", 0, <>
        <div className="row" style={{ padding: 16, gap: 14 }}>
          <div className="logo-prev" style={{ width: 56, height: 56, fontSize: 14 }}>{t.crest_url ? <img src={t.crest_url} alt="" /> : t.short_name || "?"}</div>
          <div className="grow"><b style={{ fontSize: 18 }}>{t.name || "Nomsiz"}</b><div className="small sec">{[t.short_name, t.city].filter(Boolean).join(" · ")}</div></div>
        </div>
        {t.instagram && <div className="kv"><span>Instagram</span><span>{t.instagram}</span></div>}
      </>)}
      {block("Vakil", 1, <>
        <div className="kv"><span>Ism</span><span>{doc.rep.name || "—"} · {REP_ROLES[doc.rep.role] || ""}</span></div>
        <div className="kv"><span>Telefon</span><span>{doc.rep.phone || "—"}</span></div>
        {doc.rep.telegram && <div className="kv"><span>Telegram</span><span>{doc.rep.telegram}</span></div>}
        {doc.rep.email && <div className="kv"><span>Email</span><span>{doc.rep.email}</span></div>}
      </>)}
      {block(`Tarkib · ${doc.players.filter((p) => p.role !== "media").length} o‘yinchi, ${doc.players.filter((p) => p.role === "media").length} media, ${doc.staff.length} murabbiy`, 2, <>
        <div className="pchips">{doc.players.map((p, i) => <span key={i} className="pchip"><i>{p.number ?? "—"}</i>{fullName(p)}</span>)}</div>
        {gks && <div className="kv"><span>Darvozabonlar</span><span>{gks}</span></div>}
        {media && <div className="kv"><span>Media shaxslar</span><span>{media}</span></div>}
        {doc.staff.map((s, i) => <div key={i} className="kv"><span>{STAFF_ROLES[s.role] || "Murabbiy"}</span><span>{fullName(s)}{s.birth_date ? ` · ${fmtBirth(s.birth_date)}` : ""}</span></div>)}
        {sizes && <div className="kv"><span>Forma o‘lchamlari</span><span>{sizes}</span></div>}
        <div className="kv"><span>Tibbiy ruxsatnoma</span><span>{med} / {doc.players.length}</span></div>
      </>)}
    </>
  );
}

function ReviewStep({ app, setApp, doc, update, flush, go, onDone, footer }: {
  app: Application; setApp: (a: Application) => void; doc: Doc; update: (fn: (d: Doc) => Doc) => void; flush: (adopt?: boolean) => Promise<void>;
  go: (i: number) => void; onDone: (a: Application) => void; footer: (next?: ReactNode) => ReactNode;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const c = doc.consents;
  const set = (k: keyof Doc["consents"], v: boolean) => update((d) => ({ ...d, consents: { ...d.consents, [k]: v } }));
  const errors = app.checks.filter((x) => x.level === "error" && x.section !== "submit");
  const warns = app.checks.filter((x) => x.level === "warn");
  const sections: Record<string, number> = { team: 0, rep: 1, roster: 2 };
  async function submit() {
    setBusy(true);
    try {
      await flush(true);
      const res = await api.submit(app.token);
      toast("Ariza yuborildi");
      onDone(res);
    } catch (e) {
      if (e instanceof ApiError && e.body?.checks) setApp({ ...app, checks: e.body.checks });
      toast(e instanceof Error ? e.message : "Yuborilmadi", "error");
    } finally {
      setBusy(false);
    }
  }
  const rules = app.link?.rules_url;
  return (
    <FormCard n={4} title="Tekshirish va yuborish" sub="Ma’lumotlarni tekshiring. Yuborilgandan keyin ariza ko‘rib chiqilguncha tahrirlab bo‘lmaydi."
      footer={footer(<button type="button" className="btn btn-primary" onClick={submit} disabled={busy || errors.length > 0 || !(c.rules && c.players && c.personal)}>{busy ? <Spinner /> : app.status === "changes" ? "Qayta yuborish" : "Arizani yuborish"}</button>)}>
      {errors.length > 0 && (
        <div className="box err">
          <b>Yuborishdan oldin tuzating ({errors.length})</b>
          {errors.slice(0, 8).map((x, i) => (
            <div key={i} className="row" style={{ gap: 8 }}>
              <div className="grow"><CheckLine level="error">{x.text}</CheckLine></div>
              {x.section in sections && <button type="button" className="btn btn-sm" onClick={() => go(sections[x.section])}>Tuzatish</button>}
            </div>
          ))}
          {errors.length > 8 && <span className="small">va yana {errors.length - 8} ta</span>}
        </div>
      )}
      {warns.length > 0 && errors.length === 0 && (
        <div className="box warn">{warns.map((x, i) => <CheckLine key={i} level="warn">{x.text}</CheckLine>)}<span className="small sec">Ogohlantirishlar yuborishga to‘sqinlik qilmaydi — admin ko‘rib chiqadi.</span></div>
      )}
      <Summary doc={doc} onEdit={go} />
      <div className="stack" style={{ gap: 12 }}>
        <label className="check"><input type="checkbox" checked={c.rules} onChange={(e) => set("rules", e.target.checked)} /><span>{rules ? <><a href={rules} target="_blank" rel="noopener noreferrer">Liga reglamenti</a> bilan tanishdim va unga roziman</> : "Liga reglamenti bilan tanishdim va unga roziman"}</span></label>
        <label className="check"><input type="checkbox" checked={c.players} onChange={(e) => set("players", e.target.checked)} /><span>O‘yinchilar va murabbiylar o‘z ma’lumotlarini yuborishga rozi</span></label>
        <label className="check"><input type="checkbox" checked={c.personal} onChange={(e) => set("personal", e.target.checked)} /><span>Shaxsiy ma’lumotlarni qayta ishlashga roziman</span></label>
      </div>
    </FormCard>
  );
}
