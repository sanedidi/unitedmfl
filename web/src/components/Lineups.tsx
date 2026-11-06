"use client";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Crest } from "./Crest";
import { Ball, Close, Swap } from "./Icons";
import { matchMinute, POSITION_LABEL } from "@/lib/format";
import { minutesPlayed, roleText, slotPoint, surname, teamLineup, type LPlayer, type Side, type TeamLineup } from "@/lib/lineup";
import { playerPath } from "@/lib/seo";
import type { MatchDetail, MatchEvent, TeamRef } from "@/lib/types";

type View = "both" | Side;
type Mode = "start" | "current" | "bench";

const M = 3, W = 74, H = 111;
const at = (x: number, y: number) => ({ left: `${((M + x) / W) * 100}%`, top: `${((M + y) / H) * 100}%` });
const min = (e: MatchEvent) => (e.extra_minute ? `${e.minute}+${e.extra_minute}′` : `${e.minute}′`);

const EV_TEXT: Record<string, string> = {
  goal: "Gol", penalty_goal: "Gol (penalti)", own_goal: "Avtogol", penalty_missed: "Penalti amalga oshmadi",
  yellow: "Sariq kartochka", second_yellow: "Ikkinchi sariq → qizil", red: "Qizil kartochka",
};

/* ---------- small marks ---------- */
function CardMark({ red }: { red?: boolean }) {
  return <span className={red ? "card-r" : "card-y"} aria-hidden />;
}
function SubArrow({ dir }: { dir: "in" | "out" }) {
  return <span className={`lu-arrow ${dir}`} aria-hidden>{dir === "in" ? "↑" : "↓"}</span>;
}

function EventChips({ p, showIn = true }: { p: LPlayer; showIn?: boolean }) {
  const { ev } = p;
  return (
    <span className="lu-chips">
      {ev.goals.map((e) => <span key={e.id} className="lu-chip" title={EV_TEXT[e.type]}><Ball size={13} />{min(e)}</span>)}
      {ev.ownGoals.map((e) => <span key={e.id} className="lu-chip og" title="Avtogol"><Ball size={13} />{min(e)}</span>)}
      {ev.missed.map((e) => <span key={e.id} className="lu-chip miss" title="Penalti amalga oshmadi"><Ball size={13} />{min(e)}</span>)}
      {ev.yellow && <span className="lu-chip" title="Sariq kartochka"><CardMark />{min(ev.yellow)}</span>}
      {ev.red && <span className="lu-chip" title={EV_TEXT[ev.red.type]}><CardMark red />{min(ev.red)}</span>}
      {ev.subOut && <span className="lu-chip" title="Almashtirildi"><SubArrow dir="out" />{min(ev.subOut)}</span>}
      {showIn && ev.subIn && <span className="lu-chip" title="Maydonga tushdi"><SubArrow dir="in" />{min(ev.subIn)}</span>}
    </span>
  );
}

function Avatar({ p, size = 32 }: { p: LPlayer; size?: number }) {
  return p.photo_url
    ? <img className="lu-ava" src={p.photo_url} alt="" width={size} height={size} loading="lazy" style={{ width: size, height: size }} />
    : <span className="lu-ava" style={{ width: size, height: size }} aria-hidden><svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0116 0" /></svg></span>;
}

/* ---------- pitch ---------- */
function pitchLines() {
  const r = (n: number) => +n.toFixed(2);
  const rect = (x1: number, y1: number, x2: number, y2: number) => `M${r(M + x1)} ${r(M + y1)}H${r(M + x2)}V${r(M + y2)}H${r(M + x1)}Z`;
  const dx = Math.sqrt(9.15 ** 2 - 5.5 ** 2);
  return [
    rect(0, 0, 68, 105), `M${M} ${M + 52.5}H${M + 68}`,
    rect(13.84, 0, 54.16, 16.5), rect(13.84, 88.5, 54.16, 105), rect(24.84, 0, 43.16, 5.5), rect(24.84, 99.5, 43.16, 105),
    `M${r(M + 34 - dx)} ${M + 16.5}A9.15 9.15 0 0 0 ${r(M + 34 + dx)} ${M + 16.5}`, `M${r(M + 34 - dx)} ${M + 88.5}A9.15 9.15 0 0 1 ${r(M + 34 + dx)} ${M + 88.5}`,
    rect(30.34, -1.8, 37.66, 0), rect(30.34, 105, 37.66, 106.8),
  ].join("");
}
const LINES = pitchLines();

