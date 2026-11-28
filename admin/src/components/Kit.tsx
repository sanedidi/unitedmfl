import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { uploadImage } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { analysisLines, busyStatus, kitApi, STAFF_ROLES, type KitPlayer, type TeamKit } from "@/lib/kit";
import type { CardCtx } from "@/components/Crud";
import { Badge, ImageInput, Modal, useConfirm, useToast } from "@/components/ui";
import { invalidateRefs } from "@/lib/refs";
import { I } from "@/components/Icons";

import { tx } from "@/lib/i18n";
const fileName = (u: string) => decodeURIComponent(u.split("/").pop() || u);

function KitBadge({ p }: { p: Pick<KitPlayer, "kit_status" | "kit_error" | "kit_analysis" | "kit_approved_url"> }) {
  const s = p.kit_status;
  const map: Record<string, [string, string]> = {
    review: [p.kit_analysis?.graphic ? tx("Tekshiruvda · afisha") : tx("Tekshiruvda"), "warn"],
    approved: [tx("Saytda"), "ok"],
    rejected: [p.kit_approved_url ? tx("Saytda (eski)") : tx("Rad etilgan"), ""],
    error: [tx("Xato"), "danger"],
    multi: [tx("Bir nechta odam"), ""],
    skipped: [tx("Asl rasm yo‘q"), ""],
    queued: [tx("Navbatda"), ""],
    running: [tx("Yaratilmoqda"), "info"],
    cancelled: [tx("To‘xtatilgan"), ""],
  };
  const [label, tone] = map[s] || [tx("Formasiz"), ""];
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
      <button type="button" className="btn" onClick={() => ref.current?.click()} disabled={busy}><I.upload size={16} /> {busy ? tx("Yuklanmoqda…") : tx("Forma yuklash")}</button>
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
      {teamId && data && (data.team.kit_url || [...data.players, ...data.staff].some((p) => p.kit_status)) && <KitPlayersCard data={data} onChanged={reload} />}
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
      toast(e instanceof Error ? e.message : tx("Yuklashda xato"), "error");
    } finally {
      setUploading(false);
    }
  }
  async function redescribe() {
    if (!c.item) return;
    setBusy("describe");
    try {
      const d = await kitApi.describe(Number(c.item.id));
      invalidateRefs();
      toast(d.kit_has_number ? tx("Tavsif yangilandi · formada raqam bor") : tx("Forma tavsifi yangilandi"));
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    } finally {
      setBusy("");
    }
  }
  async function toggleNumber(on: boolean) {
    if (!c.item) return;
    setBusy("number");
    try {
      await kitApi.setNumber(Number(c.item.id), on);
      invalidateRefs();
      toast(on ? tx("Raqam majburiy — «Hammasini qayta kiyintirish» bilan rasmlarni yangilang") : tx("Saqlandi"));
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
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
      toast(tx("Saqlandi"));
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="card">
      <div className="card-head"><h3>{tx("Forma")}</h3><span className="muted small">{kit ? tx("Bitta forma · barcha o‘yinchilar uchun") : tx("Ixtiyoriy · keyin ham yuklash mumkin")}</span></div>
      <div className="card-pad stack" style={{ gap: 12 }}>
        {!kit ? (
          <>
            <Dropzone onFile={upload} busy={uploading}>
              <span className="muted"><ShirtIcon /></span>
              <b>{tx("Forma rasmini shu yerga tashlang yoki tanlang")}</b>
              <span className="muted small">{tx("JPG/PNG/WEBP · old tomoni, tekis fonda · kamida 1024×1024")}</span>
            </Dropzone>
            <div className="hint-box">{tx("✦ Forma yuklanganda (hozir yoki keyin) AI jamoadagi barcha rasmli o‘yinchilarni shu formada kiyintiradi. Formasiz jamoa ham saqlanadi — o‘yinchilar asl rasmda qoladi.")}</div>
          </>
        ) : (
          <div className="kit-row">
            <a className="kit-img" href={kit} target="_blank" rel="noopener noreferrer"><img src={kit} alt={tx("Forma")} /></a>
            <div className="stack grow" style={{ gap: 12 }}>
              <div>
                <b className="ellipsis" style={{ display: "block" }}>{fileName(kit)}</b>
                {unsaved
                  ? <span className="small warn-text">{tx("Saqlanmagan — «Saqlash»dan keyin o‘yinchilar kiyintiriladi")}</span>
                  : <span className="muted small">{tx("Yuklangan forma")}</span>}
              </div>
              {!unsaved && c.item && (
                <div className="desc-box">
                  <div className="row"><span className="small" style={{ fontWeight: 600 }}>{tx("Forma tavsifi — AI rasmdan tuzdi")}</span><div className="grow" />
                    {edit === null && desc && <button type="button" className="link-btn" onClick={() => setEdit(desc)}>{tx("Tahrirlash")}</button>}</div>
                  {edit !== null ? (
                    <>
                      <textarea className="textarea" rows={4} value={edit} onChange={(e) => setEdit(e.target.value)} aria-label={tx("Forma tavsifi")} />
                      <div className="row"><button type="button" className="btn btn-sm btn-primary" onClick={saveDesc} disabled={busy === "desc"}>{tx("Saqlash")}</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => setEdit(null)}>{tx("Bekor qilish")}</button></div>
                    </>
                  ) : desc ? <p className="desc-text">{desc}</p> : <p className="muted small" style={{ margin: 0 }}>{data?.ai.on === false ? tx("AI-servis o‘chirilgan — tavsif tuzilmadi.") : tx("AI forma tavsifini tuzmoqda…")}</p>}
                  <span className="muted" style={{ fontSize: 11 }}>{tx("Prompt shablonidagi")}{" "}{"{forma_tavsifi}"}{" "}{tx("o‘rniga qo‘yiladi")}</span>
                </div>
              )}
              {!unsaved && c.item && data && (
                <label className="toggle-row number-row">
                  <span><b>{tx("Formada o‘yinchi raqami bor")}</b>
                    <small>{data.team.kit_has_number
                      ? tx("{0}har bir o‘yinchiga o‘z raqami chiziladi; «Raqam» majburiy", data.team.kit_number_style ? data.team.kit_number_style + " · " : "")
                      : tx("Raqam ko‘rinmaydi — AI raqam qo‘shmaydi, «Raqam» ixtiyoriy")}</small></span>
                  <input type="checkbox" className="switch" checked={data.team.kit_has_number} disabled={busy === "number"} onChange={(e) => toggleNumber(e.target.checked)} />
                </label>
              )}
              <div className="row wrap">
                <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={uploading}><I.upload size={16} /> {uploading ? tx("Yuklanmoqda…") : tx("Formani almashtirish")}</button>
                {!unsaved && c.item && <button type="button" className="btn btn-ghost" onClick={redescribe} disabled={!!busy}>{busy === "describe" ? tx("Tuzilmoqda…") : tx("Tavsifni qayta tuzish")}</button>}
                <button type="button" className="btn btn-ghost danger-text" onClick={() => c.set("kit_url", "")}>{tx("Olib tashlash")}</button>
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
  const people = [...data.players, ...data.staff];
  const total = people.length;
  const pending = (n.queued || 0) + (n.running || 0);
  const done = people.filter((p) => !busyStatus(p.kit_status) && p.kit_status !== "" && p.kit_status !== "cancelled").length;
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
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    } finally {
      setBusy("");
    }
  }
  async function rerunAll() {
    if (!(await confirm({ title: tx("Hammasini qayta kiyintirish"), text: tx("{0} kishi (o‘yinchilar va murabbiylar) navbatga qo‘yiladi. Saytdagi tasdiqlangan rasmlar yangisi tasdiqlanguncha qoladi.", total), ok: tx("Boshlash") }))) return;
    run(() => kitApi.run(teamId), "run", tx("Navbatga qo‘yildi"));
  }
  function onAct(p: KitPlayer, a: Act) {
    if (a === "hint") setHintFor(p);
    else run(() => kitApi.act(p.id, a, undefined, p.kind), `${a}:${p.kind}${p.id}`, a === "approve" ? tx("Tasdiqlandi") : undefined);
  }
  const head = pending > 0 ? tx("Kiyintirilmoqda · {0} / {1}", done, total) : `${n.on_site || 0} / ${total} saytda${review ? tx(" · {0} ta tekshiruvda", review) : ""}`;
  return (
    <div className="card">
      <div className="card-head"><h3>{tx("O‘yinchilar va murabbiylar formada")}</h3><span className="muted small">{head}</span></div>
      <div className="card-pad stack" style={{ gap: 16 }}>
        {!data.ai.on && <div className="alert warn"><I.alert size={16} /><div>{tx("AI-servis o‘chirilgan yoki ulanmagan — o‘yinchilar kiyintirilmaydi.")}</div></div>}
        {data.team.kit_has_number && (n.no_number || 0) > 0 && <div className="alert warn"><I.alert size={16} /><div>{tx("Formada raqam bor, lekin {0} ta o‘yinchida raqam kiritilmagan — ular kiyintirilmaydi. O‘yinchi sahifasida «Raqam»ni to‘ldiring.", n.no_number)}</div></div>}
        {pending > 0 ? (
          <div className="kit-progress">
            <div className="row"><b>{tx("✦ O‘yinchilar va murabbiylar formada kiyintirilmoqda")}</b><div className="grow" /><span className="small">{done}{" "}{tx("/ {0} · har biri ≈ 30–60 s", total)}</span></div>
            <div className="bar"><i style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
            <span className="small">{tx("Sahifani yopsangiz ham jarayon serverda davom etadi. Natijalar tayyor bo‘lgach shu yerda tekshirasiz.")}</span>
          </div>
        ) : (
          <div className="note-box">{tx("Forma yuklanganda barcha o‘yinchilar va murabbiylar shtabi avtomatik kiyintiriladi. Asl rasmlar saqlanadi — tasdiqlanmaguncha saytda eski rasm turadi.")}</div>
        )}
        <div className="row wrap">
          {pending > 0
            ? <button type="button" className="btn" onClick={() => run(() => kitApi.stop(teamId), "stop", tx("To‘xtatildi"))} disabled={!!busy}>{tx("To‘xtatish")}</button>
            : <>
              <button type="button" className="btn btn-primary" disabled={!review || !!busy} onClick={() => run(() => kitApi.approveAll(teamId), "approve", tx("Tasdiqlandi — saytda yangilandi"))}>{tx("Tekshiruvdagilarni tasdiqlash ({0})", review)}</button>
              <button type="button" className="btn" disabled={!!busy || !data.team.kit_url} onClick={rerunAll}>{tx("Hammasini qayta kiyintirish")}</button>
            </>}
          <div className="grow" />
          {data.ai.model && <span className="muted small">{data.ai.model} · {data.ai.quality === "high" ? tx("Yuqori") : data.ai.quality === "medium" ? tx("O‘rta") : tx("Past")}</span>}
        </div>
        {data.players.length === 0 ? <p className="muted" style={{ margin: 0 }}>{tx("Jamoada hali o‘yinchi yo‘q.")}</p> : (
          <div className="kit-grid">
            {list.map((p) => <KitTile key={`p${p.id}`} p={p} busy={busy} onAct={(a) => onAct(p, a)} />)}
          </div>
        )}
        {data.players.length > 8 && <button type="button" className="link-btn" onClick={() => setAll(!all)}>{all ? tx("Kamroq ko‘rsatish") : tx("Hammasini ko‘rish ({0})", data.players.length)}</button>}
        <div className="kit-sub"><b>{tx("Murabbiylar shtabi")}</b><span className="muted small">{data.staff.length ? tx("{0} kishi", data.staff.length) : tx("«Murabbiylar shtabi» bo‘limida qo‘shing va rasm yuklang")}</span></div>
        {data.staff.length > 0 && (
          <div className="kit-grid">
            {data.staff.map((p) => <KitTile key={`s${p.id}`} p={p} busy={busy} onAct={(a) => onAct(p, a)} />)}
          </div>
        )}
      </div>
      {hintFor && <HintModal p={hintFor} onClose={() => setHintFor(null)} onDone={() => { setHintFor(null); onChanged(); }} />}
    </div>
  );
}

