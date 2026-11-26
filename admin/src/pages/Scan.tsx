import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import jsQR from "jsqr";
import { api, ApiError, blobUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtShort } from "@/lib/format";
import { I } from "@/components/Icons";
import type { MatchInfo } from "@/lib/tickets";
import "@/tickets.css";

/** K1–K7 · gate controller: camera QR scanner with face / document checks. Mobile-first, dark. */

type ScanMatch = { match: MatchInfo; gates: string[]; entry: Record<string, number>; face_mode: string; face_check: string; dynamic_qr: boolean };
type Ticket = { number: string; zone: string; zone_name: string; zone_kind: string; section: string; row: string; seat?: number; gate: string; holder_name: string; face_status: string };
type Res = {
  result: string; message: string; ticket?: Ticket; check_token?: string; face_check?: string; score?: number; threshold?: number;
  used_at?: string; used_gate?: string; used_by?: string; wrong_gate?: string; entered: number; total: number;
};

const KEY = "umfl.scan";
const GOOD = new Set(["ok", "face_ok", "doc_ok"]);
const WAIT = new Set(["face", "document"]);

type BD = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
declare global { interface Window { BarcodeDetector?: new (o: { formats: string[] }) => BD } }

export function ScanPage() {
  const { user, logout, can } = useAuth();
  const [matches, setMatches] = useState<ScanMatch[] | null>(null);
  const [err, setErr] = useState("");
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } })();
  const [mid, setMid] = useState<number | null>(saved.mid ?? null);
  const [gate, setGate] = useState<string>(saved.gate ?? "");
  const [started, setStarted] = useState(false);

  useEffect(() => {
    api.get<{ items: ScanMatch[] }>("/admin/scan/matches").then((d) => {
      setMatches(d.items);
      if (!d.items.some((m) => m.match.id === mid)) setMid(d.items[0]?.match.id ?? null);
    }).catch((e) => setErr(e instanceof ApiError ? e.message : "Xato"));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const m = matches?.find((x) => x.match.id === mid);
  const start = () => { try { localStorage.setItem(KEY, JSON.stringify({ mid, gate })); } catch { /* ignore */ } setStarted(true); };

  if (started && m) return <Scanner m={m} gate={gate} onExit={() => setStarted(false)} />;
  return (
    <div className="scan dark">
      <header className="scan-top">
        {can("tickets") ? <Link to="/tickets" className="scan-ico" aria-label="Orqaga"><I.back size={18} /></Link> : <span className="scan-ico"><I.qr size={18} /></span>}
        <div className="grow"><b>Kirish nazorati</b><small>{user?.name}</small></div>
        <button className="scan-ico" onClick={logout} aria-label="Chiqish"><I.logout size={18} /></button>
      </header>
      <div className="scan-setup">
        {err && <div className="scan-msg danger">{err}</div>}
        {!matches ? <div className="muted">Yuklanmoqda…</div> : matches.length === 0 ? (
          <div className="scan-msg">Yaqin 3 kun ichida chipta sotilgan match yo‘q.</div>
        ) : (
          <>
            <div className="scan-label">Match</div>
            {matches.map((x) => (
              <button key={x.match.id} className={`scan-opt${mid === x.match.id ? " on" : ""}`} onClick={() => { setMid(x.match.id); setGate(""); }}>
                <b>{x.match.title}</b><small>{x.match.kickoff_at ? fmtShort(x.match.kickoff_at) : ""}{x.match.venue ? " · " + x.match.venue : ""} · kirdi {x.entry.entered || 0} / {x.entry.active || 0}</small>
              </button>
            ))}
            {m && (
              <>
                <div className="scan-label">Darvoza</div>
                <div className="scan-gates">
                  {m.gates.map((g) => <button key={g} className={gate === g ? "on" : ""} onClick={() => setGate(g)}>{g}</button>)}
                  <button className={gate === "" ? "on" : ""} onClick={() => setGate("")}>Hammasi</button>
                </div>
                <div className="scan-hint">
                  {m.dynamic_qr ? "Dinamik QR: skrinshotlar qabul qilinmaydi. " : ""}
                  {m.face_mode !== "off" ? `Yuz tekshiruvi: ${m.face_mode === "vip" ? "faqat VIP" : "barcha chiptalar"}, ${m.face_check === "auto" ? "avtomatik" : "rasm bo‘yicha"}.` : ""}
                </div>
                <button className="scan-btn lime" onClick={start}><I.qr size={18} /> Skanerlashni boshlash</button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Scanner({ m, gate, onExit }: { m: ScanMatch; gate: string; onExit: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [camErr, setCamErr] = useState("");
  const [res, setRes] = useState<Res | null>(null);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState({ entered: m.entry.entered || 0, total: m.entry.active || 0 });
  const [manual, setManual] = useState(false);
  const [num, setNum] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [front, setFront] = useState(false);
  const last = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const paused = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  // camera
  useEffect(() => {
    let stream: MediaStream | null = null, stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: front ? "user" : "environment", width: { ideal: 1280 } }, audio: false });
        if (stop) return stream.getTracks().forEach((t) => t.stop());
        if (video.current) { video.current.srcObject = stream; await video.current.play().catch(() => {}); }
        setCamErr("");
      } catch {
        setCamErr("Kameraga ruxsat berilmadi. Brauzer sozlamalarida kamerani yoqing yoki raqamni qo‘lda kiriting.");
      }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [front]);

  const show = useCallback((r: Res) => {
    setRes(r);
    setCount({ entered: r.entered, total: r.total });
    try { navigator.vibrate?.(GOOD.has(r.result) ? 60 : WAIT.has(r.result) ? [40, 60, 40] : [200, 80, 200]); } catch { /* ignore */ }
    window.clearTimeout(timer.current);
    if (GOOD.has(r.result)) timer.current = window.setTimeout(() => { setRes(null); setPhoto(null); paused.current = false; }, 2600);
  }, []);

  const submit = useCallback(async (code: string) => {
    paused.current = true;
    setBusy(true);
    try {
      const r = await api.post<Res>("/admin/scan", { match_id: m.match.id, gate, code });
      show(r);
      if (r.check_token && r.face_check === "manual") setPhoto(await blobUrl(`/admin/scan/check/${r.check_token}/photo`).catch(() => null));
    } catch (e) {
      show({ result: "invalid", message: e instanceof ApiError ? e.message : "Tarmoq xatosi — qayta urinib ko‘ring", entered: count.entered, total: count.total });
    } finally { setBusy(false); }
  }, [m.match.id, gate, show, count]);

  // decode loop
  useEffect(() => {
    let raf = 0, alive = true, lastT = 0;
    const det = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
    const tick = async (t: number) => {
      if (!alive) return;
      raf = requestAnimationFrame(tick);
      if (paused.current || t - lastT < 160) return;
      lastT = t;
      const v = video.current, c = canvas.current;
      if (!v || !c || v.readyState < 2 || !v.videoWidth) return;
      let code = "";
      try {
        if (det) {
          const r = await det.detect(v);
          code = r[0]?.rawValue || "";
        } else {
          const s = Math.min(1, 640 / v.videoWidth);
          c.width = v.videoWidth * s; c.height = v.videoHeight * s;
          const ctx = c.getContext("2d", { willReadFrequently: true })!;
          ctx.drawImage(v, 0, 0, c.width, c.height);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data || "";
        }
      } catch { /* frame not ready */ }
      if (!code) return;
      const now = Date.now();
      if (code === last.current.code && now - last.current.at < 4000) return;
      last.current = { code, at: now };
      submit(code);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [submit]);

  const next = () => { window.clearTimeout(timer.current); setRes(null); setPhoto(null); paused.current = false; if (front) setFront(false); };

  const decide = async (decision: "accept" | "document" | "reject") => {
    if (!res?.check_token) return;
    setBusy(true);
    try { const r = await api.post<Res>(`/admin/scan/check/${res.check_token}/decision`, { decision });
      // after a decision "document" means «let in by document», not «check the document»
      show({ ...r, result: r.result === "document" ? "doc_ok" : r.result, ticket: res.ticket }); setPhoto(null); }
    catch (e) { show({ result: "invalid", message: e instanceof ApiError ? e.message : "Xato", entered: count.entered, total: count.total }); }
    finally { setBusy(false); }
  };

  const autoFace = async () => {
    const v = video.current, c = canvas.current;
    if (!res?.check_token || !v || !c) return;
    setBusy(true);
    try {
      const s = Math.min(1, 720 / v.videoWidth);
      c.width = v.videoWidth * s; c.height = v.videoHeight * s;
      c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("kadr"))), "image/jpeg", 0.85));
      const r = await api.post<Res>(`/admin/scan/check/${res.check_token}/face`, blob);
      if (r.result === "face_mismatch") {
        setRes({ ...r, ticket: res.ticket, check_token: res.check_token, face_check: "manual" });
        setPhoto(await blobUrl(`/admin/scan/check/${res.check_token}/photo`).catch(() => null));
        try { navigator.vibrate?.([200, 80, 200]); } catch { /* ignore */ }
      } else show({ ...r, ticket: res.ticket });
    } catch (e) {
      // face service down → fall back to the manual photo check
      setRes({ ...res, face_check: "manual", message: (e instanceof ApiError ? e.message + ". " : "") + "Rasm bo‘yicha solishtiring" });
      setPhoto(await blobUrl(`/admin/scan/check/${res.check_token}/photo`).catch(() => null));
    } finally { setBusy(false); }
  };

  const t = res?.ticket;
  const tone = !res ? "" : GOOD.has(res.result) ? "ok" : WAIT.has(res.result) ? "wait" : res.result === "used" || res.result === "stale" ? "warn" : "bad";
  const title: Record<string, string> = {
    ok: "Kirish mumkin", face_ok: "Kirish mumkin", doc_ok: "Kirish mumkin", document: "Hujjatni tekshiring", face: res?.face_check === "auto" ? "Yuzni tekshirish" : "Yuzni solishtiring",
    used: "Allaqachon ishlatilgan", stale: "QR eskirgan", invalid: "Yaroqsiz", cancelled: "Bekor qilingan", wrong_match: "Boshqa match",
    not_activated: "Faollashtirilmagan", face_mismatch: "Yuz mos kelmadi", rejected: "Rad etildi",
  };

  return (
    <div className="scan dark live">
      <video ref={video} className={`scan-video${front ? " mirror" : ""}`} playsInline muted />
      <canvas ref={canvas} hidden />
      <header className="scan-top over">
        <button className="scan-ico" onClick={onExit} aria-label="Orqaga"><I.back size={18} /></button>
        <div className="grow"><b>{m.match.title}</b><small>{gate ? `Darvoza ${gate}` : "Barcha darvozalar"}</small></div>
        <div className="scan-count"><b>{count.entered}</b><small>/ {count.total}</small></div>
      </header>

      {!res && (
        <>
          <div className="scan-frame"><i /><i /><i /><i /></div>
          <div className="scan-tip">{camErr || (busy ? "Tekshirilmoqda…" : "QR-kodni ramkaga keltiring")}</div>
          <div className="scan-bottom">
            <button className="scan-btn ghost" onClick={() => { paused.current = true; setManual(true); }}>Raqamni kiritish</button>
          </div>
        </>
      )}

      {manual && !res && (
        <div className="scan-sheet">
          <b>Chipta raqami</b>
          <small>QR o‘qilmasa: raqam chipta ostida yozilgan. Qo‘lda kiritilganda hujjat tekshiriladi</small>
          <input autoFocus className="scan-input" value={num} placeholder="UMFL-1012-OD-00012" onChange={(e) => setNum(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && num.trim() && (setManual(false), submit(num.trim()))} />
          <div className="row"><button className="scan-btn ghost grow" onClick={() => { setManual(false); paused.current = false; }}>Bekor</button>
            <button className="scan-btn lime grow" disabled={!num.trim() || busy} onClick={() => { setManual(false); submit(num.trim()); setNum(""); }}>Tekshirish</button></div>
        </div>
      )}

      {res && (
        <div className={`scan-result ${tone}`}>
          <div className="scan-res-head">
            <span className="scan-res-ico">{tone === "ok" ? <I.check size={30} /> : tone === "wait" ? <I.user size={28} /> : <I.x size={30} />}</span>
            <div><b>{title[res.result] || res.result}</b><small>{res.message}</small></div>
          </div>
          {res.wrong_gate && <div className="scan-msg warn">Bu chipta {res.wrong_gate}-darvoza uchun — yo‘naltiring</div>}
          {res.result === "used" && (res.used_at || res.used_gate) && <div className="scan-msg warn">Kirgan: {res.used_at ? fmtShort(res.used_at) : ""} · darvoza {res.used_gate || "—"}{res.used_by ? " · " + res.used_by : ""}. Ikkinchi odam kira olmaydi.</div>}
          {res.score != null && <div className="scan-msg">Moslik: <b>{res.score}%</b> (chegara {res.threshold}%)</div>}
          {t && (
            <div className={`scan-ticket ${t.zone_kind === "vip" ? "vip" : ""}`}>
              {photo && res.face_check === "manual" && <img src={photo} alt="Chipta egasi" className="scan-photo" />}
              <div className="grow">
                <span className="scan-zone">{t.zone_name}</span>
                <b>{t.holder_name || "Ism ko‘rsatilmagan"}</b>
                <small>{t.section ? `Sektor ${t.section}` : ""}{t.row ? `, ${t.row}-qator` : ""}{t.seat ? `, ${t.seat}-o‘rin` : t.section && !t.row ? " · erkin o‘rindiq" : ""}{t.gate ? ` · kirish ${t.gate}` : ""}</small>
                <small className="mono">{t.number}</small>
              </div>
            </div>
          )}
          {res.result === "face" && res.face_check === "auto" && (
            <>
              <div className="scan-msg">Kamerani mehmonning yuziga qarating va tugmani bosing</div>
              <div className="row"><button className="scan-btn ghost" onClick={() => setFront(!front)}>Kamera</button><button className="scan-btn lime grow" disabled={busy} onClick={autoFace}>{busy ? "Solishtirilmoqda…" : "Yuzni tekshirish"}</button></div>
              <button className="scan-btn ghost" disabled={busy} onClick={() => decide("document")}>Hujjat bilan o‘tkazish</button>
            </>
          )}
          {(res.result === "face" && res.face_check === "manual") || res.result === "face_mismatch" ? (
            <>
              {!photo && <div className="scan-msg">Rasm yuklanmoqda…</div>}
              <div className="row"><button className="scan-btn red grow" disabled={busy} onClick={() => decide("reject")}>Mos emas</button><button className="scan-btn lime grow" disabled={busy} onClick={() => decide("accept")}>Mos — o‘tkazish</button></div>
              <button className="scan-btn ghost" disabled={busy} onClick={() => decide("document")}>Hujjat bilan tekshirdim</button>
            </>
          ) : null}
          {res.result === "document" && (
            <>
              <div className="scan-msg">{t?.holder_name ? "Pasport yoki ID-kartadagi ism chiptadagi bilan bir xil bo‘lsin" : "Chipta ismsiz: mehmon telefonida chipta sahifasini yoki to‘lov SMS’ini ko‘rsatsin"}</div>
              <div className="row"><button className="scan-btn red grow" disabled={busy} onClick={() => decide("reject")}>Mos emas</button><button className="scan-btn lime grow" disabled={busy} onClick={() => decide("document")}>{t?.holder_name ? "Hujjat mos — o‘tkazish" : "Tasdiqlash — o‘tkazish"}</button></div>
            </>
          )}
          {!WAIT.has(res.result) && res.result !== "face_mismatch" && <button className="scan-btn" onClick={next}>Keyingi</button>}
          {res.result === "stale" && <div className="scan-hint">Mehmondan chipta sahifasini ochib, jonli (harakatlanuvchi) QR ko‘rsatishini so‘rang.</div>}
          {res.result === "not_activated" && <div className="scan-hint">Mehmon saytda chiptani selfi bilan faollashtirishi yoki kassaga murojaat qilishi kerak.</div>}
        </div>
      )}
    </div>
  );
}