type Placed = { p: LPlayer; side: Side; x: number; y: number };

function place(t: TeamLineup, mode: "full" | "half"): Placed[] {
  const f = t.formation;
  if (!f) return [];
  return t.onPitch.filter((p) => p.slot != null && f.slots[p.slot]).map((p) => {
    const pt = slotPoint(f, p.slot!, mode);
    return t.side === "home" ? { p, side: t.side, x: pt.x, y: pt.y } : { p, side: t.side, x: 68 - pt.x, y: 105 - pt.y };
  });
}

function Marker({ m, current, selected, onSelect }: { m: Placed; current: boolean; selected: boolean; onSelect: () => void }) {
  const { p } = m;
  const out = !current && p.ev.subOut;
  const sentOff = !!p.ev.red;
  return (
    <button type="button" className={`lu-mk ${m.side}${selected ? " sel" : ""}${current && sentOff ? " off" : ""}`} style={at(m.x, m.y)} onClick={onSelect}
      aria-label={`${p.number ?? ""} ${p.player_name}, ${roleText(p, POSITION_LABEL)}`} aria-pressed={selected}>
      <span className="disc">
        {p.number ?? "–"}
        {p.is_captain && <i className="cap">C</i>}
        <span className="badges">
          {(p.ev.goals.length > 0 || p.ev.ownGoals.length > 0) && <i className="b goal"><Ball size={10} />{p.ev.goals.length > 1 && <em>{p.ev.goals.length}</em>}</i>}
          {p.ev.red ? <i className="b card r" /> : p.ev.yellow ? <i className="b card y" /> : null}
          {out && <i className="b sub out">↓</i>}
          {current && p.subbedIn && <i className="b sub in">↑</i>}
        </span>
      </span>
      <span className="nm">{surname(p.player_name)}</span>
    </button>
  );
}

/* ---------- player popover / sheet ---------- */
function PlayerCard({ p, team, liveMinute, d, onClose, pos }: { p: LPlayer; team: TeamRef | null; liveMinute: number; d: MatchDetail; onClose: () => void; pos?: { x: number; y: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const out = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest(".lu-mk, .lu-list li")) onClose();
    };
    document.addEventListener("keydown", k);
    document.addEventListener("mousedown", out);
    ref.current?.focus({ preventScroll: true });
    return () => { document.removeEventListener("keydown", k); document.removeEventListener("mousedown", out); };
  }, [onClose]);
  const played = minutesPlayed(p, d.match, liveMinute);
  const cards = (p.ev.yellow ? 1 : 0) + (p.ev.red ? 1 : 0);
  const style = pos ? (pos.x > 34 ? { right: `${100 - ((M + pos.x) / W) * 100 + 4}%` } : { left: `${((M + pos.x) / W) * 100 + 4}%` }) : undefined;
  const top = pos ? { top: `clamp(8px, calc(${((M + pos.y) / H) * 100}% - 120px), calc(100% - 330px))` } : undefined;
  return (
    <>
      {!pos && <div className="lu-scrim" aria-hidden />}
      <div ref={ref} tabIndex={-1} role="dialog" aria-label={p.player_name} className={`lu-pop${pos ? " anchored" : ""}`} style={{ ...style, ...top }}>
        <div className="lu-pop-head">
          <Avatar p={p} size={44} />
          <div style={{ minWidth: 0 }}>
            <div className="lu-pop-name"><b className="tnum">{p.number ?? "–"}</b> {p.player_name}</div>
            <div className="lu-pop-sub"><Crest team={team} size={16} /> {team?.name} · {roleText(p, POSITION_LABEL)}{p.is_captain ? " · Kapitan" : ""}</div>
          </div>
          <button type="button" className="lu-x" onClick={onClose} aria-label="Yopish"><Close size={18} /></button>
        </div>
        <div className="lu-stats">
          <div><b>{p.ev.goals.length}</b><span>Gol</span></div>
          <div><b>{cards}</b><span>Kartochka</span></div>
          <div><b>{played == null ? "—" : `${played}′`}</b><span>Maydonda</span></div>
        </div>
        <div className="lu-pop-ev">
          <div className="overline">Matchdagi voqealar</div>
          {p.ev.all.length === 0 ? <div className="muted small">Voqealar yo‘q</div> : p.ev.all.map((e) => (
            <div key={e.id} className="row small" style={{ gap: 8 }}>
              {e.type === "sub" ? <Swap size={14} /> : e.type.includes("yellow") ? <CardMark /> : e.type === "red" ? <CardMark red /> : <Ball size={14} />}
              <span className="tnum">{min(e)}</span>
              <span>{e.type === "sub" ? (e.related_player_name === p.player_name ? `Almashtirildi → ${e.player_name}` : `Maydonga tushdi ← ${e.related_player_name}`) : EV_TEXT[e.type] || e.type}{e.note && e.type !== "sub" ? ` · ${e.note}` : ""}</span>
            </div>
          ))}
        </div>
        {p.player_id && <Link className="btn btn-ghost btn-block" href={playerPath({ id: p.player_id, full_name: p.player_name })}>O‘yinchi profili</Link>}
      </div>
    </>
  );
}