function Thumb({ src, children, dashed, tall }: { src?: string; children?: ReactNode; dashed?: boolean; tall?: boolean }) {
  return src
    ? <a className={`kit-thumb${tall ? " tall" : ""}`} href={src} target="_blank" rel="noopener noreferrer" style={{ backgroundImage: `url("${src}")` }} aria-label={tx("To‘liq o‘lchamda ochish")} />
    : <div className={`kit-thumb empty${dashed ? " dashed" : ""}${tall ? " tall" : ""}`}>{children}</div>;
}

function afterThumb(p: KitPlayer, tall?: boolean) {
  const s = p.kit_status;
  if ((s === "review" || s === "approved" || s === "rejected") && p.kit_photo_url) return <Thumb src={p.kit_photo_url} tall={tall} />;
  if (s === "running") return <Thumb dashed tall={tall}><span className="spinner" /><span>{tx("AI…")}</span></Thumb>;
  if (s === "queued") return <Thumb dashed tall={tall}><span>{tx("Navbatda")}</span></Thumb>;
  if (s === "error") return <Thumb dashed tall={tall}><span className="danger-text">{tx("Xato")}</span></Thumb>;
  return <Thumb dashed tall={tall}><span>—</span></Thumb>;
}

type Act = "approve" | "reject" | "revert" | "regenerate" | "hint";

