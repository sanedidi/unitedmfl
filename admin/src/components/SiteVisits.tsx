import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "@/lib/api";
import { I } from "@/components/Icons";

// «Sayt tashriflari» on the Dashboard and the «N onlayn» counter in the topbar.
// Numbers come from GET /admin/visitors (see backend/internal/api/visits.go).

type Period = "today" | "7d" | "30d";
type Totals = { visitors: number; views: number; prev_visitors: number };
type Point = { label: string; visitors: number | null; views: number | null };
export type Online = { total: number; match: number };
type Stats = {
  period: Period;
  online: Online;
  t_today: Totals;
  t_7d: Totals;
  t_30d: Totals;
  series: Point[];
  pages: { path: string; title: string; views: number }[];
  sources: { source: string; visits: number }[];
  from: string;
  to: string;
};

const REFRESH_MS = 30_000;
const PERIODS: { id: Period; label: string }[] = [{ id: "today", label: "Bugun" }, { id: "7d", label: "7 kun" }, { id: "30d", label: "30 kun" }];
const SOURCE: Record<string, { label: string; color: string }> = {
  instagram: { label: "Instagram", color: "var(--accent)" },
  telegram: { label: "Telegram", color: "var(--n-900)" },
  google: { label: "Google", color: "var(--n-400)" },
  direct: { label: "To‘g‘ridan kirish", color: "var(--n-200)" },
  yandex: { label: "Yandex", color: "var(--n-600)" },
  facebook: { label: "Facebook", color: "var(--blue-600)" },
  youtube: { label: "YouTube", color: "var(--red-500)" },
  tiktok: { label: "TikTok", color: "var(--n-700)" },
  other: { label: "Boshqa saytlar", color: "var(--n-300)" },
};
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const MON3 = ["yan", "fev", "mar", "apr", "may", "iyun", "iyul", "avg", "sen", "okt", "noy", "dek"];

const num = (n: number) => new Intl.NumberFormat("ru-RU").format(n).replace(/\s/g, " ");
const dayParts = (d: string) => { const [, m, dd] = d.split("-").map(Number); return { m, d: dd }; };
const longDate = (d: string) => { const p = dayParts(d); return `${p.d} ${MONTHS[p.m - 1]}`; };
const shortDate = (d: string) => { const p = dayParts(d); return `${p.d} ${MON3[p.m - 1]}`; };

/** Polls fn every 30 s while the tab is visible; keeps the last data while reloading. */
function usePolling<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await fn();
      if (my === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (my === seq.current) setError(e);
    }
  }, deps);
  useEffect(() => {
    load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);
  return { data, error, reload: load };
}

/** «23 onlayn» in the topbar; opens the Dashboard block. */
export function OnlinePill() {
  const { data, error } = usePolling(() => api.get<Online>("/admin/visitors/online"), []);
  const n = error || !data ? "—" : num(data.total);
  const live = !!data && !error && data.total > 0;
  return (
    <Link to="/#tashriflar" className={`online-pill${live ? " live" : ""}`} title="Hozir saytda (so‘nggi 5 daqiqa)">
      <span className="dot" aria-hidden /> <b className="tnum">{n}</b> onlayn
    </Link>
  );
}