/* ---------- team column ---------- */
function TeamCard({ t, team, mode, selected, onSelect }: { t: TeamLineup; team: TeamRef | null; mode: "start" | "current"; selected: string | null; onSelect: (p: LPlayer) => void }) {
  const list = mode === "current" ? [...t.onPitch].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99)) : t.starters;
  return (
    <section className="card lu-team">
      <header className="lu-team-head">
        <Crest team={team} size={40} />
        <div style={{ minWidth: 0 }}>
          <div className="overline lu-side"><span className={`dot ${t.side}`} />{t.side === "home" ? "Uy egasi" : "Mehmon"}</div>
          <h3 className="lu-team-name">{team?.name || "—"}</h3>
        </div>
        {t.code && <div className="lu-scheme"><span className="overline">Sxema</span><b>{t.code}</b></div>}
      </header>
      <div className="overline lu-cap">{mode === "current" ? "Joriy tarkib" : "Asosiy tarkib"}</div>
      <ul className="lu-list">
        {list.map((p) => (
          <li key={p.key} className={selected === p.key ? "sel" : ""} onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) onSelect(p); }}>
            <Avatar p={p} />
            <span className="num tnum">{p.number ?? "–"}</span>
            <span className="who">
              <span className="row" style={{ gap: 6 }}>
                {p.player_id ? <Link href={playerPath({ id: p.player_id, full_name: p.player_name })}>{p.player_name}</Link> : <span>{p.player_name}</span>}
                {p.is_captain && <span className="cap" title="Kapitan">C</span>}
              </span>
              <small>{p.subbedIn && p.ev.subIn ? `${p.ev.subIn.related_player_name} o‘rniga` : roleText(p, POSITION_LABEL)}</small>
            </span>
            <EventChips p={p} showIn={mode === "current"} />
          </li>
        ))}
      </ul>
      {(t.meta?.coach || t.meta?.assistant) && (
        <footer className="lu-coach">
          {t.meta?.coach && <div><span>Bosh murabbiy</span><b>{t.meta.coach}</b></div>}
        </footer>
      )}
    </section>
  );
}