function KitTile({ p, busy, onAct }: { p: KitPlayer; busy: string; onAct: (a: Act) => void }) {
  const s = p.kit_status;
  const dis = busy.endsWith(`:${p.kind}${p.id}`);
  const chip = (label: string, a: Act, kind = "") => <button key={a} type="button" className={`chip-btn ${kind}`} disabled={dis} onClick={() => onAct(a)}>{label}</button>;
  return (
    <div className={`kit-tile${s === "review" ? " focus" : ""}`}>
      <div className="kit-pair">
        {p.photo_url ? <Thumb src={p.photo_url} /> : <Thumb dashed><span>—</span></Thumb>}
        {afterThumb(p)}
      </div>
      {p.kind === "staff"
        ? <span className="kit-name ellipsis" title={p.full_name}>{p.full_name}<small className="muted" style={{ display: "block", fontWeight: 500 }}>{STAFF_ROLES[p.role || "other"] || p.role}</small></span>
        : <Link className="kit-name ellipsis" to={`/players/${p.id}`}>{p.number != null && <>#{p.number}  </>}{p.full_name}</Link>}
      <KitBadge p={p} />
      {s === "error" && p.kit_error && <span className="small danger-text clamp-2" title={p.kit_error}>{p.kit_error}</span>}
      <div className="row wrap" style={{ gap: 6 }}>
        {s === "review" && [chip(tx("✓ Tasdiqlash"), "approve", "primary"), chip("✕", "reject", "danger"), chip("↻", "regenerate")]}
        {s === "approved" && [chip(tx("↻ Qayta"), "regenerate"), chip(tx("Asliga"), "revert")]}
        {(s === "rejected" || s === "error" || s === "cancelled" || s === "") && p.photo_url && p.team_has_kit && [chip(s === "error" ? tx("↻ Qayta urinish") : tx("↻ Kiyintirish"), "regenerate"), ...(p.kit_approved_url ? [chip(tx("Asliga"), "revert")] : [])]}
        {s === "multi" && chip(tx("Kim ekanini belgilash"), "hint")}
        {s === "skipped" && <span className="muted" style={{ fontSize: 11 }}>{tx("Avval rasm yuklang")}</span>}
        {busyStatus(s) && <span className="muted" style={{ fontSize: 11 }}>{s === "running" ? tx("≈ 30–60 soniya") : tx("Navbatda")}</span>}
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
      await kitApi.act(p.id, "regenerate", hint.trim(), p.kind);
      toast(tx("Navbatga qo‘yildi"));
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={tx("Rasmdagi o‘yinchini belgilash")} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>{tx("Bekor qilish")}</button><button className="btn btn-primary" disabled={busy || hint.trim().length < 3} onClick={go}>{tx("Kiyintirish")}</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {p.photo_url && <img src={p.photo_url} alt={p.full_name} style={{ maxWidth: "100%", maxHeight: 320, borderRadius: 8, alignSelf: "flex-start" }} />}
        <p className="muted" style={{ margin: 0 }}>{tx("Rasmda bir nechta odam bor. {0} qaysi biri ekanini yozing — faqat u formada qoladi, qolganlari olib tashlanadi.", p.full_name)}</p>
        <div className="field">
          <label htmlFor="kit-hint">{tx("Kim ekani")}</label>
          <input id="kit-hint" className="input" value={hint} onChange={(e) => setHint(e.target.value)} placeholder={tx("Masalan: chapdan ikkinchi, qora sochli, 10-raqam")} autoFocus />
        </div>
        <p className="muted small" style={{ margin: 0 }}>{tx("Yaxshisi — o‘yinchining yakka rasmini yuklang.")}</p>
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
      if (a === "approve") toast(tx("Tasdiqlandi — saytda yangi rasm"));
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    } finally {
      setBusy("");
    }
  }
  const lines = analysisLines(p?.kit_analysis);
  return (
    <div className="card">
      <div className="card-head"><h3>{tx("Rasm")}</h3>{unchanged && p && s && <KitBadge p={p} />}</div>
      <div className="card-pad stack" style={{ gap: 14 }}>
        {showPair && p ? (
          <>
            <div className="kit-pair big">
              <div className="stack" style={{ gap: 6 }}><span className="small" style={{ fontWeight: 600 }}>{tx("Asl rasm")}</span><Thumb src={p.photo_url} tall /></div>
              <div className="stack" style={{ gap: 6 }}><span className="small accent-text" style={{ fontWeight: 600 }}>{tx("Formada · AI")}</span><div className="kit-new">{afterThumb(p, true)}</div></div>
            </div>
            {lines.length > 0 && (
              <div className="desc-box">
                <span className="small" style={{ fontWeight: 600 }}>{tx("Rasm tahlili (AI)")}</span>
                {lines.map((l) => <span key={l} className="small">• {l}</span>)}
              </div>
            )}
            <span className="muted small">{p.kit_model}{p.kit_updated_at ? ` · ${fmtDateTime(p.kit_updated_at)}` : ""}</span>
            {s === "review" && (
              <>
                <div className="row"><button type="button" className="btn btn-primary grow" onClick={() => act("approve")} disabled={!!busy}>{tx("Tasdiqlash")}</button><button type="button" className="btn grow" onClick={() => act("regenerate")} disabled={!!busy}>{tx("Qayta yaratish")}</button></div>
                <div className="row"><button type="button" className="link-btn danger-text" onClick={() => act("reject")} disabled={!!busy}>{tx("Rad etish")}</button><div className="grow" /><button type="button" className="link-btn" onClick={() => setReplace(!replace)}>{tx("Asl rasmni almashtirish")}</button></div>
              </>
            )}
            {s === "approved" && (
              <div className="row wrap"><button type="button" className="btn" onClick={() => act("regenerate")} disabled={!!busy}>{tx("↻ Qayta yaratish")}</button><button type="button" className="btn btn-ghost" onClick={() => act("revert")} disabled={!!busy}>{tx("Asl rasmga qaytish")}</button><div className="grow" /><button type="button" className="link-btn" onClick={() => setReplace(!replace)}>{tx("Asl rasmni almashtirish")}</button></div>
            )}
            {s === "rejected" && (
              <div className="row wrap"><button type="button" className="btn btn-primary" onClick={() => act("approve")} disabled={!!busy}>{tx("Baribir tasdiqlash")}</button><button type="button" className="btn" onClick={() => act("regenerate")} disabled={!!busy}>{tx("↻ Qayta yaratish")}</button><div className="grow" /><button type="button" className="link-btn" onClick={() => setReplace(!replace)}>{tx("Asl rasmni almashtirish")}</button></div>
            )}
            {replace && <ImageInput value={photo} onChange={(v) => c.set("photo_url", v)} />}
            <div className="note-box">{s === "approved" ? tx("Saytda formadagi rasm ko‘rinadi. Asl rasm saqlangan.") : tx("Tasdiqlanmaguncha saytda asl rasm ko‘rinadi. Asl rasm almashtirilsa, forma bilan qayta avtomatik yaratiladi.")}</div>
          </>
        ) : (
          <>
            <ImageInput value={photo} onChange={(v) => c.set("photo_url", v)} />
            {!unchanged && p?.team_has_kit && photo && <span className="small warn-text">{tx("Saqlangandan so‘ng jamoa formasi bilan avtomatik kiyintiriladi.")}</span>}
            {unchanged && p && busyStatus(s) && <div className="row small muted"><span className="spinner" /> {s === "running" ? tx("Formada kiyintirilmoqda…") : tx("Navbatda — tez orada kiyintiriladi")}</div>}
            {unchanged && p && s === "error" && (
              <div className="alert danger"><I.alert size={16} /><div>{p.kit_error || tx("Xato")}{p.team_has_kit && <> · <button type="button" className="link-btn" onClick={() => act("regenerate")}>{tx("Qayta urinish")}</button></>}</div></div>
            )}
            {unchanged && p && s === "multi" && (
              <div className="alert warn"><I.alert size={16} /><div>{tx("Rasmda bir nechta odam.")}{" "}<button type="button" className="link-btn" onClick={() => setHint(true)}>{tx("Kim ekanini belgilash")}</button>{" "}{tx("yoki yakka rasm yuklang.")}</div></div>
            )}
            {unchanged && p && (s === "" || s === "cancelled") && p.team_has_kit && photo && can("teams:edit") && (
              <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => act("regenerate")} disabled={!!busy}>{tx("✦ Jamoa formasida kiyintirish")}</button>
            )}
          </>
        )}
      </div>
      {hint && p && <HintModal p={p} onClose={() => setHint(false)} onDone={() => { setHint(false); setTick((x) => x + 1); }} />}
    </div>
  );
}
