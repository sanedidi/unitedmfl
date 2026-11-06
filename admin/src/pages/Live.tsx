import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, type Page } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { EVENT_LABEL, fmtDate, fmtShort } from "@/lib/format";
import type { LineupRow, Match, MatchDetail, Player } from "@/lib/types";
import { Badge, Crest, Empty, ErrorBox, Loading, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { StageTag, StatusBadge } from "./Matches";
import { LineupPitch } from "@/components/Pitch";
import { currentLineup, parseFormation, reassign, surnameOf, type Formation, type LPlayer } from "@/lib/lineup";

/* ---------- Match picker ---------- */
export function LivePickPage() {
  const { data, error, loading, reload } = useLoad(() => api.get<Page<Match>>("/admin/matches?limit=200"), []);
  const nav = useNavigate();
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  const list = data.items.filter((m) => m.status !== "finished" && m.status !== "cancelled").sort((a, b) => {
    const live = (m: Match) => (m.status === "live" || m.status === "halftime" ? 0 : 1);
    return live(a) - live(b) || +new Date(a.kickoff_at || 0) - +new Date(b.kickoff_at || 0);
  });
  return (
    <div className="live stack">
      <div><h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 800, letterSpacing: "-.02em" }}>Live-pult</h1><p className="muted" style={{ margin: "4px 0 0" }}>Match operatori uchun</p></div>
      {list.length === 0 && <Empty title="Faol matchlar yo‘q" text="Yangi match «Matchlar» bo‘limida yaratiladi." />}
      {list.map((m, i) => {
        const live = m.status === "live" || m.status === "halftime";
        return (
          <div key={m.id} className={`live-board${live ? " on" : i > 0 ? " idle" : ""}`}>
            <div className="row" style={{ justifyContent: "space-between" }}><StageTag m={m} /><StatusBadge s={m.status} /></div>
            <div className="live-score">
              <div className="live-team"><Crest team={m.home} size={44} /><span>{m.home?.name || "Aniqlanmagan"}</span></div>
              <div className="n tnum" style={{ fontSize: live ? 36 : 22 }}>{live ? `${m.home_score ?? 0}:${m.away_score ?? 0}` : "vs"}</div>
              <div className="live-team"><Crest team={m.away} size={44} /><span>{m.away?.name || "Aniqlanmagan"}</span></div>
            </div>
            <div className="muted small" style={{ marginBottom: 14 }}>{fmtShort(m.kickoff_at)} · {m.venue || "Stadion ko‘rsatilmagan"}</div>
            <button className={`btn btn-lg btn-block ${live || i === 0 ? "btn-primary" : ""}`} onClick={() => nav(`/live/${m.id}`)} disabled={!m.home || !m.away}>
              {live ? "Pultni ochish" : "Tayyorlash"} <I.radio size={18} />
            </button>
          </div>
        );
      })}
      <Link to="/protocols" className="btn btn-lg btn-block"><I.camera size={18} /> Protokolni yuklash / suratga olish</Link>
      <div className="alert info"><I.alert size={16} /> Internet uzilsa, voqealar telefonda navbatga yoziladi va aloqa tiklanganda avtomatik yuboriladi.</div>
    </div>
  );
}

/* ---------- Console ---------- */
type Queued = { key: string; matchId: number; body: Record<string, unknown>; label: string };
const QKEY = "umfl.live.queue";
const loadQueue = (): Queued[] => { try { return JSON.parse(localStorage.getItem(QKEY) || "[]"); } catch { return []; } };
const saveQueue = (q: Queued[]) => { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch { /* ignore */ } };

function clockMinute(m: Match, offset: number): { minute: number; extra: number; label: string } {
  if (!m.clock_started_at) {
    const base = Math.floor(m.clock_offset_sec / 60);
    return { minute: Math.max(base, 0), extra: 0, label: m.period === "HT" ? "Tanaffus" : m.period === "PEN" ? "Penaltilar" : m.period === "FT" ? "Yakunlandi" : "—" };
  }
  const total = m.clock_offset_sec + Math.max(0, (Date.now() + offset - new Date(m.clock_started_at).getTime()) / 1000);
  const min = Math.floor(total / 60) + 1;
  const cap = m.period === "1H" ? 45 : m.period === "2H" ? 90 : 120;
  if (min > cap) return { minute: cap, extra: min - cap, label: `${cap}+${min - cap}′` };
  return { minute: min, extra: 0, label: `${min}′` };
}

