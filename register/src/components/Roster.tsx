import { useRef, useState } from "react";
import { api, type Check, type ImportResult, type Player, type Role, type Staff } from "@/lib/api";
import { KIT_SIZES, ROLE_LABEL, STAFF_ROLES, emptyPlayer, fmtBirth, fullName, initials } from "@/lib/format";
import { CheckLine, Field, Modal, Spinner, useToast } from "./ui";
import { I } from "./Icons";

/* ---------- jersey preview ---------- */
function isLight(hex: string) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return false;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}
export function Jersey({ color, name, number }: { color: string; name: string; number: number | null }) {
  const c = color || "#1D4ED8";
  return (
    <div className={`jersey${isLight(c) ? " light" : ""}`} aria-label="Futbolka orqa tomoni">
      <svg width="168" height="176" viewBox="0 0 168 176" aria-hidden><path d="M44 6 L66 0 Q84 14 102 0 L124 6 L164 38 L142 70 L126 60 L126 172 Q126 176 122 176 L46 176 Q42 176 42 172 L42 60 L26 70 L4 38 Z" fill={c} stroke="rgba(0,0,0,.12)" /></svg>
      <div className="jn">{name || "FAMILIYA"}</div>
      <div className="jnum">{number ?? "00"}</div>
    </div>
  );
}

