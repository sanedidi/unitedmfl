import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, type Page } from "@/lib/api";
import { useDebounced, useLoad } from "@/lib/hooks";
import { activeSeason, useRefs } from "@/lib/refs";
import { EVENT_LABEL, MATCH_STATUS, fmtShort, uid } from "@/lib/format";
import type { Match, MatchDetail } from "@/lib/types";
import { FormFields, useForm, type FieldSpec } from "@/components/Crud";
import { PageHead, SITE_URL } from "@/components/Layout";
import { Badge, Crest, Empty, ErrorBox, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { useAuth, Allowed } from "@/lib/auth";
import { LineupEditor } from "./Lineups";
import { MatchPhotos } from "@/components/MatchPhotos";

import { tx } from "@/lib/i18n";
export function StageTag({ m }: { m: Pick<Match, "stage" | "round"> }) {
  if (!m.stage) return <span className="tag">—</span>;
  const k = m.stage.kind;
  return <span className={`tag ${k === "final" ? "lime" : k === "group" ? "" : "navy"}`}>{k === "group" ? m.round || tx("Guruh") : m.stage.name}</span>;
}
export const StatusBadge = ({ s }: { s: string }) => <Badge tone={MATCH_STATUS[s]?.tone}>{MATCH_STATUS[s]?.label || s}</Badge>;

export function MatchVs({ m }: { m: Match }) {
  const played = m.home_score != null && m.status !== "scheduled";
  return (
    <span className="vs">
      <Crest team={m.home} size={22} /> <span className="ellipsis">{m.home?.name || tx("Aniqlanmagan")}</span>
      <span className="score tnum">{played ? `${m.home_score} : ${m.away_score}` : "—"}</span>
      <span className="ellipsis">{m.away?.name || tx("Aniqlanmagan")}</span> <Crest team={m.away} size={22} />
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
      <PageHead title={tx("Matchlar")} sub={tx("Taqvim, natijalar va match sahifalari")} actions={can("matches:create") && <Link className="btn btn-primary" to="/matches/new"><I.plus size={16} />{" "}{tx("Yangi match")}</Link>} />
      <div className="card">
        <div className="toolbar">
          <div className="search grow" style={{ maxWidth: 320 }}><I.search size={16} /><input className="input" placeholder={tx("Jamoa nomi…")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tx("Qidirish")} /></div>
          <select className="select" style={{ width: "auto" }} value={stage} onChange={(e) => setStage(e.target.value)} aria-label={tx("Bosqich")}>
            <option value="">{tx("Bosqich: barchasi")}</option>
            {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className="seg">
            {[["", tx("Hammasi")], ["scheduled", tx("Kelgusi")], ["live", tx("Jonli")], ["finished", tx("Yakunlangan")]].map(([v, l]) => (
              <button key={v} aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>
            ))}
          </div>
        </div>
        {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : !data?.length ? <Empty title={tx("Matchlar topilmadi")} /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{tx("Sana")}</th><th>{tx("Bosqich")}</th><th>{tx("Match")}</th><th>{tx("Holat")}</th><th className="hide-mobile">{tx("Saytda")}</th><th /></tr></thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id} className="clickable" onClick={() => nav(`/matches/${m.id}`)}>
                  <td className="nowrap tnum">{fmtShort(m.kickoff_at)}</td>
                  <td><StageTag m={m} /></td>
                  <td style={{ minWidth: 300 }}><MatchVs m={m} /></td>
                  <td><StatusBadge s={m.status} /></td>
                  <td className="hide-mobile">{m.published ? <Badge tone="ok">{tx("Ko‘rinadi")}</Badge> : <Badge tone="warn">{tx("Yashirin")}</Badge>}</td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}>
                    {can("live") && m.status !== "finished" && <Link className="btn btn-sm" to={`/live/${m.id}`}><I.radio size={15} />{" "}{tx("Live")}</Link>}
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
type Tab = "main" | "result" | "lineups" | "events" | "photos";

export function MatchEditPage() {
  const { id } = useParams();
  const isNew = id === "new";
  const { data, error, loading, reload } = useLoad(async () => (isNew ? null : { detail: await api.get<MatchDetail>(`/admin/matches/${id}`) }), [id]);
  const [tab, setTab] = useState<Tab>("main");
  if (!isNew && error) return <ErrorBox error={error} retry={reload} />;
  if (!isNew && (loading || !data)) return <Loading />;
  const d = data?.detail;
  const title = d ? `${d.match.home?.name || "?"} — ${d.match.away?.name || "?"}` : tx("Yangi match");
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><Link to="/matches" className="btn btn-ghost btn-sm"><I.back size={16} />{" "}{tx("Matchlar")}</Link></div>
      <PageHead title={title} sub={d ? <span className="row wrap"><StageTag m={d.match} /> <StatusBadge s={d.match.status} /> <span>{fmtShort(d.match.kickoff_at)}</span></span> : undefined}
        actions={d && <>
          <a className="btn" href={`${SITE_URL}/matchlar/${d.match.id}`} target="_blank" rel="noreferrer"><I.globe size={16} />{" "}{tx("Saytda")}</a>
          {d.match.status !== "finished" && <Link className="btn btn-dark" to={`/live/${d.match.id}`}><I.radio size={16} />{" "}{tx("Live-pult")}</Link>}
        </>} />
      {!isNew && (
        <div className="tabs" role="tablist">
          {([["main", tx("Asosiy")], ["result", tx("Natija")], ["lineups", tx("Tarkiblar")], ["events", tx("Voqealar")], ["photos", tx("Foto hisobot")]] as [Tab, string][]).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
      )}
      {(isNew || tab === "main" || tab === "result") && <MatchForm key={isNew ? "new" : tab} detail={d} mode={isNew ? "main" : (tab as "main" | "result")} onSaved={reload} />}
      {!isNew && tab === "photos" && d && <MatchPhotos matchId={d.match.id} />}
      {!isNew && tab === "lineups" && d && <LineupEditor detail={d} onSaved={reload} />}
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
    { name: "season_id", label: tx("Mavsum"), type: "select", numeric: true, nullable: true, hint: tx("Bo‘sh — o‘rtoqlik o‘yini, mavsum va jadvalga kirmaydi"), options: seasons.map((s) => ({ value: String(s.id), label: s.name })) },
    { name: "stage_id", label: tx("Bosqich"), type: "select", numeric: true, nullable: true, options: stages.map((s) => ({ value: String(s.id), label: s.name })) },
    { name: "home_team_id", label: tx("Uy egasi"), type: "select", numeric: true, nullable: true, options: teamOpts },
    { name: "away_team_id", label: tx("Mehmon"), type: "select", numeric: true, nullable: true, options: teamOpts },
    { name: "kickoff_at", label: tx("Boshlanish (Toshkent vaqti)"), type: "datetime" },
    { name: "round", label: tx("Tur / izoh"), placeholder: tx("Guruh, 2-tur…") },
    { name: "venue", label: tx("Stadion"), full: true },
    { name: "ticket_url", label: tx("Chipta havolasi"), type: "url", full: true },
    { name: "status", label: tx("Holat"), type: "select", options: statusOpts },
    { name: "published", label: tx("Saytda ko‘rsatish"), type: "bool" },
    { name: "show_in_hero", label: tx("Bosh sahifadagi «Yaqin matchlar»da"), type: "bool" },
    { name: "banner_url", label: tx("Match banneri"), type: "image" },
    { name: "notes", label: tx("Ichki izoh"), type: "textarea" },
  ];
  const resultFields: FieldSpec[] = [
    { name: "status", label: tx("Holat"), type: "select", options: statusOpts, full: true },
    { name: "home_score", label: tx("{0} — gollar", m?.home?.name || "Uy egasi"), type: "number", nullable: true },
    { name: "away_score", label: tx("{0} — gollar", m?.away?.name || "Mehmon"), type: "number", nullable: true },
    { name: "home_ht", label: tx("1-taym (uy)"), type: "number", nullable: true },
    { name: "away_ht", label: tx("1-taym (mehmon)"), type: "number", nullable: true },
    { name: "home_et", label: tx("Qo‘sh. vaqt (uy)"), type: "number", nullable: true },
    { name: "away_et", label: tx("Qo‘sh. vaqt (mehmon)"), type: "number", nullable: true },
    { name: "home_pen", label: tx("Penaltilar (uy)"), type: "number", nullable: true },
    { name: "away_pen", label: tx("Penaltilar (mehmon)"), type: "number", nullable: true },
    { name: "attendance", label: tx("Tomoshabinlar"), type: "number", nullable: true },
    { name: "video_url", label: tx("Videosharh havolasi"), type: "url" },
    { name: "added_time_1h", label: tx("Qo‘shilgan vaqt, 1-taym"), type: "number", nullable: true },
    { name: "added_time_2h", label: tx("Qo‘shilgan vaqt, 2-taym"), type: "number", nullable: true },
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
      form.setErrors({ away_team_id: tx("Jamoalar bir xil bo‘lishi mumkin emas") });
      return;
    }
    setBusy(true);
    try {
      if (m) {
        await api.patch(`/admin/matches/${m.id}`, body);
        toast(tx("Saqlandi"));
        onSaved();
      } else {
        const r = await api.post<{ id: number }>("/admin/matches", body);
        toast(tx("Match yaratildi"));
        nav(`/matches/${r.id}`, { replace: true });
      }
    } catch (err) {
      form.fail(err);
      toast(err instanceof Error ? err.message : tx("Xato"), "error");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!m || !(await confirm({ title: tx("Matchni o‘chirish"), text: tx("Match, uning voqealari va tarkiblari o‘chiriladi."), ok: tx("O‘chirish"), danger: true }))) return;
    try {
      await api.del(`/admin/matches/${m.id}`);
      toast(tx("O‘chirildi"));
      nav("/matches", { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    }
  }
  return (
    <form className="card card-pad" onSubmit={save}>
      {mode === "result" && detail && detail.events.length > 0 && (m?.status === "live" || m?.status === "halftime") && (
        <div className="alert info" style={{ marginBottom: 16 }}><I.alert size={16} />{" "}{tx("Jonli rejimda hisob voqealardan avtomatik hisoblanadi.")}</div>
      )}
      <FormFields fields={fields} values={form.values} set={form.set} errors={form.errors} />
      <div className="row" style={{ marginTop: 24, justifyContent: "space-between" }}>
        {m ? <Allowed to="delete" otherwise={<span />}><button type="button" className="btn btn-danger" onClick={remove}><I.trash size={16} />{" "}{tx("O‘chirish")}</button></Allowed> : <span />}
        <Allowed to={m ? "edit" : "create"}><button className="btn btn-primary" disabled={busy}>{busy ? tx("Saqlanmoqda…") : tx("Saqlash")}</button></Allowed>
      </div>
    </form>
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
      }, { "Idempotency-Key": uid() });
      setF({ ...f, minute: "", extra_minute: "", player_name: "", related_player_name: "", note: "" });
      toast(tx("Voqea qo‘shildi"));
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : tx("Xato"), "error");
    }
  }
  async function del(id: number) {
    if (!(await confirm({ title: tx("Voqeani o‘chirish"), ok: tx("O‘chirish"), danger: true }))) return;
    await api.del(`/admin/matches/${m.id}/events/${id}`).then(() => { toast(tx("O‘chirildi")); onChanged(); }, (e) => toast(e.message, "error"));
  }
  return (
    <div className="stack">
      <form className="card card-pad" onSubmit={add}>
        <div className="grid g4" style={{ alignItems: "end" }}>
          <div className="field"><label>{tx("Jamoa")}</label><select className="select" value={f.side} onChange={(e) => setF({ ...f, side: e.target.value })}><option value="home">{m.home?.name || tx("Uy egasi")}</option><option value="away">{m.away?.name || tx("Mehmon")}</option></select></div>
          <div className="field"><label>{tx("Voqea")}</label><select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{EVENT_LABEL[t]}</option>)}</select></div>
          <div className="field"><label>{tx("Daqiqa")}</label><div className="row"><input className="input" type="number" min={0} max={130} required value={f.minute} onChange={(e) => setF({ ...f, minute: e.target.value })} /><span>+</span><input className="input" type="number" min={0} max={30} value={f.extra_minute} onChange={(e) => setF({ ...f, extra_minute: e.target.value })} /></div></div>
          <div className="field"><label>{f.type === "sub" ? tx("Kirdi") : tx("O‘yinchi")}</label><input className="input" value={f.player_name} onChange={(e) => setF({ ...f, player_name: e.target.value })} /></div>
          {f.type === "sub" && <div className="field"><label>{tx("Chiqdi")}</label><input className="input" value={f.related_player_name} onChange={(e) => setF({ ...f, related_player_name: e.target.value })} /></div>}
          <div className="field"><label>{tx("Izoh")}</label><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
          <div><button className="btn btn-primary"><I.plus size={16} />{" "}{tx("Qo‘shish")}</button></div>
        </div>
      </form>
      <div className="card">
        {!events.length ? <Empty title={tx("Voqealar yo‘q")} /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{tx("Daqiqa")}</th><th>{tx("Jamoa")}</th><th>{tx("Voqea")}</th><th>{tx("O‘yinchi")}</th><th className="hide-mobile">{tx("Manba")}</th><th /></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="tnum b">{e.minute}{e.extra_minute ? `+${e.extra_minute}` : ""}′</td>
                  <td>{e.side === "home" ? m.home?.name : m.away?.name}</td>
                  <td>{EVENT_LABEL[e.type] || e.type}</td>
                  <td>{e.type === "formation" ? e.note : e.player_name}{e.related_player_name && <span className="muted"> ↔ {e.related_player_name}</span>}</td>
                  <td className="hide-mobile"><Badge plain>{e.source}</Badge></td>
                  <td className="actions"><button className="btn btn-ghost btn-sm btn-icon" onClick={() => del(e.id)} aria-label={tx("O‘chirish")}><I.trash size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