const NEXT: Record<string, { period: string; label: string; primary?: boolean }[]> = {
  "": [{ period: "1H", label: "Matchni boshlash", primary: true }],
  "1H": [{ period: "HT", label: "Tanaffus", primary: true }],
  HT: [{ period: "2H", label: "2-taymni boshlash", primary: true }],
  "2H": [{ period: "FT", label: "Matchni yakunlash", primary: true }, { period: "ET", label: "Qo‘shimcha vaqt" }, { period: "PEN", label: "Penaltilar seriyasi" }],
  ET: [{ period: "FT", label: "Matchni yakunlash", primary: true }, { period: "PEN", label: "Penaltilar seriyasi" }],
  PEN: [{ period: "FT", label: "Matchni yakunlash", primary: true }],
  FT: [],
};

type Action = { type: string; label: string; cls?: string; icon?: React.ReactNode };
const ACTIONS: Action[] = [
  { type: "goal", label: "Gol", cls: "goal", icon: <I.ball size={20} /> },
  { type: "yellow", label: "Sariq", icon: <span className="card-y" /> },
  { type: "red", label: "Qizil", icon: <span className="card-r" /> },
  { type: "sub", label: "Almashtirish", icon: <I.swap size={20} /> },
  { type: "penalty_goal", label: "Penalti gol", icon: <I.ball size={20} /> },
  { type: "own_goal", label: "Avtogol", icon: <I.ball size={20} /> },
  { type: "second_yellow", label: "2-sariq", icon: <><span className="card-y" /><span className="card-r" /></> },
  { type: "penalty_missed", label: "Penalti o‘tmadi" },
];
const SHOOTOUT: Action[] = [
  { type: "shootout_scored", label: "Urdi ✓", cls: "goal" },
  { type: "shootout_missed", label: "O‘tkazdi ✗" },
];

