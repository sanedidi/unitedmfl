import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, type Page } from "@/lib/api";
import { useDebounced, useLoad } from "@/lib/hooks";
import { activeSeason, useRefs } from "@/lib/refs";
import { EVENT_LABEL, MATCH_STATUS, POSITIONS, fmtShort } from "@/lib/format";
import type { LineupRow, Match, MatchDetail, Player } from "@/lib/types";
import { FormFields, useForm, type FieldSpec } from "@/components/Crud";
import { PageHead, SITE_URL } from "@/components/Layout";
import { Badge, Crest, Empty, ErrorBox, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { useAuth } from "@/lib/auth";

export function StageTag({ m }: { m: Pick<Match, "stage" | "round"> }) {
  if (!m.stage) return <span className="tag">—</span>;
  const k = m.stage.kind;
  return <span className={`tag ${k === "final" ? "lime" : k === "group" ? "" : "navy"}`}>{k === "group" ? m.round || "Guruh" : m.stage.name}</span>;
}
export const StatusBadge = ({ s }: { s: string }) => <Badge tone={MATCH_STATUS[s]?.tone}>{MATCH_STATUS[s]?.label || s}</Badge>;

export function MatchVs({ m }: { m: Match }) {
  const played = m.home_score != null && m.status !== "scheduled";
  return (
    <span className="vs">
      <Crest team={m.home} size={22} /> <span className="ellipsis">{m.home?.name || "Aniqlanmagan"}</span>
      <span className="score tnum">{played ? `${m.home_score} : ${m.away_score}` : "—"}</span>
      <span className="ellipsis">{m.away?.name || "Aniqlanmagan"}</span> <Crest team={m.away} size={22} />
    </span>
  );
}

/* ---------- List ---------- */
export function MatchesPage() {
  const { stages } = useRefs();
  const { can } = useAuth();
  const [status, setStatus] = useState("");
  const [stage, setStage] = useState("");
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const nav = useNavigate();
  const qs = useMemo(() => {
    const s = new URLSearchParams({ limit: "200" });
    if (status) s.set("status", status);
    if (stage) s.set("stage", stage);
    if (dq) s.set("q", dq);
    return s.toString();
  }, [status, stage, dq]);
  const res = useLoad(() => api.get<Page<Match>>(`/admin/matches?${qs}`), [qs]);
  const { error, loading, reload } = res;
  const data = res.data?.items;

  return (
    <>
      <PageHead title="Matchlar" sub="Taqvim, natijalar va match sahifalari" actions={can("matches:edit") && <Link className="btn btn-primary" to="/matches/new"><I.plus size={16} /> Yangi match</Link>} />
      <div className="card">
        <div className="toolbar">
          <div className="search grow" style={{ maxWidth: 320 }}><I.search size={16} /><input className="input" placeholder="Jamoa nomi…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Qidirish" /></div>
          <select className="select" style={{ width: "auto" }} value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Bosqich">
            <option value="">Bosqich: barchasi</option>
            {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className="seg">
            {[["", "Hammasi"], ["scheduled", "Kelgusi"], ["live", "Jonli"], ["finished", "Yakunlangan"]].map(([v, l]) => (
              <button key={v} aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>
            ))}
          </div>
        </div>
        {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : !data?.length ? <Empty title="Matchlar topilmadi" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Sana</th><th>Bosqich</th><th>Match</th><th>Holat</th><th className="hide-mobile">Saytda</th><th /></tr></thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id} className="clickable" onClick={() => nav(`/matches/${m.id}`)}>
                  <td className="nowrap tnum">{fmtShort(m.kickoff_at)}</td>
                  <td><StageTag m={m} /></td>
                  <td style={{ minWidth: 300 }}><MatchVs m={m} /></td>
                  <td><StatusBadge s={m.status} /></td>
                  <td className="hide-mobile">{m.published ? <Badge tone="ok">Ko‘rinadi</Badge> : <Badge tone="warn">Yashirin</Badge>}</td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}>
                    {can("live") && m.status !== "finished" && <Link className="btn btn-sm" to={`/live/${m.id}`}><I.radio size={15} /> Live</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

/* ---------- Edit ---------- */
type Tab = "main" | "result" | "lineups" | "events";

export function MatchEditPage() {
  const { id } = useParams();
  const isNew = id === "new";
  const { data, error, loading, reload } = useLoad(async () => (isNew ? null : { detail: await api.get<MatchDetail>(`/admin/matches/${id}`) }), [id]);
  const [tab, setTab] = useState<Tab>("main");
  if (!isNew && error) return <ErrorBox error={error} retry={reload} />;
  if (!isNew && (loading || !data)) return <Loading />;
  const d = data?.detail;
  const title = d ? `${d.match.home?.name || "?"} — ${d.match.away?.name || "?"}` : "Yangi match";
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><Link to="/matches" className="btn btn-ghost btn-sm"><I.back size={16} /> Matchlar</Link></div>
      <PageHead title={title} sub={d ? <span className="row wrap"><StageTag m={d.match} /> <StatusBadge s={d.match.status} /> <span>{fmtShort(d.match.kickoff_at)}</span></span> : undefined}
        actions={d && <>
          <a className="btn" href={`${SITE_URL}/matchlar/${d.match.id}`} target="_blank" rel="noreferrer"><I.globe size={16} /> Saytda</a>
          {d.match.status !== "finished" && <Link className="btn btn-dark" to={`/live/${d.match.id}`}><I.radio size={16} /> Live-pult</Link>}
        </>} />
      {!isNew && (
        <div className="tabs" role="tablist">
          {([["main", "Asosiy"], ["result", "Natija"], ["lineups", "Tarkiblar"], ["events", "Voqealar"]] as [Tab, string][]).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
      )}
      {(isNew || tab === "main" || tab === "result") && <MatchForm key={isNew ? "new" : tab} detail={d} mode={isNew ? "main" : (tab as "main" | "result")} onSaved={reload} />}
      {!isNew && tab === "lineups" && d && <LineupsEditor detail={d} onSaved={reload} />}
      {!isNew && tab === "events" && d && <EventsEditor detail={d} onChanged={reload} />}
    </>
  );
}

function MatchForm({ detail, mode, onSaved }: { detail?: MatchDetail; mode: "main" | "result"; onSaved: () => void }) {
  const { teams, seasons, stages } = useRefs();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const m = detail?.match;
  const teamOpts = teams.map((t) => ({ value: String(t.id), label: t.name }));
  const statusOpts = Object.entries(MATCH_STATUS).map(([value, v]) => ({ value, label: v.label }));
  const mainFields: FieldSpec[] = [
    { name: "season_id", label: "Mavsum", type: "select", numeric: true, required: true, options: seasons.map((s) => ({ value: String(s.id), label: s.name })) },
    { name: "stage_id", label: "Bosqich", type: "select", numeric: true, nullable: true, options: stages.map((s) => ({ value: String(s.id), label: s.name })) },
    { name: "home_team_id", label: "Uy egasi", type: "select", numeric: true, nullable: true, options: teamOpts },
    { name: "away_team_id", label: "Mehmon", type: "select", numeric: true, nullable: true, options: teamOpts },
    { name: "kickoff_at", label: "Boshlanish (Toshkent vaqti)", type: "datetime" },
    { name: "round", label: "Tur / izoh", placeholder: "Guruh, 2-tur…" },
    { name: "venue", label: "Stadion", full: true },
    { name: "ticket_url", label: "Chipta havolasi", type: "url", full: true },
    { name: "status", label: "Holat", type: "select", options: statusOpts },
    { name: "published", label: "Saytda ko‘rsatish", type: "bool" },
    { name: "show_in_hero", label: "Bosh sahifadagi «Yaqin matchlar»da", type: "bool" },
    { name: "banner_url", label: "Match banneri", type: "image" },
    { name: "notes", label: "Ichki izoh", type: "textarea" },
  ];
  const resultFields: FieldSpec[] = [
    { name: "status", label: "Holat", type: "select", options: statusOpts, full: true },
    { name: "home_score", label: `${m?.home?.name || "Uy egasi"} — gollar`, type: "number", nullable: true },
    { name: "away_score", label: `${m?.away?.name || "Mehmon"} — gollar`, type: "number", nullable: true },
    { name: "home_ht", label: "1-taym (uy)", type: "number", nullable: true },
    { name: "away_ht", label: "1-taym (mehmon)", type: "number", nullable: true },
    { name: "home_et", label: "Qo‘sh. vaqt (uy)", type: "number", nullable: true },
    { name: "away_et", label: "Qo‘sh. vaqt (mehmon)", type: "number", nullable: true },
    { name: "home_pen", label: "Penaltilar (uy)", type: "number", nullable: true },
    { name: "away_pen", label: "Penaltilar (mehmon)", type: "number", nullable: true },
    { name: "attendance", label: "Tomoshabinlar", type: "number", nullable: true },
    { name: "video_url", label: "Videosharh havolasi", type: "url" },
    { name: "added_time_1h", label: "Qo‘shilgan vaqt, 1-taym", type: "number", nullable: true },
    { name: "added_time_2h", label: "Qo‘shilgan vaqt, 2-taym", type: "number", nullable: true },
  ];
  const fields = mode === "main" ? mainFields : resultFields;
  const initial = useMemo(() => (detail?.row ? ({ ...detail.row } as Record<string, unknown>) : null), [detail?.row]);
  const defaults = { season_id: activeSeason(seasons)?.id ?? "", status: "scheduled", published: true };
  const form = useForm(fields, initial, defaults);
  const [busy, setBusy] = useState(false);
  // refs arrive asynchronously: fill the season for new matches once known
  useEffect(() => {
    if (!m && !form.values.season_id && seasons.length) form.set("season_id", String(activeSeason(seasons)?.id || ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasons.length]);

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    const body = form.payload();
    if (body.home_team_id && body.home_team_id === body.away_team_id) {
      form.setErrors({ away_team_id: "Jamoalar bir xil bo‘lishi mumkin emas" });
      return;
    }
    setBusy(true);
    try {
      if (m) {
        await api.patch(`/admin/matches/${m.id}`, body);
        toast("Saqlandi");
        onSaved();
      } else {
        const r = await api.post<{ id: number }>("/admin/matches", body);
        toast("Match yaratildi");
        nav(`/matches/${r.id}`, { replace: true });
      }
    } catch (err) {
      form.fail(err);
      toast(err instanceof Error ? err.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!m || !(await confirm({ title: "Matchni o‘chirish", text: "Match, uning voqealari va tarkiblari o‘chiriladi.", ok: "O‘chirish", danger: true }))) return;
    try {
      await api.del(`/admin/matches/${m.id}`);
      toast("O‘chirildi");
      nav("/matches", { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }
  return (
    <form className="card card-pad" onSubmit={save}>
      {mode === "result" && detail && detail.events.length > 0 && (m?.status === "live" || m?.status === "halftime") && (
        <div className="alert info" style={{ marginBottom: 16 }}><I.alert size={16} /> Jonli rejimda hisob voqealardan avtomatik hisoblanadi.</div>
      )}
      <FormFields fields={fields} values={form.values} set={form.set} errors={form.errors} />
      <div className="row" style={{ marginTop: 24, justifyContent: "space-between" }}>
        {m ? <button type="button" className="btn btn-danger" onClick={remove}><I.trash size={16} /> O‘chirish</button> : <span />}
        <button className="btn btn-primary" disabled={busy}>{busy ? "Saqlanmoqda…" : "Saqlash"}</button>
      </div>
    </form>
  );
}

/* ---------- Lineups ---------- */
function LineupsEditor({ detail, onSaved }: { detail: MatchDetail; onSaved: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<LineupRow[]>(detail.lineups);
  const [busy, setBusy] = useState(false);
  const m = detail.match;
  const squads = useLoad(async () => {
    const get = (tid?: number) => (tid ? api.get<Page<Player>>(`/admin/players?team_id=${tid}&limit=200`).then((p) => p.items) : Promise.resolve([] as Player[]));
    const [home, away] = await Promise.all([get(m.home?.id), get(m.away?.id)]);
    return { home, away };
  }, [m.home?.id, m.away?.id]);

  function addFromSquad(side: "home" | "away") {
    const list = squads.data?.[side] || [];
    const have = new Set(rows.filter((r) => r.side === side).map((r) => r.player_id));
    const add = list.filter((p) => !have.has(p.id)).map<LineupRow>((p) => ({ side, player_id: p.id, player_name: p.full_name, number: p.number, position: p.position, is_starter: false, is_captain: false }));
    setRows((r) => [...r, ...add]);
  }
  const upd = (i: number, patch: Partial<LineupRow>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  async function save() {
    setBusy(true);
    try {
      await api.put(`/admin/matches/${m.id}/lineups`, rows);
      toast("Tarkiblar saqlandi");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  const side = (s: "home" | "away") => (
    <div className="card">
      <div className="card-head">
        <h3 className="row"><Crest team={s === "home" ? m.home : m.away} /> {(s === "home" ? m.home?.name : m.away?.name) || "—"}</h3>
        <div className="row">
          <span className="muted small">Asosiy: {rows.filter((r) => r.side === s && r.is_starter).length}</span>
          <button className="btn btn-sm" onClick={() => addFromSquad(s)} disabled={!squads.data}>Jamoadan qo‘shish</button>
        </div>
      </div>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>№</th><th>O‘yinchi</th><th>Amplua</th><th>Asosiy</th><th>Sardor</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => r.side !== s ? null : (
            <tr key={i}>
              <td style={{ width: 70 }}><input className="input input-sm" type="number" value={r.number ?? ""} onChange={(e) => upd(i, { number: e.target.value === "" ? null : Number(e.target.value) })} /></td>
              <td><input className="input input-sm" value={r.player_name} onChange={(e) => upd(i, { player_name: e.target.value, player_id: null })} /></td>
              <td><select className="select input-sm" value={r.position} onChange={(e) => upd(i, { position: e.target.value })}><option value="">—</option>{Object.entries(POSITIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
              <td><input type="checkbox" checked={r.is_starter} onChange={(e) => upd(i, { is_starter: e.target.checked })} /></td>
              <td><input type="checkbox" checked={r.is_captain} onChange={(e) => upd(i, { is_captain: e.target.checked })} /></td>
              <td className="actions"><button className="btn btn-ghost btn-sm btn-icon" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} aria-label="O‘chirish"><I.x size={16} /></button></td>
            </tr>
          ))}
          <tr><td colSpan={6}><button className="btn btn-sm btn-ghost" onClick={() => setRows((x) => [...x, { side: s, player_id: null, player_name: "", number: null, position: "", is_starter: true, is_captain: false }])}><I.plus size={14} /> Qator qo‘shish</button></td></tr>
        </tbody>
      </table></div>
    </div>
  );
  return (
    <div className="stack">
      <div className="alert info"><I.alert size={16} /> «Jamoadan qo‘shish» jamoa tarkibini yuklaydi. Qo‘lda yozilgan o‘yinchi faqat ism bilan saqlanadi — profil uchun avval uni «O‘yinchilar» bo‘limida yarating.</div>
      <div className="grid g2" data-split>{side("home")}{side("away")}</div>
      <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saqlanmoqda…" : "Tarkiblarni saqlash"}</button></div>
    </div>
  );
}

/* ---------- Events ---------- */
const TYPES = ["goal", "own_goal", "penalty_goal", "penalty_missed", "yellow", "second_yellow", "red", "sub", "shootout_scored", "shootout_missed", "note"];
function EventsEditor({ detail, onChanged }: { detail: MatchDetail; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const m = detail.match;
  const [f, setF] = useState({ side: "home", type: "goal", minute: "", extra_minute: "", player_name: "", related_player_name: "", note: "" });
  const events = [...detail.events].sort((a, b) => a.minute - b.minute || a.extra_minute - b.extra_minute);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post(`/admin/matches/${m.id}/events`, {
        side: f.side, type: f.type, minute: Number(f.minute || 0), extra_minute: Number(f.extra_minute || 0),
        player_name: f.player_name, related_player_name: f.related_player_name, note: f.note, source: "manual",
      }, { "Idempotency-Key": crypto.randomUUID() });
      setF({ ...f, minute: "", extra_minute: "", player_name: "", related_player_name: "", note: "" });
      toast("Voqea qo‘shildi");
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Xato", "error");
    }
  }
  async function del(id: number) {
    if (!(await confirm({ title: "Voqeani o‘chirish", ok: "O‘chirish", danger: true }))) return;
    await api.del(`/admin/matches/${m.id}/events/${id}`).then(() => { toast("O‘chirildi"); onChanged(); }, (e) => toast(e.message, "error"));
  }
  return (
    <div className="stack">
      <form className="card card-pad" onSubmit={add}>
        <div className="grid g4" style={{ alignItems: "end" }}>
          <div className="field"><label>Jamoa</label><select className="select" value={f.side} onChange={(e) => setF({ ...f, side: e.target.value })}><option value="home">{m.home?.name || "Uy egasi"}</option><option value="away">{m.away?.name || "Mehmon"}</option></select></div>
          <div className="field"><label>Voqea</label><select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{EVENT_LABEL[t]}</option>)}</select></div>
          <div className="field"><label>Daqiqa</label><div className="row"><input className="input" type="number" min={0} max={130} required value={f.minute} onChange={(e) => setF({ ...f, minute: e.target.value })} /><span>+</span><input className="input" type="number" min={0} max={30} value={f.extra_minute} onChange={(e) => setF({ ...f, extra_minute: e.target.value })} /></div></div>
          <div className="field"><label>{f.type === "sub" ? "Kirdi" : "O‘yinchi"}</label><input className="input" value={f.player_name} onChange={(e) => setF({ ...f, player_name: e.target.value })} /></div>
          {f.type === "sub" && <div className="field"><label>Chiqdi</label><input className="input" value={f.related_player_name} onChange={(e) => setF({ ...f, related_player_name: e.target.value })} /></div>}
          <div className="field"><label>Izoh</label><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
          <div><button className="btn btn-primary"><I.plus size={16} /> Qo‘shish</button></div>
        </div>
      </form>
      <div className="card">
        {!events.length ? <Empty title="Voqealar yo‘q" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Daqiqa</th><th>Jamoa</th><th>Voqea</th><th>O‘yinchi</th><th className="hide-mobile">Manba</th><th /></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="tnum b">{e.minute}{e.extra_minute ? `+${e.extra_minute}` : ""}′</td>
                  <td>{e.side === "home" ? m.home?.name : m.away?.name}</td>
                  <td>{EVENT_LABEL[e.type] || e.type}</td>
                  <td>{e.player_name}{e.related_player_name && <span className="muted"> ↔ {e.related_player_name}</span>}</td>
                  <td className="hide-mobile"><Badge plain>{e.source}</Badge></td>
                  <td className="actions"><button className="btn btn-ghost btn-sm btn-icon" onClick={() => del(e.id)} aria-label="O‘chirish"><I.trash size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
