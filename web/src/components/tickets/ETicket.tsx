"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { Pin, Refresh } from "./ui";
import { fmtSum, tapi, TicketApiError, type MatchBrief, type TicketV } from "@/lib/tickets";
import { fmtTime, TZ } from "@/lib/format";

const day = (iso: string | null) => (iso ? new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso)) : "—");

export function QR({ value, size = 132, dark = false }: { value: string; size?: number; dark?: boolean }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let live = true;
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0B0D10", light: "#FFFFFF" } }).then((s) => live && setSvg(s));
    return () => { live = false; };
  }, [value]);
  return <div className={`tk-qr${dark ? " dark" : ""}`} style={{ width: size, height: size }} aria-label="QR-kod" role="img" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Live QR: fetched from the server, re-fetched when the 30-second window rolls over. */
export function LiveQR({ token, size = 168, onState }: { token: string; size?: number; onState?: (s: string) => void }) {
  const [code, setCode] = useState("");
  const [dynamic, setDynamic] = useState(true);
  const [left, setLeft] = useState(0);
  const [err, setErr] = useState("");
  const until = useRef(0);
  useEffect(() => {
    let alive = true, t: number | undefined;
    const pull = async () => {
      try {
        const r = await tapi<{ code: string; dynamic: boolean; seconds_left: number; status: string }>("GET", `/tickets/${token}/qr`);
        if (!alive) return;
        setCode(r.code); setDynamic(r.dynamic); setErr(""); onState?.(r.status);
        until.current = Date.now() + r.seconds_left * 1000;
        if (r.dynamic) t = window.setTimeout(pull, Math.max(1, r.seconds_left) * 1000 + 300);
      } catch (e) {
        if (!alive) return;
        setErr(e instanceof TicketApiError ? e.message : "QR yuklanmadi");
        t = window.setTimeout(pull, 5000);
      }
    };
    pull();
    const tick = window.setInterval(() => setLeft(Math.max(0, Math.ceil((until.current - Date.now()) / 1000))), 250);
    const vis = () => { if (document.visibilityState === "visible") { window.clearTimeout(t); pull(); } };
    document.addEventListener("visibilitychange", vis);
    return () => { alive = false; window.clearTimeout(t); window.clearInterval(tick); document.removeEventListener("visibilitychange", vis); };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="tk-live">
      {code ? <QR value={code} size={size} /> : <div className="tk-qr" style={{ width: size, height: size }}>{err || "…"}</div>}
      {dynamic && code && (
        <div className="tk-live-bar"><Refresh size={14} /> QR har 30 soniyada yangilanadi <b>0:{String(left).padStart(2, "0")}</b><i style={{ width: `${(left / 30) * 100}%` }} /></div>
      )}
    </div>
  );
}

export function ETicket({ t, match, qr, foot }: { t: TicketV; match: MatchBrief; qr?: ReactNode; foot?: ReactNode }) {
  const vip = t.zone_kind === "vip";
  const [home, away] = splitTitle(match.title);
  return (
    <article className={`tk-eticket${vip ? " vip" : ""}${t.status !== "active" && t.status !== "used" ? " void" : ""}`}>
      <header><span className="tk-brand"><i />UNITED MFL</span><span>{t.zone_name}</span></header>
      <div className="tk-et-body">
        <div className="tk-et-stage">{match.stage ? `${match.stage} · ` : ""}United MFL 2026</div>
        <div className="tk-et-teams"><b>{home}</b>{away && <><span>vs</span><b>{away}</b></>}</div>
        <dl>
          <div><dt>Sana</dt><dd>{day(match.kickoff_at)}</dd></div>
          <div><dt>Vaqt</dt><dd>{match.kickoff_at ? fmtTime(match.kickoff_at) : "—"}</dd></div>
          <div><dt>Darvoza</dt><dd>{t.gate || "—"}</dd></div>
          <div><dt>Sektor</dt><dd>{t.section.includes(",") ? "Istalgan" : t.section}</dd></div>
          <div><dt>Qator</dt><dd>{t.row || "—"}</dd></div>
          <div><dt>O‘rin</dt><dd>{t.seat ?? "Erkin"}</dd></div>
        </dl>
        {match.venue && <p className="tk-et-venue"><Pin size={14} /> {match.venue}</p>}
        {vip && (t.perks || []).filter(Boolean).length > 0 && <div className="tk-et-perks">{(t.perks || []).filter(Boolean).map((p) => <span key={p}>{p}</span>)}</div>}
      </div>
      <div className="tk-et-tear" />
      <div className="tk-et-bottom">
        {qr}
        <dl>
          <div><dt>Chipta egasi</dt><dd>{t.holder_name || "—"}</dd></div>
          <div><dt>Chipta №</dt><dd className="mono">{t.number}</dd></div>
          <div><dt>Narx</dt><dd>{fmtSum(t.price)}</dd></div>
        </dl>
      </div>
      {foot && <footer>{foot}</footer>}
    </article>
  );
}

function splitTitle(t: string): [string, string] {
  const p = t.split(" — ");
  return p.length === 2 ? [p[0], p[1]] : [t, ""];
}
