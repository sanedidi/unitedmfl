import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { uploadImage } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { analysisLines, busyStatus, kitApi, type KitPlayer, type TeamKit } from "@/lib/kit";
import type { CardCtx } from "@/components/Crud";
import { Badge, ImageInput, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

const fileName = (u: string) => decodeURIComponent(u.split("/").pop() || u);

function KitBadge({ p }: { p: Pick<KitPlayer, "kit_status" | "kit_error" | "kit_analysis" | "kit_approved_url"> }) {
  const s = p.kit_status;
  const map: Record<string, [string, string]> = {
    review: [p.kit_analysis?.graphic ? "Tekshiruvda · afisha" : "Tekshiruvda", "warn"],
    approved: ["Saytda", "ok"],
    rejected: [p.kit_approved_url ? "Saytda (eski)" : "Rad etilgan", ""],
    error: ["Xato", "danger"],
    multi: ["Bir nechta odam", ""],
    skipped: ["Asl rasm yo‘q", ""],
    queued: ["Navbatda", ""],
    running: ["Yaratilmoqda", "info"],
    cancelled: ["To‘xtatilgan", ""],
  };
  const [label, tone] = map[s] || ["Formasiz", ""];
  return <span title={p.kit_error || undefined}><Badge tone={tone}>{label}</Badge></span>;
}

/** Drop zone / picker for a kit or photo file. */
function Dropzone({ onFile, busy, children }: { onFile: (f: File) => void; busy: boolean; children: ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div className={`dropzone${over ? " over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}>
      {children}
      <button type="button" className="btn" onClick={() => ref.current?.click()} disabled={busy}><I.upload size={16} /> {busy ? "Yuklanmoqda…" : "Forma yuklash"}</button>
      <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </div>
  );
}

function ShirtIcon() {
  return (
    <svg width="40" height="44" viewBox="20 12 160 174" fill="none" stroke="currentColor" strokeWidth="6" strokeLinejoin="round" aria-hidden>
      <path d="M62 22 84 14c8 12 24 12 32 0l22 8 40 30-16 32-18-10v110H56V74l-18 10-16-32Z" />
    </svg>
  );
}

/* ================= Team: «Forma» + «O‘yinchilar formada» ================= */
export function TeamKitSection({ c }: { c: CardCtx }) {
  const teamId = c.item ? Number(c.item.id) : null;
  const [data, setData] = useState<TeamKit | null>(null);
  const [tick, setTick] = useState(0);
  const polls = useRef(0);
  const reload = () => setTick((t) => t + 1);
  useEffect(() => {
    if (!teamId) return;
    let alive = true;
    kitApi.team(teamId).then((d) => alive && setData(d)).catch(() => {});
    return () => { alive = false; };
  }, [teamId, c.version, tick]);
  // keep polling while players are being dressed or the AI is writing the description
  const busy = !!data && ((data.counts.queued || 0) + (data.counts.running || 0) > 0);
  const waitingDesc = !!data && !!data.team.kit_url && !data.team.kit_description && polls.current < 20;
  useEffect(() => {
    polls.current = 0;
  }, [c.version]);
  useEffect(() => {
    if (!busy && !waitingDesc) return;
    const t = setTimeout(() => { polls.current++; reload(); }, 3000);
    return () => clearTimeout(t);
  }, [busy, waitingDesc, data]);
  return (
    <>
      <KitCard c={c} data={data} onChanged={reload} />
      {teamId && data && (data.team.kit_url || data.players.some((p) => p.kit_status)) && <KitPlayersCard data={data} onChanged={reload} />}
    </>
  );
}

function KitCard({ c, data, onChanged }: { c: CardCtx; data: TeamKit | null; onChanged: () => void }) {
  const toast = useToast();
  const kit = String(c.values.kit_url || "");
  // the server copy (refreshed after every save), not the page's initial item
  const savedKit = data ? data.team.kit_url : String(c.item?.kit_url || "");
  const unsaved = kit !== savedKit;
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState("");
  const [edit, setEdit] = useState<string | null>(null);
  const desc = data?.team.kit_description || "";
  const fileRef = useRef<HTMLInputElement>(null);
  async function upload(f: File) {
    setUploading(true);
    try {
      c.set("kit_url", await uploadImage(f));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Yuklashda xato", "error");
    } finally {
      setUploading(false);
    }
  }
  async function redescribe() {
    if (!c.item) return;
    setBusy("describe");
    try {
      await kitApi.describe(Number(c.item.id));
      toast("Forma tavsifi yangilandi");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy("");
    }
  }
  async function saveDesc() {
    if (!c.item || edit === null) return;
    setBusy("desc");
    try {
      await kitApi.saveDescription(Number(c.item.id), edit.trim());
      setEdit(null);
      toast("Saqlandi");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="card">
      <div className="card-head"><h3>Forma</h3><span className="muted small">{kit ? "Bitta forma · barcha o‘yinchilar uchun" : "Ixtiyoriy · keyin ham yuklash mumkin"}</span></div>
      <div className="card-pad stack" style={{ gap: 12 }}>
        {!kit ? (
          <>
            <Dropzone onFile={upload} busy={uploading}>
              <span className="muted"><ShirtIcon /></span>
              <b>Forma rasmini shu yerga tashlang yoki tanlang</b>
              <span className="muted small">JPG/PNG/WEBP · old tomoni, tekis fonda · kamida 1024×1024</span>
            </Dropzone>
            <div className="hint-box">✦ Forma yuklanganda (hozir yoki keyin) AI jamoadagi barcha rasmli o‘yinchilarni shu formada kiyintiradi. Formasiz jamoa ham saqlanadi — o‘yinchilar asl rasmda qoladi.</div>
          </>
        ) : (
          <div className="kit-row">
            <a className="kit-img" href={kit} target="_blank" rel="noopener noreferrer"><img src={kit} alt="Forma" /></a>
            <div className="stack grow" style={{ gap: 12 }}>
              <div>
                <b className="ellipsis" style={{ display: "block" }}>{fileName(kit)}</b>
                {unsaved
                  ? <span className="small warn-text">Saqlanmagan — «Saqlash»dan keyin o‘yinchilar kiyintiriladi</span>
                  : <span className="muted small">Yuklangan forma</span>}
              </div>
              {!unsaved && c.item && (
                <div className="desc-box">
                  <div className="row"><span className="small" style={{ fontWeight: 600 }}>Forma tavsifi — AI rasmdan tuzdi</span><div className="grow" />
                    {edit === null && desc && <button type="button" className="link-btn" onClick={() => setEdit(desc)}>Tahrirlash</button>}</div>
                  {edit !== null ? (
                    <>
                      <textarea className="textarea" rows={4} value={edit} onChange={(e) => setEdit(e.target.value)} aria-label="Forma tavsifi" />
                      <div className="row"><button type="button" className="btn btn-sm btn-primary" onClick={saveDesc} disabled={busy === "desc"}>Saqlash</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => setEdit(null)}>Bekor qilish</button></div>
                    </>
                  ) : desc ? <p className="desc-text">{desc}</p> : <p className="muted small" style={{ margin: 0 }}>{data?.ai.on === false ? "AI-servis o‘chirilgan — tavsif tuzilmadi." : "AI forma tavsifini tuzmoqda…"}</p>}
                  <span className="muted" style={{ fontSize: 11 }}>Prompt shablonidagi {"{forma_tavsifi}"} o‘rniga qo‘yiladi</span>
                </div>
              )}
              <div className="row wrap">
                <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={uploading}><I.upload size={16} /> {uploading ? "Yuklanmoqda…" : "Formani almashtirish"}</button>
                {!unsaved && c.item && <button type="button" className="btn btn-ghost" onClick={redescribe} disabled={!!busy}>{busy === "describe" ? "Tuzilmoqda…" : "Tavsifni qayta tuzish"}</button>}
                <button type="button" className="btn btn-ghost danger-text" onClick={() => c.set("kit_url", "")}>Olib tashlash</button>
              </div>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function KitPlayersCard({ data, onChanged }: { data: TeamKit; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState("");
  const [hintFor, setHintFor] = useState<KitPlayer | null>(null);
  const n = data.counts;
  const total = data.players.length;
  const pending = (n.queued || 0) + (n.running || 0);
  const done = data.players.filter((p) => !busyStatus(p.kit_status) && p.kit_status !== "" && p.kit_status !== "cancelled").length;
  const review = n.review || 0;
  const list = all ? data.players : data.players.slice(0, 8);
  const teamId = data.team.id;
  async function run(fn: () => Promise<unknown>, key: string, ok?: string) {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy("");
    }
  }
  async function rerunAll() {
    if (!(await confirm({ title: "Hammasini qayta kiyintirish", text: `${total} ta o‘yinchi navbatga qo‘yiladi. Saytdagi tasdiqlangan rasmlar yangisi tasdiqlanguncha qoladi.`, ok: "Boshlash" }))) return;
    run(() => kitApi.run(teamId), "run", "Navbatga qo‘yildi");
  }
  const head = pending > 0 ? `Kiyintirilmoqda · ${done} / ${total}` : `${n.on_site || 0} / ${total} saytda${review ? ` · ${review} ta tekshiruvda` : ""}`;
  return (
    <div className="card">
      <div className="card-head"><h3>O‘yinchilar formada</h3><span className="muted small">{head}</span></div>
      <div className="card-pad stack" style={{ gap: 16 }}>
        {!data.ai.on && <div className="alert warn"><I.alert size={16} /><div>AI-servis o‘chirilgan yoki ulanmagan — o‘yinchilar kiyintirilmaydi.</div></div>}
        {pending > 0 ? (
          <div className="kit-progress">
            <div className="row"><b>✦ O‘yinchilar formada kiyintirilmoqda</b><div className="grow" /><span className="small">{done} / {total} · har biri ≈ 30–60 s</span></div>
            <div className="bar"><i style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
            <span className="small">Sahifani yopsangiz ham jarayon serverda davom etadi. Natijalar tayyor bo‘lgach shu yerda tekshirasiz.</span>
          </div>
        ) : (
          <div className="note-box">Forma yuklanganda barcha o‘yinchilar avtomatik kiyintiriladi. Asl rasmlar saqlanadi — tasdiqlanmaguncha saytda eski rasm turadi.</div>
        )}
        <div className="row wrap">
          {pending > 0
            ? <button type="button" className="btn" onClick={() => run(() => kitApi.stop(teamId), "stop", "To‘xtatildi")} disabled={!!busy}>To‘xtatish</button>
            : <>
              <button type="button" className="btn btn-primary" disabled={!review || !!busy} onClick={() => run(() => kitApi.approveAll(teamId), "approve", "Tasdiqlandi — saytda yangilandi")}>Tekshiruvdagilarni tasdiqlash ({review})</button>
              <button type="button" className="btn" disabled={!!busy || !data.team.kit_url} onClick={rerunAll}>Hammasini qayta kiyintirish</button>
            </>}
          <div className="grow" />
          {data.ai.model && <span className="muted small">{data.ai.model} · {data.ai.quality === "high" ? "Yuqori" : data.ai.quality === "medium" ? "O‘rta" : "Past"}</span>}
        </div>
        {total === 0 ? <p className="muted" style={{ margin: 0 }}>Jamoada hali o‘yinchi yo‘q.</p> : (
          <div className="kit-grid">
            {list.map((p) => <KitTile key={p.id} p={p} busy={busy} onAct={(a) => {
              if (a === "hint") setHintFor(p);
              else run(() => kitApi.act(p.id, a), `${a}:${p.id}`, a === "approve" ? "Tasdiqlandi" : undefined);
            }} />)}
          </div>
        )}
        {data.players.length > 8 && <button type="button" className="link-btn" onClick={() => setAll(!all)}>{all ? "Kamroq ko‘rsatish" : `Hammasini ko‘rish (${data.players.length})`}</button>}
      </div>
      {hintFor && <HintModal p={hintFor} onClose={() => setHintFor(null)} onDone={() => { setHintFor(null); onChanged(); }} />}
    </div>
  );
}

function Thumb({ src, children, dashed, tall }: { src?: string; children?: ReactNode; dashed?: boolean; tall?: boolean }) {
  return src
    ? <a className={`kit-thumb${tall ? " tall" : ""}`} href={src} target="_blank" rel="noopener noreferrer" style={{ backgroundImage: `url("${src}")` }} aria-label="To‘liq o‘lchamda ochish" />
    : <div className={`kit-thumb empty${dashed ? " dashed" : ""}${tall ? " tall" : ""}`}>{children}</div>;
}

function afterThumb(p: KitPlayer, tall?: boolean) {
  const s = p.kit_status;
  if ((s === "review" || s === "approved" || s === "rejected") && p.kit_photo_url) return <Thumb src={p.kit_photo_url} tall={tall} />;
  if (s === "running") return <Thumb dashed tall={tall}><span className="spinner" /><span>AI…</span></Thumb>;
  if (s === "queued") return <Thumb dashed tall={tall}><span>Navbatda</span></Thumb>;
  if (s === "error") return <Thumb dashed tall={tall}><span className="danger-text">Xato</span></Thumb>;
  return <Thumb dashed tall={tall}><span>—</span></Thumb>;
}

type Act = "approve" | "reject" | "revert" | "regenerate" | "hint";

function KitTile({ p, busy, onAct }: { p: KitPlayer; busy: string; onAct: (a: Act) => void }) {
  const s = p.kit_status;
  const dis = busy.endsWith(`:${p.id}`);
  const chip = (label: string, a: Act, kind = "") => <button key={a} type="button" className={`chip-btn ${kind}`} disabled={dis} onClick={() => onAct(a)}>{label}</button>;
  return (
    <div className={`kit-tile${s === "review" ? " focus" : ""}`}>
      <div className="kit-pair">
        {p.photo_url ? <Thumb src={p.photo_url} /> : <Thumb dashed><span>—</span></Thumb>}
        {afterThumb(p)}
      </div>
      <Link className="kit-name ellipsis" to={`/players/${p.id}`}>{p.number != null && <>#{p.number}  </>}{p.full_name}</Link>
      <KitBadge p={p} />
      {s === "error" && p.kit_error && <span className="small danger-text clamp-2" title={p.kit_error}>{p.kit_error}</span>}
      <div className="row wrap" style={{ gap: 6 }}>
        {s === "review" && [chip("✓ Tasdiqlash", "approve", "primary"), chip("✕", "reject", "danger"), chip("↻", "regenerate")]}
        {s === "approved" && [chip("↻ Qayta", "regenerate"), chip("Asliga", "revert")]}
        {(s === "rejected" || s === "error" || s === "cancelled" || s === "") && p.photo_url && p.team_has_kit && [chip(s === "error" ? "↻ Qayta urinish" : "↻ Kiyintirish", "regenerate"), ...(p.kit_approved_url ? [chip("Asliga", "revert")] : [])]}
        {s === "multi" && chip("Kim ekanini belgilash", "hint")}
        {s === "skipped" && <span className="muted" style={{ fontSize: 11 }}>Avval rasm yuklang</span>}
        {busyStatus(s) && <span className="muted" style={{ fontSize: 11 }}>{s === "running" ? "≈ 30–60 soniya" : "Navbatda"}</span>}
      </div>
    </div>
  );
}

function HintModal({ p, onClose, onDone }: { p: KitPlayer; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [hint, setHint] = useState(p.kit_hint || "");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await kitApi.act(p.id, "regenerate", hint.trim());
      toast("Navbatga qo‘yildi");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Rasmdagi o‘yinchini belgilash" onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Bekor qilish</button><button className="btn btn-primary" disabled={busy || hint.trim().length < 3} onClick={go}>Kiyintirish</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {p.photo_url && <img src={p.photo_url} alt={p.full_name} style={{ maxWidth: "100%", maxHeight: 320, borderRadius: 8, alignSelf: "flex-start" }} />}
        <p className="muted" style={{ margin: 0 }}>Rasmda bir nechta odam bor. {p.full_name} qaysi biri ekanini yozing — faqat u formada qoladi, qolganlari olib tashlanadi.</p>
        <div className="field">
          <label htmlFor="kit-hint">Kim ekani</label>
          <input id="kit-hint" className="input" value={hint} onChange={(e) => setHint(e.target.value)} placeholder="Masalan: chapdan ikkinchi, qora sochli, 10-raqam" autoFocus />
        </div>
        <p className="muted small" style={{ margin: 0 }}>Yaxshisi — o‘yinchining yakka rasmini yuklang.</p>
      </div>
    </Modal>
  );
}

/* ================= Player: «Rasm» card with the kit review ================= */
export function PlayerPhotoCard({ c }: { c: CardCtx }) {
  const toast = useToast();
  const { can } = useAuth();
  const id = c.item ? Number(c.item.id) : null;
  const [p, setP] = useState<KitPlayer | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState("");
  const [replace, setReplace] = useState(false);
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    kitApi.player(id).then((d) => alive && setP(d)).catch(() => {});
    return () => { alive = false; };
  }, [id, c.version, tick]);
  useEffect(() => {
    if (!p || !busyStatus(p.kit_status)) return;
    const t = setTimeout(() => setTick((x) => x + 1), 3000);
    return () => clearTimeout(t);
  }, [p]);
  const photo = String(c.values.photo_url || "");
  const unchanged = !!p && photo === p.photo_url;
  const s = p?.kit_status || "";
  const showPair = unchanged && !!p && !!p.kit_photo_url && (s === "review" || s === "approved" || s === "rejected");
  async function act(a: "approve" | "reject" | "revert" | "regenerate") {
    if (!id) return;
    setBusy(a);
    try {
      setP(await kitApi.act(id, a));
      if (a === "approve") toast("Tasdiqlandi — saytda yangi rasm");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy("");
    }
  }
  const lines = analysisLines(p?.kit_analysis);
  return (
    <div className="card">
      <div className="card-head"><h3>Rasm</h3>{unchanged && p && s && <KitBadge p={p} />}</div>
      <div className="card-pad stack" style={{ gap: 14 }}>
        {showPair && p ? (
          <>
            <div className="kit-pair big">
              <div className="stack" style={{ gap: 6 }}><span className="small" style={{ fontWeight: 600 }}>Asl rasm</span><Thumb src={p.photo_url} tall /></div>
              <div className="stack" style={{ gap: 6 }}><span className="small accent-text" style={{ fontWeight: 600 }}>Formada · AI</span><div className="kit-new">{afterThumb(p, true)}</div></div>
            </div>
            {lines.length > 0 && (
              <div className="desc-box">
                <span className="small" style={{ fontWeight: 600 }}>Rasm tahlili (AI)</span>
                {lines.map((l) => <span key={l} className="small">• {l}</span>)}
              </div>
            )}
            <span className="muted small">{p.kit_model}{p.kit_updated_at ? ` · ${fmtDateTime(p.kit_updated_at)}` : ""}</span>
            {s === "review" && (
              <>
                <div className="row"><button type="button" className="btn btn-primary grow" onClick={() => act("approve")} disabled={!!busy}>Tasdiqlash</button><button type="button" className="btn grow" onClick={() => act("regenerate")} disabled={!!busy}>Qayta yaratish</button></div>
                <div className="row"><button type="button" className="link-btn danger-text" onClick={() => act("reject")} disabled={!!busy}>Rad etish</button><div className="grow" /><button type="button" className="link-btn" onClick={() => setReplace(!replace)}>Asl rasmni almashtirish</button></div>
              </>
            )}
            {s === "approved" && (
              <div className="row wrap"><button type="button" className="btn" onClick={() => act("regenerate")} disabled={!!busy}>↻ Qayta yaratish</button><button type="button" className="btn btn-ghost" onClick={() => act("revert")} disabled={!!busy}>Asl rasmga qaytish</button><div className="grow" /><button type="button" className="link-btn" onClick={() => setReplace(!replace)}>Asl rasmni almashtirish</button></div>
            )}
            {s === "rejected" && (
              <div className="row wrap"><button type="button" className="btn btn-primary" onClick={() => act("approve")} disabled={!!busy}>Baribir tasdiqlash</button><button type="button" className="btn" onClick={() => act("regenerate")} disabled={!!busy}>↻ Qayta yaratish</button><div className="grow" /><button type="button" className="link-btn" onClick={() => setReplace(!replace)}>Asl rasmni almashtirish</button></div>
            )}
            {replace && <ImageInput value={photo} onChange={(v) => c.set("photo_url", v)} />}
            <div className="note-box">{s === "approved" ? "Saytda formadagi rasm ko‘rinadi. Asl rasm saqlangan." : "Tasdiqlanmaguncha saytda asl rasm ko‘rinadi. Asl rasm almashtirilsa, forma bilan qayta avtomatik yaratiladi."}</div>
          </>
        ) : (
          <>
            <ImageInput value={photo} onChange={(v) => c.set("photo_url", v)} />
            {!unchanged && p?.team_has_kit && photo && <span className="small warn-text">Saqlangandan so‘ng jamoa formasi bilan avtomatik kiyintiriladi.</span>}
            {unchanged && p && busyStatus(s) && <div className="row small muted"><span className="spinner" /> {s === "running" ? "Formada kiyintirilmoqda…" : "Navbatda — tez orada kiyintiriladi"}</div>}
            {unchanged && p && s === "error" && (
              <div className="alert danger"><I.alert size={16} /><div>{p.kit_error || "Xato"}{p.team_has_kit && <> · <button type="button" className="link-btn" onClick={() => act("regenerate")}>Qayta urinish</button></>}</div></div>
            )}
            {unchanged && p && s === "multi" && (
              <div className="alert warn"><I.alert size={16} /><div>Rasmda bir nechta odam. <button type="button" className="link-btn" onClick={() => setHint(true)}>Kim ekanini belgilash</button> yoki yakka rasm yuklang.</div></div>
            )}
            {unchanged && p && (s === "" || s === "cancelled") && p.team_has_kit && photo && can("teams") && (
              <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => act("regenerate")} disabled={!!busy}>✦ Jamoa formasida kiyintirish</button>
            )}
          </>
        )}
      </div>
      {hint && p && <HintModal p={p} onClose={() => setHint(false)} onDone={() => { setHint(false); setTick((x) => x + 1); }} />}
    </div>
  );
}