export function SiteVisits() {
  const [period, setPeriod] = useState<Period>("30d");
  const { data, error, reload } = usePolling(() => api.get<Stats>(`/admin/visitors?period=${period}`), [period]);
  const ref = useRef<HTMLDivElement>(null);
  const shown = data && data.period === period ? data : undefined;

  // the topbar counter links here
  useEffect(() => {
    if (window.location.hash === "#tashriflar" && data) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [!!data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card visits" id="tashriflar" ref={ref}>
      <div className="visits-head">
        <div>
          <h2>Sayt tashriflari</h2>
          <div className="small muted">unitedmfl.uz · har 30 soniyada yangilanadi</div>
        </div>
        <div className="seg" role="group" aria-label="Davr">
          {PERIODS.map((p) => <button key={p.id} type="button" aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>{p.label}</button>)}
        </div>
      </div>
      {error && !data ? (
        <div className="visits-state">
          <span className="icon"><I.alert size={20} /></span>
          <b>Ma’lumotni yuklab bo‘lmadi</b>
          <span className="small muted">Server javob bermadi. Internet aloqasini tekshirib, qayta urinib ko‘ring.</span>
          <button className="btn btn-sm" onClick={reload}>Qayta urinish</button>
        </div>
      ) : !data ? (
        <div className="visits-skeleton" aria-label="Yuklanmoqda"><i /><i /><i /><i /></div>
      ) : (
        <>
          <div className="visits-metrics">
            <div className="vm vm-online">
              <span className="vm-label"><span className="dot" aria-hidden /> Hozir onlayn</span>
              <span className="vm-val tnum">{num(data.online.total)}</span>
              <span className="small">so‘nggi 5 daqiqada saytda faol</span>
              {data.online.match > 0 && <span className="small muted">{num(data.online.match)} tasi match sahifasida</span>}
            </div>
            <Metric label="Bugun" t={data.t_today} vs="kechaning shu vaqtiga nisbatan" />
            <Metric label="7 kun" t={data.t_7d} vs="oldingi 7 kunga nisbatan" />
            <Metric label="30 kun" t={data.t_30d} vs="oldingi 30 kunga nisbatan" />
          </div>
          {!data.t_30d.views && !data.online.total ? (
            <div className="visits-state">
              <span className="icon"><I.eye size={20} /></span>
              <b>Hozircha tashriflar yo‘q</b>
              <span className="small muted">Birinchi tashrif saytda ochilgandan keyin bir necha soniyada shu yerda ko‘rinadi.</span>
            </div>
          ) : shown ? (
            <div className="visits-lower">
              <Chart s={shown} />
              <div className="visits-side">
                <Pages s={shown} />
                <Sources s={shown} />
              </div>
            </div>
          ) : (
            <div className="visits-skeleton short" aria-label="Yuklanmoqda"><i /><i /></div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, t, vs }: { label: string; t: Totals; vs: string }) {
  const pct = t.prev_visitors > 0 ? Math.round(((t.visitors - t.prev_visitors) / t.prev_visitors) * 100) : null;
  return (
    <div className="vm">
      <span className="vm-label">{label}</span>
      <span className="vm-val tnum">{num(t.visitors)}</span>
      {pct == null ? <span className="small muted">taqqoslash uchun ma’lumot yo‘q</span>
        : <span className={`small ${pct > 0 ? "up" : pct < 0 ? "down" : "muted"}`}>{pct > 0 ? "↑" : pct < 0 ? "↓" : "="} {Math.abs(pct)}% {vs}</span>}
      <span className="small muted">{num(t.views)} sahifa ko‘rish</span>
    </div>
  );
}

function Chart({ s }: { s: Stats }) {
  const [hover, setHover] = useState<number | null>(null);
  const hourly = s.period === "today";
  const max = Math.max(1, ...s.series.map((p) => p.visitors ?? 0));
  const top = niceMax(max);
  const lastFilled = s.series.reduce((acc, p, i) => (p.visitors != null ? i : acc), -1);
  // x labels: "both", desktop only ("desk") or phone only ("phone")
  type Tick = [number, "both" | "desk" | "phone"];
  const n = s.series.length;
  const ticks: Tick[] = hourly ? [[0, "both"], [6, "desk"], [12, "both"], [18, "desk"], [23, "both"]]
    : n <= 7 ? s.series.map((_, i): Tick => [i, i % 3 === 0 ? "both" : "desk"])
    : ([[0, "both"], [6, "desk"], [12, "desk"], [15, "phone"], [18, "desk"], [24, "desk"], [n - 1, "both"]] as Tick[]).filter(([i]) => i < n);
  const label = (i: number) => (i === lastFilled ? (hourly ? "Hozir" : "Bugun") : hourly ? s.series[i].label : shortDate(s.series[i].label));
  const h = hover != null ? s.series[hover] : null;
  return (
    <div className="visits-chart">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="b">{hourly ? "Soatlar bo‘yicha tashrifchilar" : "Kunlik tashrifchilar"}</div>
          <div className="small muted">{hourly ? `Bugun, ${longDate(s.to)}` : `${longDate(s.from)} — ${longDate(s.to)}`}</div>
        </div>
        <div className="row small" style={{ gap: 16 }}>
          <span className="legend"><i style={{ background: "var(--accent)" }} />{hourly ? "Joriy soat" : "Bugun"}</span>
          <span className="legend"><i style={{ background: "var(--n-900)" }} />{hourly ? "Oldingi soatlar" : "Oldingi kunlar"}</span>
        </div>
      </div>
      <div className="vc-body">
        <div className="vc-y small muted tnum"><span>{num(top)}</span><span>{num(Math.round(top / 2))}</span><span>0</span></div>
        <div className="vc-plot-wrap">
          <div className="vc-plot" onMouseLeave={() => setHover(null)}>
            {s.series.map((p, i) => (
              <button key={p.label} type="button" className={`vc-bar${i === lastFilled ? " now" : ""}${p.visitors == null ? " future" : ""}`}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                aria-label={`${hourly ? p.label : longDate(p.label)}: ${p.visitors ?? 0} tashrifchi`}>
                <i style={{ height: `${((p.visitors ?? 0) / top) * 100}%` }} />
              </button>
            ))}
            {h && hover != null && (
              <div className="vc-tip" style={tipPos(hover, n)}>
                {hourly ? h.label : longDate(h.label)} · {num(h.visitors ?? 0)} tashrifchi · {num(h.views ?? 0)} ko‘rish
              </div>
            )}
          </div>
          <div className="vc-x small muted">
            {ticks.map(([i, on]) => <span key={i} className={on === "both" ? undefined : on} style={{ left: `${((i + 0.5) / n) * 100}%` }}>{label(i)}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Keeps the tooltip inside the chart near its edges. */
function tipPos(i: number, n: number): React.CSSProperties {
  const share = (i + 0.5) / n;
  if (share < 0.25) return { left: 0 };
  if (share > 0.75) return { right: 0 };
  return { left: `${share * 100}%`, transform: "translateX(-50%)" };
}

function niceMax(n: number) {
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * pow >= n) return m * pow;
  return 10 * pow;
}

const periodLabel = (p: Period) => (p === "today" ? "Bugun" : p === "7d" ? "7 kun" : "30 kun");

function Pages({ s }: { s: Stats }) {
  const max = Math.max(1, ...s.pages.map((p) => p.views));
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}><b>Ommabop sahifalar</b><span className="small muted">{periodLabel(s.period)} · ko‘rishlar</span></div>
      {!s.pages.length && <span className="small muted">Bu davrda ko‘rishlar yo‘q</span>}
      {s.pages.map((p) => (
        <div key={p.path} className="vp-row">
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="grow">
              <div className="ellipsis">{p.title}</div>
              <a className="small muted ellipsis" href={`${SITE}${p.path}`} target="_blank" rel="noopener noreferrer">{p.path}</a>
            </div>
            <b className="tnum">{num(p.views)}</b>
          </div>
          <div className="vp-track"><i style={{ width: `${(p.views / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function Sources({ s }: { s: Stats }) {
  const total = s.sources.reduce((a, x) => a + x.visits, 0);
  const pct = (v: number) => Math.round((v / total) * 100);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}><b>Qayerdan kelishadi</b><span className="small muted">{periodLabel(s.period)}</span></div>
      {!total ? <span className="small muted">Bu davrda ma’lumot yo‘q</span> : (
        <>
          <div className="vs-bar">{s.sources.map((x) => <i key={x.source} style={{ flexGrow: x.visits, background: (SOURCE[x.source] || SOURCE.other).color }} title={`${(SOURCE[x.source] || SOURCE.other).label}: ${pct(x.visits)}%`} />)}</div>
          <div className="stack" style={{ gap: 8 }}>
            {s.sources.map((x) => (
              <div key={x.source} className="row" style={{ justifyContent: "space-between" }}>
                <span className="legend"><i style={{ background: (SOURCE[x.source] || SOURCE.other).color }} />{(SOURCE[x.source] || SOURCE.other).label}</span>
                <span className="tnum muted">{pct(x.visits)}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// same as SITE_URL in Layout (not imported: Layout imports this file)
const SITE = (import.meta.env.VITE_SITE_URL as string | undefined) || "https://unitedmfl.com";
