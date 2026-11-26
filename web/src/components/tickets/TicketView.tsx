"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Back, Camera, Check, Info, Shield, UserIc } from "./ui";
import { ETicket, LiveQR } from "./ETicket";
import { TicketApiError, tapi, type TicketPage } from "@/lib/tickets";
import { fmtDate, fmtTime } from "@/lib/format";

type Step = "ticket" | "consent" | "selfie" | "document";
const PROMPTS = ["Kameraga to‘g‘ri qarang", "Boshingizni sekin chapga buring", "Endi sekin o‘ngga buring"];

export function TicketView({ token }: { token: string }) {
  const [d, setD] = useState<TicketPage | null>(null);
  const [err, setErr] = useState("");
  const [step, setStep] = useState<Step>("ticket");
  const [name, setName] = useState("");
  const [agree, setAgree] = useState(false);
  const [fieldErr, setFieldErr] = useState("");
  const [done, setDone] = useState(false);

  const load = useCallback(() => tapi<TicketPage>("GET", `/tickets/${token}`).then((x) => { setD(x); setName((n) => n || x.ticket.holder_name); })
    .catch((e) => setErr(e instanceof TicketApiError && e.status === 404 ? "Chipta topilmadi yoki havola bekor qilingan" : e.message)), [token]);
  useEffect(() => { load(); }, [load]);

  if (err) return <div className="tk-narrow"><div className="card card-pad tk-empty"><Alert size={28} /><h1 className="h3">{err}</h1><p className="muted">Chipta egasidan yangi havola so‘rang.</p></div></div>;
  if (!d) return <div className="tk-skel" aria-busy="true">Yuklanmoqda…</div>;
  const t = d.ticket;
  const late = d.activate_by ? Date.now() > new Date(d.activate_by).getTime() : false;

  if (step === "consent") return (
    <div className="tk-narrow stack">
      <button className="tk-back" onClick={() => setStep("ticket")}><Back size={16} /> Orqaga</button>
      <h1 className="h2">Chiptani yuzingizga bog‘lash</h1>
      <div className="card card-pad stack">
        <div className="tk-face-hero"><span><UserIc size={44} /></span><i><Shield size={22} /></i></div>
        <ul className="tk-faq">
          <li><Check size={16} /><div><b>Nima uchun?</b><p>Bitta QR bilan ikki kishi kira olmaydi: kirishda yuzingiz chipta bilan solishtiriladi.</p></div></li>
          <li><Check size={16} /><div><b>Nima saqlanadi?</b><p>Kichik rasm va yuz shabloni — faqat nazoratchiga kirishda ko‘rsatish uchun.</p></div></li>
          <li><Check size={16} /><div><b>Qayerda va qancha?</b><p>O‘zbekistondagi serverda, shifrlangan. Match tugagach {d.retention_days} kundan so‘ng avtomatik o‘chiriladi.</p></div></li>
          <li><Check size={16} /><div><b>Kimga berilmaydi?</b><p>Uchinchi shaxslarga, reklamaga va boshqa maqsadlarga berilmaydi.</p></div></li>
        </ul>
        <div className="field"><label>Chipta egasining ism familiyasi</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          {fieldErr ? <small className="tk-err">{fieldErr}</small> : <small className="muted">Hujjatdagi kabi — chiptada ko‘rinadi</small>}</div>
        <label className="tk-check box"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> Biometrik ma’lumotlarimni shu maqsadda qayta ishlashga roziman</label>
      </div>
      <button className="btn btn-primary btn-lg btn-block" disabled={!agree || name.trim().length < 3} onClick={() => setStep("selfie")}><Camera size={18} /> Roziman — selfi olish</button>
      {d.no_face_entry && <button className="btn btn-text btn-block" onClick={() => setStep("document")}>Yuzsiz: hujjat bilan kirish</button>}
    </div>
  );

  if (step === "selfie") return <Selfie token={token} name={name} onBack={() => setStep("consent")} onError={(m) => { setFieldErr(m); setStep("consent"); }} onDone={() => { setDone(true); setStep("ticket"); load(); }} />;

  if (step === "document") return <DocumentEntry token={token} name={name} setName={setName} onBack={() => setStep("consent")} onDone={() => { setDone(true); setStep("ticket"); load(); }} />;

  return (
    <div className="tk-narrow stack">
      <h1 className="h2">{d.ready ? (done ? "Chipta faollashtirildi" : "Sizning chiptangiz") : "Chiptani faollashtiring"}</h1>
      {t.status === "used" && <div className="tk-banner ok"><span className="tk-banner-ico"><Check size={20} /></span><div><b>Kirish qayd etildi</b><p>{t.used_at ? `${fmtTime(t.used_at)} · ` : ""}{t.used_gate ? `${t.used_gate}-darvoza` : ""}. Chipta qayta ishlatilmaydi.</p></div></div>}
      {t.status !== "active" && t.status !== "used" && <div className="tk-banner warn"><Alert size={20} /><div><b>Chipta bekor qilingan</b><p>Bu chipta bilan kirib bo‘lmaydi.</p></div></div>}
      {d.ready && t.face_status === "bound" && t.status === "active" && <div className="tk-banner lime"><UserIc size={20} /><div><b>Yuz bog‘landi · {t.holder_name}</b><p>Bu chipta bilan faqat siz kira olasiz</p></div></div>}
      {d.ready && t.face_status === "document" && t.status === "active" && <div className="tk-banner lime"><Info size={20} /><div><b>Hujjat bilan kirish · {t.holder_name}</b><p>Kirishda pasport yoki ID-kartani ko‘rsating</p></div></div>}
      {!d.ready && t.status === "active" && (
        <div className="card card-pad stack">
          <div className="tk-banner lime"><Shield size={20} /><div><b>Har bir chipta — bitta yuz</b><p>QR-kod chipta egasi selfi bilan faollashtirgandan keyin ochiladi.{d.activate_by ? ` Muddat: ${fmtDate(d.activate_by, false)}, ${fmtTime(d.activate_by)} gacha.` : ""}</p></div></div>
          {late ? <div className="tk-alert danger">Faollashtirish muddati tugadi — stadion kassasiga hujjat bilan murojaat qiling.</div> : (
            <>
              <button className="btn btn-primary btn-lg btn-block" onClick={() => setStep("consent")}><Camera size={18} /> Selfi bilan faollashtirish</button>
              <p className="muted tk-small">Faollashtirilgach chiptani boshqa odamga o‘tkazib bo‘lmaydi.</p>
            </>
          )}
        </div>
      )}
      <ETicket t={t} match={d.match} qr={d.ready && t.status === "active" ? <LiveQR token={token} size={220} onState={(s) => s !== t.status && load()} /> : <div className="tk-qr locked"><Shield size={28} /></div>} />
      {d.ready && t.status === "active" && (
        <p className="muted tk-small tk-center">{d.dynamic_qr ? "Skrinshot ishlamaydi — kirishda shu sahifani oching. " : ""}Kirishda QR-kodni ko‘rsating · 1 chipta — 1 kishi.</p>
      )}
      <Link className="tk-center tk-small" href="/matchlar">United MFL — barcha matchlar</Link>
    </div>
  );
}