export function LiveConsolePage() {
  const { id } = useParams();
  const matchId = Number(id);
  const toast = useToast();
  const confirm = useConfirm();
  const [d, setD] = useState<MatchDetail | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [side, setSide] = useState<"home" | "away">("home");
  const [action, setAction] = useState<Action | null>(null);
  const [queue, setQueue] = useState<Queued[]>(loadQueue);
  const [, tick] = useState(0);
  const offset = useRef(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [mode, setMode] = useState<"events" | "lineup">("events");
  const [sheet, setSheet] = useState<null | "sub" | "formation">(null);

  const apply = useCallback((x: MatchDetail) => {
    offset.current = new Date(x.server_time).getTime() - Date.now();
    setD(x);
  }, []);
  const load = useCallback(() => api.get<MatchDetail>(`/admin/matches/${matchId}`).then(apply).catch(setErr), [matchId, apply]);
  useEffect(() => { load(); }, [load]);

  // other operators / protocol imports: follow the public live stream
  useEffect(() => {
    const es = new EventSource(`/api/v1/live/${matchId}`);
    es.addEventListener("match", () => load());
    return () => es.close();
  }, [matchId, load]);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 5000);
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { clearInterval(t); window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  // flush the offline queue
  const flushing = useRef(false);
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      let q = loadQueue();
      for (const item of q) {
        try {
          await api.post(`/admin/matches/${item.matchId}/events`, item.body, { "Idempotency-Key": item.key });
          q = q.filter((x) => x.key !== item.key);
          saveQueue(q);
          setQueue(q);
        } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
            q = q.filter((x) => x.key !== item.key); // rejected by the server: drop it and tell the operator
            saveQueue(q);
            setQueue(q);
            toast(`Voqea rad etildi: ${item.label} — ${e.message}`, "error");
          } else break;
        }
      }
    } finally {
      flushing.current = false;
    }
  }, [toast]);
  useEffect(() => {
    flush();
    const t = setInterval(flush, 5000);
    return () => clearInterval(t);
  }, [flush]);

  const squads = useLoad(async () => {
    if (!d) return { home: [] as Player[], away: [] as Player[] };
    const get = (tid?: number) => (tid ? api.get<Page<Player>>(`/admin/players?team_id=${tid}&limit=200`).then((p) => p.items).catch(() => []) : Promise.resolve([] as Player[]));
    const [home, away] = await Promise.all([get(d.match.home?.id), get(d.match.away?.id)]);
    return { home, away };
  }, [d?.match.home?.id, d?.match.away?.id]);

  if (err) return <ErrorBox error={err} retry={load} />;
  if (!d) return <Loading />;
  const m = d.match;
  const clock = clockMinute(m, offset.current);
  const live = m.status === "live" || m.status === "halftime";
  const pens = m.period === "PEN";

  async function setPeriod(p: string, label: string) {
    if (p === "FT" && !(await confirm({ title: "Matchni yakunlash?", text: `Yakuniy hisob: ${m.home?.name} ${m.home_score ?? 0}:${m.away_score ?? 0} ${m.away?.name}`, ok: "Yakunlash" }))) return;
    try {
      apply(await api.post<MatchDetail>(`/admin/matches/${m.id}/period`, { period: p }));
      toast(label);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }

  async function submit(body: Record<string, unknown>, label: string) {
    const item: Queued = { key: crypto.randomUUID(), matchId: m.id, body: { ...body, source: "live" }, label };
    const q = [...loadQueue(), item];
    saveQueue(q);
    setQueue(q);
    setAction(null);
    await flush();
    load();
  }

  async function undo(evId: number, label: string) {
    if (!(await confirm({ title: "Voqeani bekor qilish?", text: label, ok: "Bekor qilish", danger: true }))) return;
    try {
      await api.del(`/admin/matches/${m.id}/events/${evId}`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }

  const events = [...d.events].sort((a, b) => b.minute - a.minute || b.extra_minute - a.extra_minute || b.id - a.id);
  const lineup = d.lineups.filter((l) => l.side === side);
  const squad = (side === "home" ? squads.data?.home : squads.data?.away) || [];

  return (
    <div className="live stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Link to="/live" className="btn btn-ghost btn-sm"><I.back size={16} /> Matchlar</Link>
        <span className="row small">
          {!online && <Badge tone="danger">Oflayn</Badge>}
          {queue.length > 0 && <Badge tone="warn">Navbatda: {queue.length}</Badge>}
        </span>
      </div>

      <div className={`live-board${live ? " on" : ""}`}>
        <div className="row" style={{ justifyContent: "space-between" }}><StageTag m={m} /><StatusBadge s={m.status} /></div>
        <div className="live-score">
          <div className="live-team"><Crest team={m.home} size={48} /><span>{m.home?.name}</span></div>
          <div>
            <div className="n tnum">{m.home_score ?? 0}:{m.away_score ?? 0}</div>
            <div className="clock" style={{ marginTop: 6 }}>{live ? clock.label : m.status === "scheduled" ? fmtDate(m.kickoff_at) : "FT"}</div>
            {m.home_pen != null && <div className="small muted">pen. {m.home_pen}:{m.away_pen}</div>}
          </div>
          <div className="live-team"><Crest team={m.away} size={48} /><span>{m.away?.name}</span></div>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          {(NEXT[m.period] || []).map((n) => (
            <button key={n.period} className={`btn btn-lg btn-block ${n.primary ? (n.period === "FT" ? "btn-dark" : "btn-primary") : ""}`} onClick={() => setPeriod(n.period, n.label)}>
              {n.label}{n.period === "1H" && <I.radio size={18} />}
            </button>
          ))}
        </div>
      </div>

      {live && (
        <>
          <div className="seg" style={{ width: "100%" }}>
            <button style={{ flex: 1, padding: "8px 0" }} aria-pressed={mode === "events"} onClick={() => setMode("events")}>Hodisalar</button>
            <button style={{ flex: 1, padding: "8px 0" }} aria-pressed={mode === "lineup"} onClick={() => setMode("lineup")}>Tarkib</button>
          </div>
          <div className="seg" style={{ width: "100%" }}>
            {(["home", "away"] as const).map((s) => (
              <button key={s} style={{ flex: 1, padding: "10px 0" }} aria-pressed={side === s} onClick={() => setSide(s)}>
                <span className="row" style={{ justifyContent: "center", gap: 6 }}><Crest team={s === "home" ? m.home : m.away} size={20} /> {s === "home" ? m.home?.name : m.away?.name}</span>
              </button>
            ))}
          </div>
          {mode === "events" && m.period !== "HT" && (
            <div className="action-grid">
              {(pens ? SHOOTOUT : ACTIONS).map((a) => (
                <button key={a.type} className={`action ${a.cls || ""}`} onClick={() => setAction(a)}>{a.icon}{a.label}</button>
              ))}
            </div>
          )}
          {mode === "lineup" && <LivePitch d={d} side={side} onSub={() => setSheet("sub")} onFormation={() => setSheet("formation")} />}
        </>
      )}

      <div className="card">
        <div className="card-head"><h3>Voqealar</h3><span className="muted small">{events.length}</span></div>
        {queue.filter((q) => q.matchId === m.id).map((q) => (
          <div key={q.key} className="row" style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", background: "var(--warn-subtle)" }}>
            <I.refresh size={16} /><span className="grow">{q.label}</span><span className="small muted">yuborilmoqda…</span>
          </div>
        ))}
        {events.length === 0 ? <div className="empty" style={{ padding: 24 }}>Hali voqealar yo‘q</div> : events.map((e) => (
          <div key={e.id} className="row" style={{ padding: "10px 16px", borderTop: "1px solid var(--border)" }}>
            <b className="tnum" style={{ width: 52 }}>{e.minute}{e.extra_minute ? `+${e.extra_minute}` : ""}′</b>
            <Crest team={e.side === "home" ? m.home : m.away} size={20} />
            <span className="grow ellipsis"><b>{EVENT_LABEL[e.type] || e.type}</b> · {e.type === "formation" ? e.note : e.player_name || "—"}{e.related_player_name && <span className="muted"> ↔ {e.related_player_name}</span>}</span>
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Bekor qilish" onClick={() => undo(e.id, `${EVENT_LABEL[e.type]} · ${e.player_name}`)}><I.x size={16} /></button>
          </div>
        ))}
      </div>

      {sheet && (() => {
        const cur = liveLineup(d, side);
        const team = side === "home" ? m.home?.name || "" : m.away?.name || "";
        return sheet === "sub"
          ? <SubSheet side={side} team={team} clock={clock} cur={cur} onClose={() => setSheet(null)} onSubmit={(b, l) => { setSheet(null); submit(b, l); }} />
          : <FormationSheet side={side} team={team} clock={clock} cur={cur} onClose={() => setSheet(null)} onSubmit={(b, l) => { setSheet(null); submit(b, l); }} />;
      })()}

      {action && (
        <EventSheet action={action} side={side} team={side === "home" ? m.home?.name || "" : m.away?.name || ""} clock={clock} lineup={lineup} squad={squad} shootout={pens}
          onClose={() => setAction(null)} onSubmit={submit} />
      )}
    </div>
  );
}

function EventSheet({ action, side, team, clock, lineup, squad, shootout, onClose, onSubmit }: {
  action: Action; side: "home" | "away"; team: string; clock: { minute: number; extra: number }; lineup: LineupRow[]; squad: Player[]; shootout: boolean;
  onClose: () => void; onSubmit: (b: Record<string, unknown>, label: string) => void;
}) {
  const people = useMemo(() => {
    const src = lineup.length ? lineup.map((l) => ({ id: l.player_id, name: l.player_name, number: l.number, starter: l.is_starter })) : squad.map((p) => ({ id: p.id as number | null, name: p.full_name, number: p.number, starter: true }));
    return src.sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
  }, [lineup, squad]);
  const [p1, setP1] = useState<number>(-1);
  const [p2, setP2] = useState<number>(-1);
  const [name, setName] = useState("");
  const [minute, setMinute] = useState(String(shootout ? 120 : clock.minute));
  const [extra, setExtra] = useState(String(shootout ? 0 : clock.extra));
  const isSub = action.type === "sub";
  const pick = (i: number) => (isSub && p1 >= 0 && p1 !== i ? setP2(i) : setP1(i));
  const first = p1 >= 0 ? people[p1] : null;
  const second = p2 >= 0 ? people[p2] : null;
  function send() {
    const player = first?.name || name.trim();
    onSubmit({
      side, type: action.type, minute: Number(minute) || 0, extra_minute: Number(extra) || 0,
      player_id: first?.id ?? null, player_name: player,
      related_player_id: isSub ? second?.id ?? null : null, related_player_name: isSub ? second?.name || "" : "",
    }, `${action.label} · ${team}${player ? ` · ${player}` : ""}`);
  }
  return (
    <Modal title={<span className="row">{action.icon}{action.label} — {team}</span>} onClose={onClose} footer={<>
      <button className="btn btn-lg" onClick={onClose}>Bekor</button>
      <button className="btn btn-lg btn-primary" onClick={send} disabled={isSub && !(first && second)}>Tasdiqlash</button>
    </>}>
      <div className="stack">
        {!shootout && (
          <div className="row">
            <div className="field" style={{ width: 110 }}><label>Daqiqa</label><input className="input" type="number" inputMode="numeric" value={minute} onChange={(e) => setMinute(e.target.value)} /></div>
            <div className="field" style={{ width: 110 }}><label>Qo‘shimcha</label><input className="input" type="number" inputMode="numeric" value={extra} onChange={(e) => setExtra(e.target.value)} /></div>
          </div>
        )}
        {isSub && <div className="small muted">Avval <b>maydonga kirgan</b>, keyin <b>chiqqan</b> o‘yinchini tanlang.</div>}
        {people.length > 0 ? (
          <div className="picker">
            {people.map((p, i) => (
              <button key={i} aria-pressed={i === p1 || i === p2} onClick={() => pick(i)} style={i === p2 ? { borderColor: "var(--red-500)", background: "var(--red-50)", color: "var(--red-600)" } : undefined}>
                <b>{p.number ?? "—"}</b><span>{p.name.split(" ").slice(-1)[0]}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="field"><label>O‘yinchi</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ism (ixtiyoriy)" /></div>
        )}
        {(first || second) && (
          <div className="alert ok">{isSub ? <>↑ {first?.name || "—"} &nbsp; ↓ {second?.name || "tanlang"}</> : first?.name}</div>
        )}
      </div>
    </Modal>
  );
}

/* ---------- Lineup mode ---------- */
type Cur = ReturnType<typeof currentLineup> & { f: Formation | null; total: number };

function liveLineup(d: MatchDetail, side: "home" | "away"): Cur {
  const meta = d.lineup_meta?.find((x) => x.side === side);
  const players: LPlayer[] = d.lineups.filter((l) => l.side === side).map((l) => ({
    player_id: l.player_id, player_name: l.player_name, number: l.number, position: l.position,
    role: l.role || "", slot: l.slot ?? null, is_starter: l.is_starter, is_captain: l.is_captain,
  }));
  const chrono = [...d.events].sort((a, b) => a.minute - b.minute || a.extra_minute - b.extra_minute || a.id - b.id);
  const cur = currentLineup(meta?.formation || "", players, chrono, side);
  return { ...cur, f: parseFormation(cur.formation), total: players.length };
}

function LivePitch({ d, side, onSub, onFormation }: { d: MatchDetail; side: "home" | "away"; onSub: () => void; onFormation: () => void }) {
  const cur = liveLineup(d, side);
  if (cur.total === 0) {
    return (
      <div className="card card-pad stack" style={{ alignItems: "center", textAlign: "center" }}>
        <b>Tarkib kiritilmagan</b>
        <span className="muted small">Tarkibni match sahifasida yoki protokol orqali kiriting.</span>
        <Link to={`/matches/${d.match.id}`} className="btn btn-sm">Tarkib muharriri</Link>
      </div>
    );
  }
  const subs = cur.on.filter((p) => p.subbedIn).length;
  return (
    <div className="card live-lineup">
      <div className="card-head">
        <h3>Joriy tarkib</h3>
        <span className="row small muted">{cur.formation || "Sxemasiz"} · {subs > 0 ? `${subs} almashtirish` : "almashtirish yo‘q"}</span>
      </div>
      {cur.f ? (
        <div style={{ padding: "0 12px" }}>
          <LineupPitch formation={cur.f} players={cur.on.filter((p) => !p.sentOff)} compact
            badge={(p) => (cur.on.find((x) => x.player_id === p.player_id && x.player_name === p.player_name)?.subbedIn ? <i className="badge-in">↑</i> : null)} />
        </div>
      ) : (
        <div className="picker" style={{ padding: "0 12px" }}>
          {cur.on.map((p, i) => <button key={i} disabled={p.sentOff}><b>{p.number ?? "—"}</b><span>{surnameOf(p.player_name)}</span></button>)}
        </div>
      )}
      {cur.on.some((p) => p.sentOff) && (
        <div className="small" style={{ padding: "8px 16px 0" }}><span className="card-r" /> Chetlatilgan: {cur.on.filter((p) => p.sentOff).map((p) => surnameOf(p.player_name)).join(", ")}</div>
      )}
      <div style={{ padding: "12px 16px" }}>
        <div className="small muted" style={{ marginBottom: 6 }}>Zaxira · {cur.bench.length}</div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {cur.bench.length === 0 ? <span className="small muted">Zaxira bo‘sh</span> : cur.bench.map((p, i) => (
            <span key={i} className="bench-chip" style={{ cursor: "default", paddingRight: 10 }}><b className="tnum">{p.number ?? "—"}</b>{surnameOf(p.player_name)}</span>
          ))}
        </div>
      </div>
      <div className="row" style={{ padding: "0 16px 16px", gap: 8 }}>
        <button className="btn btn-lg btn-primary grow" onClick={onSub} disabled={!cur.bench.length}><I.swap size={18} /> Almashtirish</button>
        <button className="btn btn-lg grow" onClick={onFormation}><I.grid size={18} /> Sxema</button>
      </div>
    </div>
  );
}

function MinuteFields({ minute, extra, setMinute, setExtra }: { minute: string; extra: string; setMinute: (v: string) => void; setExtra: (v: string) => void }) {
  return (
    <div className="row">
      <div className="field" style={{ width: 110 }}><label>Daqiqa</label><input className="input" type="number" inputMode="numeric" value={minute} onChange={(e) => setMinute(e.target.value)} /></div>
      <div className="field" style={{ width: 110 }}><label>Qo‘shimcha</label><input className="input" type="number" inputMode="numeric" value={extra} onChange={(e) => setExtra(e.target.value)} /></div>
    </div>
  );
}

function SubSheet({ side, team, clock, cur, onClose, onSubmit }: {
  side: "home" | "away"; team: string; clock: { minute: number; extra: number }; cur: Cur;
  onClose: () => void; onSubmit: (b: Record<string, unknown>, label: string) => void;
}) {
  const [minute, setMinute] = useState(String(clock.minute));
  const [extra, setExtra] = useState(String(clock.extra));
  const [out, setOut] = useState(-1);
  const [inn, setInn] = useState(-1);
  const onPitch = cur.on.filter((p) => !p.sentOff).sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  const o = out >= 0 ? onPitch[out] : null;
  const n = inn >= 0 ? cur.bench[inn] : null;
  const grid = (list: LPlayer[], sel: number, set: (i: number) => void, tone: "out" | "in") => (
    <div className="picker">
      {list.map((p, i) => (
        <button key={i} aria-pressed={i === sel} onClick={() => set(i)}
          style={i === sel ? (tone === "out" ? { borderColor: "var(--red-500)", background: "var(--red-50)", color: "var(--red-600)" } : { borderColor: "var(--green-600)", background: "var(--green-50, #ecfdf3)", color: "var(--green-600)" }) : undefined}>
          <b>{p.number ?? "—"}</b><span>{surnameOf(p.player_name)}</span>
        </button>
      ))}
    </div>
  );
  return (
    <Modal title={<span className="row"><I.swap size={20} /> Almashtirish — {team}</span>} onClose={onClose} footer={<>
      <button className="btn btn-lg" onClick={onClose}>Bekor</button>
      <button className="btn btn-lg btn-primary" disabled={!o || !n} onClick={() => o && n && onSubmit({
        side, type: "sub", minute: Number(minute) || 0, extra_minute: Number(extra) || 0,
        player_id: n.player_id, player_name: n.player_name, related_player_id: o.player_id, related_player_name: o.player_name,
      }, `Almashtirish · ${team} · ↑ ${n.player_name} ↓ ${o.player_name}`)}>Tasdiqlash</button>
    </>}>
      <div className="stack">
        <MinuteFields minute={minute} extra={extra} setMinute={setMinute} setExtra={setExtra} />
        <div className="small"><b style={{ color: "var(--red-600)" }}>↓ Chiqadi</b> — maydondagi o‘yinchi</div>
        {grid(onPitch, out, setOut, "out")}
        <div className="small"><b style={{ color: "var(--green-600)" }}>↑ Kiradi</b> — zaxiradan</div>
        {grid(cur.bench, inn, setInn, "in")}
        {(o || n) && <div className="alert ok">↑ {n?.player_name || "tanlang"} &nbsp; ↓ {o?.player_name || "tanlang"}{o?.role ? ` · ${o.role}` : ""}</div>}
      </div>
    </Modal>
  );
}

function FormationSheet({ side, team, clock, cur, onClose, onSubmit }: {
  side: "home" | "away"; team: string; clock: { minute: number; extra: number }; cur: Cur;
  onClose: () => void; onSubmit: (b: Record<string, unknown>, label: string) => void;
}) {
  const cat = useLoad(() => api.get<{ items: Formation[] }>("/admin/formations"), []);
  const [minute, setMinute] = useState(String(clock.minute));
  const [extra, setExtra] = useState(String(clock.extra));
  const onPitch = cur.on.filter((p) => !p.sentOff);
  const size = onPitch.length;
  const options = (cat.data?.items || []).filter((f) => f.size === (cur.f?.size || size) || f.size === size);
  const [code, setCode] = useState("");
  const to = code ? parseFormation(code) : null;
  const preview = useMemo(() => (to ? reassign(cur.f, to, onPitch) : []), [code]); // eslint-disable-line react-hooks/exhaustive-deps
  function send() {
    if (!to) return;
    const slots: Record<string, number> = {};
    for (const p of preview) if (p.player_id != null && p.slot != null) slots[String(p.player_id)] = p.slot;
    onSubmit({ side, type: "formation", minute: Number(minute) || 0, extra_minute: Number(extra) || 0, note: to.code, player_name: "", payload: { slots } },
      `Sxema · ${team} · ${cur.formation || "—"} → ${to.code}`);
  }
  return (
    <Modal title={<span className="row"><I.grid size={20} /> Sxemani o‘zgartirish — {team}</span>} onClose={onClose} footer={<>
      <button className="btn btn-lg" onClick={onClose}>Bekor</button>
      <button className="btn btn-lg btn-primary" disabled={!to || to.code === cur.formation} onClick={send}>Tasdiqlash</button>
    </>}>
      <div className="stack">
        <MinuteFields minute={minute} extra={extra} setMinute={setMinute} setExtra={setExtra} />
        <div className="small muted">Hozir: <b>{cur.formation || "sxemasiz"}</b> · maydonda {size} o‘yinchi</div>
        {cat.loading ? <Loading /> : (
          <div className="chips">
            {options.map((f) => <button key={f.code} type="button" className="chip" aria-pressed={code === f.code} disabled={f.code === cur.formation} onClick={() => setCode(f.code)}>{f.code}</button>)}
          </div>
        )}
        {to && <div style={{ maxWidth: 300, margin: "0 auto", width: "100%" }}><LineupPitch formation={to} players={preview} compact /></div>}
        {to && <div className="small muted">O‘yinchilar yangi sxemada eng yaqin o‘ringa joylashtiriladi. Saytda joriy tarkib shu daqiqadan yangilanadi.</div>}
      </div>
    </Modal>
  );
}