/* ---------- player modal ---------- */
export function PlayerModal({ token, initial, color, taken, onSave, onClose }: {
  token: string; initial: Player; color: string; taken: number[]; onSave: (p: Player, more: boolean) => void; onClose: () => void;
}) {
  const toast = useToast();
  const [p, setP] = useState<Player>(initial);
  const [jerseyTouched, setJerseyTouched] = useState(!!initial.jersey_name);
  const [busy, setBusy] = useState<"" | "photo" | "medical">("");
  const [tried, setTried] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);
  const medRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Player>(k: K, v: Player[K]) => setP((x) => ({ ...x, [k]: v }));

  function setLast(v: string) {
    setP((x) => ({ ...x, last_name: v, jersey_name: jerseyTouched ? x.jersey_name : v.toUpperCase().slice(0, 12) }));
  }
  const errs: Record<string, string> = {};
  if (!p.first_name.trim()) errs.first_name = "Ismni yozing";
  if (!p.last_name.trim()) errs.last_name = "Familiyani yozing";
  if (!p.birth_date) errs.birth_date = "Sanani kiriting";
  if (p.number == null) errs.number = "Raqam";
  else if (taken.includes(p.number)) errs.number = "Band";
  if (!p.jersey_name.trim()) errs.jersey_name = "Futbolkadagi yozuvni kiriting";
  if (!p.kit_size) errs.kit_size = "O‘lchamni tanlang";
  const ok = Object.keys(errs).length === 0;

  async function pickPhoto(f?: File) {
    if (!f) return;
    setBusy("photo");
    try {
      set("photo_url", (await api.uploadImage(token, "photo", f)).url);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Yuklashda xato", "error");
    } finally {
      setBusy("");
    }
  }
  async function pickMedical(f?: File) {
    if (!f) return;
    setBusy("medical");
    try {
      set("medical", await api.uploadMedical(token, f));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Yuklashda xato", "error");
    } finally {
      setBusy("");
    }
  }
  function save(more: boolean) {
    setTried(true);
    if (!ok) return;
    onSave({ ...p, jersey_name: p.jersey_name.toUpperCase().trim() }, more);
    if (more) {
      setP(emptyPlayer(p.role === "goalkeeper" ? "player" : p.role));
      setJerseyTouched(false);
      setTried(false);
    }
  }
  const e = (k: string) => (tried ? errs[k] : undefined);
  const isNew = !initial.first_name && !initial.last_name;

  return (
    <Modal title={isNew ? (p.role === "media" ? "Media shaxs qo‘shish" : "O‘yinchi qo‘shish") : fullName(initial)} onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Bekor qilish</button>
        {isNew && <button type="button" className="btn" onClick={() => save(true)} disabled={!!busy}>Saqlash va yana qo‘shish</button>}
        <button type="button" className="btn btn-primary" onClick={() => save(false)} disabled={!!busy}>Saqlash</button>
      </>}>
      <div className="row top" style={{ gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="stack grow" style={{ minWidth: 280 }}>
          <div className="g2">
            <Field label="Ism" error={e("first_name")}><input className="input" value={p.first_name} onChange={(ev) => set("first_name", ev.target.value)} autoFocus aria-invalid={!!e("first_name")} /></Field>
            <Field label="Familiya" error={e("last_name")}><input className="input" value={p.last_name} onChange={(ev) => setLast(ev.target.value)} aria-invalid={!!e("last_name")} /></Field>
          </div>
          <div className="g-code">
            <Field label="Tug‘ilgan sana" error={e("birth_date")}><input className="input" type="date" value={p.birth_date} max={new Date().toISOString().slice(0, 10)} onChange={(ev) => set("birth_date", ev.target.value)} aria-invalid={!!e("birth_date")} /></Field>
            <Field label="Raqam" error={e("number")}><input className="input" inputMode="numeric" value={p.number ?? ""} onChange={(ev) => { const d = ev.target.value.replace(/\D/g, "").slice(0, 3); set("number", d === "" ? null : Number(d)); }} aria-invalid={!!e("number")} /></Field>
          </div>
          <Field label="Futbolkada yozilishi" error={e("jersey_name")} hint={`Lotin bosma harflar, 12 belgigacha · ${p.jersey_name.length}/12`}>
            <input className="input" value={p.jersey_name} maxLength={15} onChange={(ev) => { setJerseyTouched(true); set("jersey_name", ev.target.value.toUpperCase()); }} aria-invalid={!!e("jersey_name")} />
          </Field>
          <div className="field">
            <span className="lbl">Roli</span>
            <div className="seg" role="radiogroup">
              {(["player", "goalkeeper", "media"] as Role[]).map((r) => <button type="button" key={r} className={p.role === r ? "on" : ""} onClick={() => set("role", r)} aria-pressed={p.role === r}>{r === "player" ? "Maydon o‘yinchisi" : ROLE_LABEL[r]}</button>)}
            </div>
          </div>
          <div className="field">
            <span className="lbl">Forma o‘lchami</span>
            <div className="sizes">{KIT_SIZES.map((s) => <button type="button" key={s} className={p.kit_size === s ? "on" : ""} onClick={() => set("kit_size", s)}>{s}</button>)}</div>
            {e("kit_size") && <span className="err">{e("kit_size")}</span>}
          </div>
          <Field label="Ish joyi / faoliyati" opt="ixtiyoriy"><input className="input" value={p.workplace} onChange={(ev) => set("workplace", ev.target.value)} /></Field>
          <div className="g2">
            <div className="field">
              <span className="lbl">Foto <span className="opt">ixtiyoriy</span></span>
              <div className={`file-row${p.photo_url ? " has" : ""}`} onClick={() => photoRef.current?.click()} role="button" tabIndex={0}>
                {p.photo_url ? <span className="avatar"><img src={p.photo_url} alt="" /></span> : <I.camera size={18} />}
                <div className="grow"><b className="small">{busy === "photo" ? "Yuklanmoqda…" : p.photo_url ? "Almashtirish" : "Yuklash"}</b><div className="small muted">Kvadrat, kamida 600×600</div></div>
                {p.photo_url && <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Fotoni olib tashlash" onClick={(ev) => { ev.stopPropagation(); set("photo_url", ""); }}><I.x size={14} /></button>}
              </div>
              <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(ev) => { pickPhoto(ev.target.files?.[0]); ev.target.value = ""; }} />
            </div>
            <div className="field">
              <span className="lbl">Tibbiy ruxsatnoma</span>
              <div className={`file-row${p.medical ? " has" : ""}`} onClick={() => medRef.current?.click()} role="button" tabIndex={0}>
                <I.doc size={18} />
                <div className="grow" style={{ minWidth: 0 }}><b className="small ellipsis" style={{ display: "block" }}>{busy === "medical" ? "Yuklanmoqda…" : p.medical ? p.medical.name || "Yuklangan" : "Yuklash"}</b><div className="small muted">PDF yoki rasm · birinchi matchgacha</div></div>
                {p.medical && <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Faylni olib tashlash" onClick={(ev) => { ev.stopPropagation(); set("medical", null); }}><I.x size={14} /></button>}
              </div>
              <input ref={medRef} type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(ev) => { pickMedical(ev.target.files?.[0]); ev.target.value = ""; }} />
            </div>
          </div>
        </div>
        <div className="stack" style={{ width: 200, gap: 10, margin: "0 auto" }}>
          <span className="over-label" style={{ textAlign: "center" }}>Futbolka — orqa tomoni</span>
          <div style={{ background: "var(--subtle)", borderRadius: 6, padding: "20px 0" }}><Jersey color={color} name={p.jersey_name} number={p.number} /></div>
          <span className="small muted" style={{ textAlign: "center" }}>Jamoaning asosiy forma rangi bilan</span>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- staff modal ---------- */
export function StaffModal({ initial, onSave, onClose }: { initial: Staff; onSave: (s: Staff) => void; onClose: () => void }) {
  const [s, setS] = useState<Staff>(initial);
  const [tried, setTried] = useState(false);
  const set = <K extends keyof Staff>(k: K, v: Staff[K]) => setS((x) => ({ ...x, [k]: v }));
  const ok = s.first_name.trim() && s.last_name.trim();
  return (
    <Modal small title={initial.first_name ? fullName(initial) : "Murabbiy qo‘shish"} onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Bekor qilish</button>
        <button type="button" className="btn btn-primary" onClick={() => { setTried(true); if (ok) onSave(s); }}>Saqlash</button>
      </>}>
      <div className="g2">
        <Field label="Ism" error={tried && !s.first_name.trim() ? "Ismni yozing" : undefined}><input className="input" value={s.first_name} onChange={(e) => set("first_name", e.target.value)} autoFocus /></Field>
        <Field label="Familiya" error={tried && !s.last_name.trim() ? "Familiyani yozing" : undefined}><input className="input" value={s.last_name} onChange={(e) => set("last_name", e.target.value)} /></Field>
      </div>
      <div className="g2">
        <Field label="Lavozimi"><select className="select" value={s.role} onChange={(e) => set("role", e.target.value)}>{Object.entries(STAFF_ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Tug‘ilgan sana" opt="ixtiyoriy"><input className="input" type="date" value={s.birth_date} onChange={(e) => set("birth_date", e.target.value)} /></Field>
      </div>
      <div className="field">
        <span className="lbl">Forma o‘lchami <span className="opt">ixtiyoriy</span></span>
        <div className="sizes">{KIT_SIZES.map((x) => <button type="button" key={x} className={s.kit_size === x ? "on" : ""} onClick={() => set("kit_size", s.kit_size === x ? "" : x)}>{x}</button>)}</div>
      </div>
      <Field label="Telefon" opt="ixtiyoriy"><input className="input" type="tel" value={s.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+998" /></Field>
    </Modal>
  );
}

/* ---------- import ---------- */
export function ImportModal({ file, result, hasRoster, canLogo, onApply, onClose }: {
  file: string; result: ImportResult; hasRoster: boolean; canLogo: boolean;
  onApply: (mode: "replace" | "append", useLogo: boolean) => void; onClose: () => void;
}) {
  const imp = result.import;
  const [useLogo, setUseLogo] = useState(canLogo && !!result.logo);
  const media = imp.players.filter((p) => p.role === "media").length;
  const stats: [number, string][] = [[imp.players.length - media, "o‘yinchi"], [media, "media shaxs"], [imp.staff.length, "murabbiy"], [imp.players.length + imp.staff.length, "forma komplekti"]];
  return (
    <Modal title="Exceldan import" onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Bekor qilish</button>
        {hasRoster && <button type="button" className="btn" onClick={() => onApply("append", useLogo)}>Mavjudlariga qo‘shish</button>}
        <button type="button" className="btn btn-primary" onClick={() => onApply("replace", useLogo)}>{hasRoster ? "Tarkibni almashtirish" : `${imp.rows} ta qatorni import qilish`}</button>
      </>}>
      <div className="note"><I.doc size={18} /><div className="grow"><b style={{ color: "var(--text)" }}>{file}</b><div>{imp.rows} qator topildi</div></div></div>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        {stats.map(([n, t]) => <div key={t} className="box sub" style={{ flex: 1, minWidth: 110, gap: 0 }}><b style={{ fontFamily: "var(--display)", fontSize: 24 }}>{n}</b><span className="small sec">{t}</span></div>)}
      </div>
      {!!imp.fixes.length && (
        <div className="stack" style={{ gap: 6 }}>
          <b className="small">Avtomatik tuzatildi</b>
          <span className="small sec">{imp.fixes.join(" · ")}</span>
        </div>
      )}
      {!!imp.issues.length && (
        <div className="box warn">
          <b className="small">Tekshirish kerak — importdan keyin tuzatasiz</b>
          {imp.issues.map((t) => <CheckLine key={t} level="warn">{t}</CheckLine>)}
        </div>
      )}
      {result.logo && canLogo && (
        <label className="check box sub" style={{ flexDirection: "row", alignItems: "center" }}>
          <input type="checkbox" checked={useLogo} onChange={(e) => setUseLogo(e.target.checked)} />
          <img src={result.logo.url} alt="" style={{ width: 40, height: 40, objectFit: "contain", borderRadius: 4, background: "#fff" }} />
          <span className="grow">Faylda rasm topildi — jamoa logotipi sifatida ishlatish</span>
        </label>
      )}
      {hasRoster && <span className="small muted">Tarkibda allaqachon odamlar bor: almashtirsangiz, ular o‘chadi.</span>}
    </Modal>
  );
}

/* ---------- tables ---------- */
type RowFlags = Record<number, "err" | "warn">;

export function rowFlags(checks: Check[], staff = false): RowFlags {
  const out: RowFlags = {};
  for (const c of checks) {
    if (c.section !== "roster" || c.index == null || !!c.staff !== staff) continue;
    if (c.level === "error") out[c.index] = "err";
    else if (!out[c.index]) out[c.index] = "warn";
  }
  return out;
}

export function PlayersTable({ token, rows, flags, notes, locked, onEdit, onDelete }: {
  token: string; rows: { p: Player; i: number }[]; flags: RowFlags; notes: Record<number, { text: string; level: string }>; locked: boolean;
  onEdit: (i: number) => void; onDelete: (i: number) => void;
}) {
  if (!rows.length) return null;
  return (
    <div className="tbl">
      <div className="tr head"><span>№</span><span>Ism familiya · ish joyi</span><span className="c-jersey">Futbolkada</span><span className="c-birth">Tug‘ilgan</span><span>O‘lcham</span><span className="c-med">Tibbiy</span><span /></div>
      {rows.map(({ p, i }) => {
        const note = notes[i];
        return (
          <div key={i} className={`tr ${flags[i] || ""}`}>
            <span className="num-box">{p.number ?? "—"}</span>
            <div className="who">
              <span className="avatar">{p.photo_url ? <img src={p.photo_url} alt="" /> : initials(fullName(p))}</span>
              <div style={{ minWidth: 0 }}>
                <b><span className="ellipsis">{fullName(p) || "Ismsiz"}</span>{p.role === "goalkeeper" && <span className="tag">GK</span>}{p.role === "media" && <span className="tag dark">Media</span>}</b>
                <small className={note ? (note.level === "error" ? "danger-text" : "warn-text") : ""}>{note ? note.text : p.workplace || "Ish joyi ko‘rsatilmagan"}</small>
              </div>
            </div>
            <b className="c-jersey small ellipsis">{p.jersey_name || <span className="muted">—</span>}</b>
            <span className="c-birth tnum">{fmtBirth(p.birth_date)}</span>
            <span>{p.kit_size ? <span className="size-tag">{p.kit_size}</span> : <span className="muted">—</span>}</span>
            <span className="c-med small">{p.medical ? <a className="accent-text" href={api.fileUrl(token, p.medical.file)} target="_blank" rel="noopener noreferrer">✓ Yuklangan</a> : <span className="muted">Yuklanmagan</span>}</span>
            <span className="acts">
              {!locked && <>
                <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Tahrirlash" onClick={() => onEdit(i)}><I.edit size={16} /></button>
                <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="O‘chirish" onClick={() => onDelete(i)}><I.trash size={16} /></button>
              </>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function StaffTable({ rows, flags, locked, onEdit, onDelete }: { rows: Staff[]; flags: RowFlags; locked: boolean; onEdit: (i: number) => void; onDelete: (i: number) => void }) {
  if (!rows.length) return null;
  return (
    <div className="tbl">
      {rows.map((s, i) => (
        <div key={i} className={`tr ${flags[i] || ""}`} style={{ gridTemplateColumns: "minmax(0,1fr) 96px 64px 64px" }}>
          <div className="who">
            <span className="avatar">{initials(fullName(s))}</span>
            <div style={{ minWidth: 0 }}><b className="ellipsis">{fullName(s) || "Ismsiz"}</b><small>{STAFF_ROLES[s.role] || s.role}</small></div>
          </div>
          <span className="tnum small">{fmtBirth(s.birth_date)}</span>
          <span>{s.kit_size ? <span className="size-tag">{s.kit_size}</span> : <span className="muted">—</span>}</span>
          <span className="acts">
            {!locked && <>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Tahrirlash" onClick={() => onEdit(i)}><I.edit size={16} /></button>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="O‘chirish" onClick={() => onDelete(i)}><I.trash size={16} /></button>
            </>}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ImportButton({ token, onResult, disabled }: { token: string; onResult: (file: string, r: ImportResult) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function pick(f?: File) {
    if (!f) return;
    setBusy(true);
    try {
      onResult(f.name, await api.importRoster(token, f));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Faylni o‘qib bo‘lmadi", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className="btn" onClick={() => ref.current?.click()} disabled={disabled || busy}>{busy ? <Spinner /> : <I.upload size={16} />} Exceldan yuklash</button>
      <input ref={ref} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
    </>
  );
}