/** F3: front camera with an oval guide and a short head-turn sequence; the frontal frame is uploaded. */
function Selfie({ token, name, onBack, onDone, onError }: { token: string; name: string; onBack: () => void; onDone: () => void; onError: (m: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const shot = useRef<Blob | null>(null);
  const [i, setI] = useState(-1); // -1: camera starting
  const [camErr, setCamErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null, stop = false;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 } }, audio: false }).then((s) => {
      if (stop) return s.getTracks().forEach((x) => x.stop());
      stream = s;
      if (video.current) { video.current.srcObject = s; video.current.play().catch(() => {}); }
      window.setTimeout(() => setI(0), 600);
    }).catch(() => setCamErr("Kameraga ruxsat berilmadi. Brauzer sozlamalarida kamerani yoqing va sahifani yangilang."));
    return () => { stop = true; stream?.getTracks().forEach((x) => x.stop()); };
  }, []);

  const grab = () => new Promise<Blob | null>((ok) => {
    const v = video.current, c = canvas.current;
    if (!v || !c || !v.videoWidth) return ok(null);
    const sc = Math.min(1, 720 / v.videoWidth);
    c.width = v.videoWidth * sc; c.height = v.videoHeight * sc;
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((b) => ok(b), "image/jpeg", 0.9);
  });

  // step timing: frontal frame first, then two turns
  useEffect(() => {
    if (i < 0 || i >= PROMPTS.length) return;
    const t = window.setTimeout(async () => {
      if (i === 0) shot.current = await grab();
      setI(i + 1);
    }, i === 0 ? 1800 : 2200);
    return () => window.clearTimeout(t);
  }, [i]);

  useEffect(() => {
    if (i !== PROMPTS.length || busy) return;
    (async () => {
      if (!shot.current) { onError("Rasm olinmadi — qayta urinib ko‘ring"); return; }
      setBusy(true);
      const fd = new FormData();
      fd.append("photo", shot.current, "selfie.jpg");
      fd.append("holder_name", name.trim());
      fd.append("consent", "1");
      fd.append("liveness", JSON.stringify({ steps: PROMPTS.length, client: "web", at: new Date().toISOString() }));
      try { await tapi("POST", `/tickets/${token}/activate`, fd); onDone(); }
      catch (e) { onError(e instanceof TicketApiError ? Object.values(e.fields)[0] || e.message : "Xatolik"); }
    })();
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps

  const progress = Math.max(0, Math.min(i, PROMPTS.length)) / PROMPTS.length;
  return (
    <div className="tk-selfie">
      <header><button onClick={onBack} aria-label="Orqaga"><Back size={18} /></button><span>Selfi · {Math.min(Math.max(i + 1, 1), PROMPTS.length)}/{PROMPTS.length}</span></header>
      <div className="tk-selfie-cam">
        <video ref={video} playsInline muted />
        <canvas ref={canvas} hidden />
        <svg viewBox="0 0 100 130" className="tk-oval" aria-hidden>
          <defs><mask id="ov"><rect width="100" height="130" fill="#fff" /><ellipse cx="50" cy="62" rx="32" ry="42" fill="#000" /></mask></defs>
          <rect width="100" height="130" fill="rgba(11,13,16,.72)" mask="url(#ov)" />
          <ellipse cx="50" cy="62" rx="33" ry="43" fill="none" stroke="#91DA27" strokeWidth="1.2" strokeDasharray="4 3" />
          <ellipse cx="50" cy="62" rx="33" ry="43" fill="none" stroke="#91DA27" strokeWidth="2" pathLength={100} strokeDasharray={`${progress * 100} 100`} transform="rotate(-90 50 62)" />
        </svg>
      </div>
      <div className="tk-selfie-foot">
        {camErr ? <p className="tk-err">{camErr}</p> : (
          <>
            <b>{busy ? "Tekshirilmoqda…" : i < 0 ? "Kamera yoqilmoqda…" : PROMPTS[Math.min(i, PROMPTS.length - 1)]}</b>
            <div className="tk-dots">{PROMPTS.map((_, k) => <i key={k} className={k < i ? "done" : k === i ? "on" : ""} />)}</div>
            <small>Ko‘zoynak va niqobni yeching · yorug‘ joyda turing</small>
            <small>Rasm telefoningizda saqlanmaydi</small>
          </>
        )}
      </div>
    </div>
  );
}

function DocumentEntry({ token, name, setName, onBack, onDone }: { token: string; name: string; setName: (s: string) => void; onBack: () => void; onDone: () => void }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr("");
    try { await tapi("POST", `/tickets/${token}/activate-document`, { holder_name: name.trim() }); onDone(); }
    catch (e) { setErr(e instanceof TicketApiError ? Object.values(e.fields)[0] || e.message : "Xatolik"); setBusy(false); }
  };
  return (
    <div className="tk-narrow stack">
      <button className="tk-back" onClick={onBack}><Back size={16} /> Orqaga</button>
      <h1 className="h2">Hujjat bilan kirish</h1>
      <div className="card card-pad stack">
        <p className="muted">Biometrik ma’lumot saqlanmaydi. Kirishda nazoratchi pasport yoki ID-kartadagi ismni chiptadagi bilan solishtiradi — biroz ko‘proq vaqt oladi.</p>
        <div className="field"><label>Ism familiya — hujjatdagi kabi</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} />{err && <small className="tk-err">{err}</small>}</div>
      </div>
      <button className="btn btn-primary btn-lg btn-block" disabled={busy || name.trim().length < 3} onClick={go}>Tasdiqlash</button>
    </div>
  );
}
