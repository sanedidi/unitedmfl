import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, type Page } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { EVENT_LABEL, fmtDate, fmtShort } from "@/lib/format";
import type { LineupRow, Match, MatchDetail, Player } from "@/lib/types";
import { Badge, Crest, Empty, ErrorBox, Loading, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { StageTag, StatusBadge } from "./Matches";

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
      <div><h1 style={{ fontFamily: "var(--font-display)", fontSize: 24 }}>Live-pult</h1><p className="muted" style={{ margin: "4px 0 0" }}>Match operatori uchun</p></div>
      {list.length === 0 && <Empty title="Faol matchlar yo‘q" text="Yangi match «Matchlar» bo‘limida yaratiladi." />}
      {list.map((m, i) => {
        const live = m.status === "live" || m.status === "halftime";
        return (
          <div key={m.id} className="live-board" style={i > 0 && !live ? { borderColor: "var(--border)" } : undefined}>
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

      {live && m.period !== "HT" && (
        <>
          <div className="seg" style={{ width: "100%" }}>
            {(["home", "away"] as const).map((s) => (
              <button key={s} style={{ flex: 1, padding: "10px 0" }} aria-pressed={side === s} onClick={() => setSide(s)}>
                <span className="row" style={{ justifyContent: "center", gap: 6 }}><Crest team={s === "home" ? m.home : m.away} size={20} /> {s === "home" ? m.home?.name : m.away?.name}</span>
              </button>
            ))}
          </div>
          <div className="action-grid">
            {(pens ? SHOOTOUT : ACTIONS).map((a) => (
              <button key={a.type} className={`action ${a.cls || ""}`} onClick={() => setAction(a)}>{a.icon}{a.label}</button>
            ))}
          </div>
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
            <span className="grow ellipsis"><b>{EVENT_LABEL[e.type] || e.type}</b> · {e.player_name || "—"}{e.related_player_name && <span className="muted"> ↔ {e.related_player_name}</span>}</span>
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Bekor qilish" onClick={() => undo(e.id, `${EVENT_LABEL[e.type]} · ${e.player_name}`)}><I.x size={16} /></button>
          </div>
        ))}
      </div>

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
              <button key={i} aria-pressed={i === p1 || i === p2} onClick={() => pick(i)} style={i === p2 ? { borderColor: "var(--berry)", background: "var(--bg-live-subtle)" } : undefined}>
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