function BenchCard({ teams, refs }: { teams: TeamLineup[]; refs: Record<Side, TeamRef | null> }) {
  return (
    <section className="card lu-bench">
      <header className="lu-card-head">
        <h3 className="h4">Zaxiradagilar</h3>
        <span className="small muted">Almashtirishlar: {teams.map((t) => `${refs[t.side]?.name || "—"} — ${t.subs}`).join(", ")}</span>
      </header>
      <div className="lu-bench-cols">
        {teams.map((t) => (
          <div key={t.side}>
            <div className="row lu-bench-team"><Crest team={refs[t.side]} size={20} /> {refs[t.side]?.name}</div>
            {t.bench.length === 0 ? <p className="muted small" style={{ margin: "8px 0" }}>Zaxira kiritilmagan</p> : (
              <ul className="lu-list compact">
                {t.bench.map((p) => (
                  <li key={p.key}>
                    <Avatar p={p} />
                    <span className="num tnum">{p.number ?? "–"}</span>
                    <span className="who">
                      {p.player_id ? <Link href={playerPath({ id: p.player_id, full_name: p.player_name })}>{p.player_name}</Link> : <span>{p.player_name}</span>}
                      <small>{p.replaced ? `${surname(p.replaced)} o‘rniga` : roleText(p, POSITION_LABEL)}</small>
                    </span>
                    {p.ev.subIn ? <span className="lu-chip"><SubArrow dir="in" />{min(p.ev.subIn)}</span> : <span className="small muted">Zaxirada</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Legend({ refs }: { refs: Record<Side, TeamRef | null> }) {
  return (
    <section className="card card-pad lu-legend" aria-label="Belgilar">
      <div className="overline">Belgilar</div>
      <div className="lu-legend-row">
        <span><Ball size={14} /> Gol</span>
        <span className="og"><Ball size={14} /> Avtogol</span>
        <span className="miss"><Ball size={14} /> Penalti amalga oshmadi</span>
        <span><CardMark /> Sariq kartochka</span>
        <span><CardMark red /> Qizil kartochka</span>
        <span><SubArrow dir="in" /> Maydonga tushdi</span>
        <span><SubArrow dir="out" /> Almashtirildi</span>
        <span><span className="cap">C</span> Kapitan</span>
        <span><span className="dot home" /> {refs.home?.name || "Uy egalari"} — uy egasi</span>
        <span><span className="dot away" /> {refs.away?.name || "Mehmonlar"} — mehmon</span>
      </div>
    </section>
  );
}

/* ---------- main ---------- */
export function Lineups({ d, live, serverOffset }: { d: MatchDetail; live: boolean; serverOffset: number }) {
  const m = d.match;
  const hasSubs = d.events.some((e) => e.type === "sub" || e.type === "formation");
  const [mode, setMode] = useState<Mode>(live && hasSubs ? "current" : "start");
  const [view, setView] = useState<View>("both");
  const [sel, setSel] = useState<{ side: Side; key: string } | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 720px)");
    const f = () => setNarrow(q.matches);
    f();
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, []);

  const pitchView: "start" | "current" = mode === "current" ? "current" : "start";
  const home = useMemo(() => teamLineup("home", d.lineups, d.lineup_meta, d.events, pitchView), [d, pitchView]);
  const away = useMemo(() => teamLineup("away", d.lineups, d.lineup_meta, d.events, pitchView), [d, pitchView]);
  const refs: Record<Side, TeamRef | null> = { home: m.home, away: m.away };
  const liveMinute = parseInt(matchMinute(m, Date.now(), serverOffset)) || 0;

  if (!d.lineups.length) {
    return (
      <section className="card card-pad lu-empty">
        <h2 className="h4">Tarkiblar hali e’lon qilinmagan</h2>
        <p className="muted" style={{ margin: "8px 0 0" }}>Jamoalar tarkibi odatda match boshlanishidan oldin e’lon qilinadi. Sahifa avtomatik yangilanadi.</p>
      </section>
    );
  }

  const shown = view === "both" ? [home, away] : [view === "home" ? home : away];
  const canPitch = shown.every((t) => t.formation && t.onPitch.some((p) => p.slot != null));
  const placed = canPitch ? shown.flatMap((t) => place(t, view === "both" ? "half" : "full")) : [];
  const all = [...home.starters, ...home.bench, ...home.onPitch, ...away.starters, ...away.bench, ...away.onPitch];
  const selP = sel ? all.find((p) => p.key === sel.key) || null : null;
  const selPos = sel ? placed.find((x) => x.p.key === sel.key) : undefined;
  const pick = (side: Side, p: LPlayer) => setSel((s) => (s?.key === p.key ? null : { side, key: p.key }));
  const coaches = [home, away].flatMap((t) => [
    t.meta?.coach ? { k: `${t.side}c`, l: `${refs[t.side]?.name} · bosh murabbiy`, v: t.meta.coach } : null,
    t.meta?.assistant ? { k: `${t.side}a`, l: `${refs[t.side]?.name} · yordamchi`, v: t.meta.assistant } : null,
  ]).filter(Boolean) as { k: string; l: string; v: string }[];
  const referees = d.officials.filter((o) => !o.side);

  const pitch = canPitch && (
    <section className="card lu-pitch-card">
      {view !== "home" && <div className="lu-pitch-label"><span className="row"><Crest team={refs.away} size={18} /> {refs.away?.name} <span className="dot away" /></span><span className="muted">Hujum ↓ <b>{away.code}</b></span></div>}
      <div className="lu-pitch-wrap">
        <div className="lu-pitch">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className="lu-lines">
            <path d={LINES} />
            <circle cx={M + 34} cy={M + 52.5} r={9.15} />
            <circle cx={M + 34} cy={M + 52.5} r={0.35} className="spot" />
            <circle cx={M + 34} cy={M + 11} r={0.35} className="spot" />
            <circle cx={M + 34} cy={M + 94} r={0.35} className="spot" />
          </svg>
          {placed.map((x) => <Marker key={x.p.key} m={x} current={pitchView === "current"} selected={sel?.key === x.p.key} onSelect={() => pick(x.side, x.p)} />)}
        </div>
        {selP && sel && !narrow && selPos && <PlayerCard p={selP} team={refs[sel.side]} liveMinute={liveMinute} d={d} onClose={() => setSel(null)} pos={{ x: selPos.x, y: selPos.y }} />}
      </div>
      {view !== "away" && <div className="lu-pitch-label"><span className="row"><Crest team={refs.home} size={18} /> {refs.home?.name} <span className="dot home" /></span><span className="muted">Hujum ↑ <b>{home.code}</b></span></div>}
    </section>
  );

  return (
    <div className="lu">
      <div className="lu-bar">
        <div className="lu-modes" role="tablist" aria-label="Tarkib turi">
          {([["start", "Asosiy tarkib"], ["current", "Joriy tarkib"], ["bench", "Zaxiradagilar"]] as [Mode, string][]).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={mode === k} onClick={() => { setMode(k); setSel(null); }} disabled={k === "current" && !hasSubs && m.status === "scheduled"}>{l}</button>
          ))}
        </div>
        {mode !== "bench" && (
          <div className="lu-seg" role="group" aria-label="Jamoa">
            <button aria-pressed={view === "both"} onClick={() => { setView("both"); setSel(null); }}>{narrow ? "Ikkalasi" : "Ikkala jamoa"}</button>
            {(["home", "away"] as Side[]).map((s) => (
              <button key={s} aria-pressed={view === s} onClick={() => { setView(s); setSel(null); }}>
                <span className={`dot ${s}`} /> {refs[s]?.short_name || refs[s]?.name}{!narrow && (s === "home" ? home : away).code ? ` · ${(s === "home" ? home : away).code}` : ""}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode !== "bench" && (
        <div className={`lu-grid ${view}${canPitch ? "" : " nopitch"}`}>
          {view !== "away" && <TeamCard t={home} team={refs.home} mode={pitchView} selected={sel?.key || null} onSelect={(p) => pick("home", p)} />}
          {pitch}
          {view !== "home" && <TeamCard t={away} team={refs.away} mode={pitchView} selected={sel?.key || null} onSelect={(p) => pick("away", p)} />}
        </div>
      )}
      {!canPitch && mode !== "bench" && <p className="muted small" style={{ margin: "-8px 0 16px" }}>Sxema e’lon qilinmagan — tarkib ro‘yxat ko‘rinishida.</p>}

      <div className="lu-under">
        <BenchCard teams={[home, away]} refs={refs} />
        <aside className="stack">
          {coaches.length > 0 && (
            <section className="card card-pad">
              <h3 className="h4" style={{ marginBottom: 12 }}>Murabbiylar</h3>
              <dl className="kv">{coaches.map((c) => <Fragment key={c.k}><dt>{c.l}</dt><dd>{c.v}</dd></Fragment>)}</dl>
            </section>
          )}
          {referees.length > 0 && (
            <section className="card card-pad">
              <h3 className="h4" style={{ marginBottom: 12 }}>Hakamlar</h3>
              <dl className="kv">{referees.map((o) => <Fragment key={o.id}><dt>{o.role}</dt><dd>{o.name}</dd></Fragment>)}</dl>
            </section>
          )}
        </aside>
      </div>

      <Legend refs={refs} />

      {selP && sel && (narrow || !selPos) && <PlayerCard p={selP} team={refs[sel.side]} liveMinute={liveMinute} d={d} onClose={() => setSel(null)} />}
    </div>
  );
}
