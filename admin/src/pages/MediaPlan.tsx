import { useEffect, useMemo, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router";
import { api } from "@/lib/api";
import { Allowed, usePage } from "@/lib/auth";
import { useLoad } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import { PageHead } from "@/components/Layout";
import { Crest, Drawer, Empty, ErrorBox, Field, Loading, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { lang, tx } from "@/lib/i18n";

/* Media reja: the Instagram plan of every group, counted back from the group's
   final match. Team managers get the tasks in the Telegram bot and send the post
   links back; moderators approve them here or in the bot. */

/* ---------- types ---------- */
type State = "done" | "review" | "returned" | "overdue" | "today" | "upcoming";
type Checks = { kind?: string; account?: string; handle?: string; team?: string; on_time?: boolean; checked?: boolean };
export type MTask = {
  id: number; plan_id: number; group_id: number; group_code: string; team_id: number; team_name: string; ord: number;
  title: string; short: string; description: string; stage: number; with_bloggers: boolean; sponsor: string;
  target_team_id: number | null; target_name: string; day_offset: number; due_date: string; locked: boolean;
  status: string; link: string; checks: Checks; submitted_at: string | null; submitted_by: string; reviewed_at: string | null;
  reviewed_by: string; comment: string; note: string; final_date: string; state: State; label: string;
};
type MTeam = { id: number; name: string; short_name: string; crest_url: string; instagram: string; manager_name: string; manager_phone: string; bot: { username: string; name: string }[] };
type PlanSum = { id: number; group_id: number; final_match_id: number | null; final_date: string; team_ids: number[]; match_date: string; pending_date: string; start: string; end: string; total: number; done: number; review: number; overdue: number; today: number };
type Overview = {
  bot: boolean; today: string;
  kpi: { today_total: number; today_sent: number; review: number; overdue: number; done: number; total: number };
  groups: { id: number; code: string; name: string; teams: MTeam[]; plan: PlanSum | null; bot: number }[];
};
type FinalMatch = { id: number; kickoff_at: string | null; day: string; home: string; away: string; venue: string; round: string; status: string };
type MEvent = { id: number; task_id: number | null; at: string; kind: string; actor: string; text: string };
type GroupData = {
  bot: boolean; today: string; group: { id: number; code: string; name: string }; plan: PlanSum | null; final_match: FinalMatch | null;
  teams: MTeam[]; tasks: MTask[]; activity: MEvent[]; members_changed: boolean; members: number[] | null;
};
type Item = { id: number; ord: number; title: string; short: string; description: string; stage: number; with_bloggers: boolean; sponsor: string; rival: number; offsets: number[] };
type Settings = {
  evening_on: boolean; evening_time: string; morning_on: boolean; morning_time: string; deadline_time: string; overdue_on: boolean; overdue_time: string;
  escalate_time: string; report_on: boolean; report_time: string; auto_check: boolean; require_review: boolean;
};
type MovePreview = { from: string; to: string; days: number; moved: number; kept: number; overdue: number; locked: number; rows: { task_id: number; team: string; label: string; from: string; to: string }[] };

/* ---------- helpers ---------- */
const STATE_LABEL: Record<State, string> = {
  done: tx("Bajarildi"), review: tx("Tekshiruvda"), returned: tx("Qaytarildi"), overdue: tx("Kechikdi"), today: tx("Bugun"), upcoming: tx("Kutilmoqda"),
};
const LEGEND: State[] = ["done", "review", "today", "overdue", "returned", "upcoming"];
const WD = lang === "ru" ? ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"] : ["Ya", "Du", "Se", "Ch", "Pa", "Ju", "Sh"];
const MONTHS = lang === "ru"
  ? ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]
  : ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const WEEKDAY = lang === "ru"
  ? ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"]
  : ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];

const dayObj = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)); };
const short = (d: string) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "—");
const weekday = (d: string) => WD[dayObj(d).getUTCDay()];
const human = (d: string) => { if (!d) return "—"; const o = dayObj(d); return lang === "ru" ? `${o.getUTCDate()} ${MONTHS[o.getUTCMonth()]}, ${WEEKDAY[o.getUTCDay()]}` : `${o.getUTCDate()}-${MONTHS[o.getUTCMonth()]}, ${WEEKDAY[o.getUTCDay()]}`; };
const addDays = (d: string, n: number) => { const o = dayObj(d); o.setUTCDate(o.getUTCDate() + n); return o.toISOString().slice(0, 10); };
const diffDays = (a: string, b: string) => Math.round((dayObj(b).getTime() - dayObj(a).getTime()) / 86400000);
const dLabel = (off: number) => (off === 0 ? "D" : `D${off < 0 ? "−" : "+"}${Math.abs(off)}`);
const daysUntil = (today: string, d: string) => diffDays(today, d);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function StatePill({ state, label }: { state: State; label?: string }) {
  return <span className={`mr-pill mr-${state}`}><i />{label ?? STATE_LABEL[state]}</span>;
}
function SponsorTag({ s }: { s: string }) {
  if (!s) return null;
  return <span className={`mr-sponsor${s === "RWB" ? " rwb" : s === "CLICK" ? " click" : ""}`}>{s}</span>;
}
function Bar({ done, total }: { done: number; total: number }) {
  const p = total ? Math.round((done / total) * 100) : 0;
  return <div className="mr-bar"><span style={{ width: `${p}%` }} className={done === total && total > 0 ? "full" : ""} /></div>;
}
function BotStatus({ team }: { team: MTeam }) {
  const ok = team.bot.length > 0;
  return <span className={`mr-bot ${ok ? "ok" : "no"}`}><I.telegram size={12} />{ok ? tx("Bot ulangan") : team.manager_phone ? tx("Botga kirmagan") : tx("Menejer yo‘q")}</span>;
}

/* ---------- section ---------- */
export function MediaSection() {
  return (
    <Routes>
      <Route index element={<MediaOverview />} />
      <Route path="groups/:id" element={<MediaGroup />} />
      <Route path="template" element={<MediaTemplate />} />
      <Route path="review" element={<MediaReview />} />
      <Route path="*" element={<Empty title={tx("Sahifa topilmadi")} />} />
    </Routes>
  );
}

function BotOff() {
  return (
    <div className="alert warn" style={{ marginBottom: 16 }}>
      <I.alert size={16} />
      <div>{tx("Media bot ulanmagan — menejerlarga eslatmalar yuborilmaydi. Serverda TELEGRAM_MEDIA_BOT_TOKEN ni kiriting va API ni qayta ishga tushiring.")}</div>
    </div>
  );
}

/* ---------- M1 · overview ---------- */
function MediaOverview() {
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad(() => api.get<Overview>("/admin/media/overview"), []);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const k = data.kpi;
  const pct = k.total ? Math.round((k.done / k.total) * 100) : 0;
  return (
    <>
      <PageHead title={tx("Media reja")} sub={tx("Har bir guruh uchun Instagram reja: topshiriqlar final o‘yin sanasidan hisoblanadi, bot menejerlarga eslatadi")}
        actions={<>
          <Link className="btn" to="/media/template">{tx("Shablon")}</Link>
          <Link className="btn btn-primary" to="/media/review">{tx("Tekshiruv · {0}", k.review)}</Link>
        </>} />
      {!data.bot && <BotOff />}
      <div className="grid g4" style={{ marginBottom: 24 }}>
        <Kpi label={tx("Bugungi topshiriqlar")} value={String(k.today_total)} sub={tx("{0} tasi yuborildi, {1} tasi kutilmoqda", k.today_sent, k.today_total - k.today_sent)} />
        <Kpi label={tx("Tekshiruvda")} dot="amber" value={String(k.review)} sub={tx("Moderator tasdig‘ini kutmoqda")} to="/media/review" />
        <Kpi label={tx("Kechikkan")} dot="red" value={String(k.overdue)} sub={tx("Muddati o‘tgan, bajarilmagan")} />
        <Kpi label={tx("Mavsum bo‘yicha")} value={`${k.done} / ${k.total}`} sub={tx("{0}% bajarildi", pct)} />
      </div>
      <div className="row" style={{ marginBottom: 12 }}><h2 className="mr-h2">{tx("Guruhlar · {0}", data.groups.length)}</h2></div>
      {!data.groups.length ? (
        <div className="card"><Empty title={tx("Guruhlar yo‘q")} text={tx("Avval «Guruhlar» bo‘limida guruhlar va jamoalarni kiriting.")} /></div>
      ) : (
        <div className="card table-wrap">
          <table className="table mr-groups">
            <thead><tr>
              <th>{tx("Guruh")}</th><th>{tx("Jamoalar")}</th><th>{tx("Final o‘yin")}</th><th>{tx("Davr")}</th><th>{tx("Bajarildi")}</th><th>{tx("Holat")}</th><th>{tx("Bot")}</th><th />
            </tr></thead>
            <tbody>
              {data.groups.map((g) => {
                const p = g.plan;
                const left = p ? daysUntil(data.today, p.start) : 0;
                return (
                  <tr key={g.id} className="clickable" onClick={() => navigate(`/media/groups/${g.id}`)}>
                    <td><span className="mr-gcode">{g.code}</span></td>
                    <td><div className="mr-teams">{g.teams.map((t) => <span key={t.id}><Crest team={t} size={22} />{t.name}</span>)}{!g.teams.length && <span className="muted">{tx("Jamoa yo‘q")}</span>}</div></td>
                    <td className="nowrap">{p ? <span className="row" style={{ gap: 6 }}><I.calendar size={14} /><b>{short(p.final_date)} · {weekday(p.final_date)}</b></span> : <span className="mr-warn-text"><I.alert size={14} /> {tx("Tanlanmagan")}</span>}</td>
                    <td className="nowrap sec">{p ? `${short(p.start)} – ${short(p.end)}` : "—"}</td>
                    <td>{p ? <div className="mr-prog"><span><b>{p.done}</b> <span className="muted">/ {p.total}</span></span><Bar done={p.done} total={p.total} /></div> : <span className="muted small">{tx("Reja tuzilmagan")}</span>}</td>
                    <td>
                      <div className="row wrap" style={{ gap: 6 }}>
                        {!p && <span className="btn btn-sm">{tx("Rejani tuzish")}</span>}
                        {p && p.pending_date && <StatePill state="today" label={tx("Final ko‘chdi")} />}
                        {p && p.done === p.total && p.total > 0 && <StatePill state="done" label={tx("Tugadi")} />}
                        {p && p.overdue > 0 && <StatePill state="overdue" label={tx("{0} kechikdi", p.overdue)} />}
                        {p && p.review > 0 && <StatePill state="review" label={tx("{0} tekshiruvda", p.review)} />}
                        {p && p.today > 0 && p.final_date !== data.today && <StatePill state="today" label={tx("Bugun {0}", p.today)} />}
                        {p && p.final_date === data.today && <StatePill state="today" label={tx("Bugun final")} />}
                        {p && left > 0 && <StatePill state="upcoming" label={tx("{0} kundan keyin", left)} />}
                      </div>
                    </td>
                    <td className="nowrap"><span className={`mr-bot ${g.bot === g.teams.length && g.teams.length ? "ok" : g.bot ? "part" : "no"}`}><I.telegram size={13} />{g.bot}/{g.teams.length}</span></td>
                    <td className="right muted">›</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="mr-note"><I.calendar size={16} /><span>{tx("Guruh uchun final o‘yin tanlansa, reja shablondan o‘zi tuziladi: har bir jamoa uchun 7 ta topshiriq. Match sanasi ko‘chirilsa, reja surishni taklif qiladi.")}</span></div>
    </>
  );
}

function Kpi({ label, value, sub, dot, to }: { label: string; value: string; sub: string; dot?: "amber" | "red"; to?: string }) {
  const body = <>
    <div className="mr-kpi-head">{label}{dot && <i className={`mr-dot ${dot}`} />}</div>
    <div className="val">{value}</div>
    <small>{sub}</small>
  </>;
  return to ? <Link to={to} className="card kpi mr-kpi">{body}</Link> : <div className="card kpi mr-kpi">{body}</div>;
}

/* ---------- M2 · group plan ---------- */
function MediaGroup() {
  const { id } = useParams();
  const gid = Number(id);
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const pg = usePage();
  const { data, error, loading, reload } = useLoad(() => api.get<GroupData>(`/admin/media/groups/${gid}`), [gid]);
  const groups = useLoad(() => api.get<{ items: { id: number; code: string }[] }>("/admin/groups?limit=200"), []);
  const [task, setTask] = useState<number | null>(null);
  const [move, setMove] = useState<"pending" | "manual" | null>(null);
  const [manager, setManager] = useState<MTeam | null>(null);
  const [order, setOrder] = useState(false);
  const [busy, setBusy] = useState(false);

  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const p = data.plan;
  const teamsLine = data.teams.map((t) => t.name).join(" · ");

  async function remind() {
    if (!p) return;
    setBusy(true);
    try {
      const r = await api.post<{ sent: number; no_bot: string[] }>(`/admin/media/plans/${p.id}/remind`);
      toast(r.no_bot.length ? tx("Eslatma yuborildi: {0} ta. Botga ulanmagan: {1}", r.sent, r.no_bot.join(", ")) : tx("Eslatma yuborildi: {0} ta", r.sent), r.sent ? "ok" : "info");
      reload();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  async function del() {
    if (!p || !(await confirm({ title: tx("Rejani o‘chirish?"), text: tx("Guruhning barcha topshiriqlari, havolalari va tarixi o‘chadi. Shablondan qayta tuzish mumkin."), ok: tx("O‘chirish"), danger: true }))) return;
    try {
      await api.del(`/admin/media/plans/${p.id}`);
      toast(tx("Reja o‘chirildi"));
      reload();
    } catch (e) {
      toast(errText(e), "error");
    }
  }
  async function syncMembers() {
    if (!p || !data?.members?.length) return;
    try {
      await api.put(`/admin/media/plans/${p.id}/teams`, { team_ids: data.members });
      toast(tx("Jamoalar yangilandi"));
      reload();
    } catch (e) {
      toast(errText(e), "error");
    }
  }

  return (
    <>
      <PageHead title={tx("Guruh {0} — media reja", data.group.code)} sub={p ? tx("{0} — {1} kunlik sikl, final o‘yinga qarab hisoblanadi", teamsLine, diffDays(p.start, p.end) + 1) : teamsLine}
        actions={<>
          <Link className="btn" to="/media">{tx("Barcha guruhlar")}</Link>
          {p && <Allowed to="edit"><button className="btn btn-primary" onClick={remind} disabled={busy || !data.bot} title={!data.bot ? tx("Media bot ulanmagan") : undefined}><I.telegram size={16} /> {tx("Menejerlarga eslatma")}</button></Allowed>}
        </>} />
      <div className="tabs" style={{ marginBottom: 16 }}>
        {(groups.data?.items || []).map((g) => (
          <button key={g.id} aria-selected={g.id === gid} onClick={() => navigate(`/media/groups/${g.id}`)}>{tx("Guruh {0}", g.code)}</button>
        ))}
      </div>
      {!data.bot && <BotOff />}
      {p?.pending_date && (
        <div className="alert warn" style={{ marginBottom: 16 }}>
          <I.calendar size={16} />
          <div className="grow">{tx("Final o‘yin {0} dan {1} ga ko‘chirildi. Media rejani ham surasizmi?", short(p.final_date), short(p.pending_date))}</div>
          <Allowed to="edit"><button className="btn btn-sm" onClick={() => setMove("pending")}>{tx("Ko‘rib chiqish")}</button></Allowed>
        </div>
      )}
      {p && data.members_changed && (
        <div className="alert info" style={{ marginBottom: 16 }}>
          <I.users size={16} />
          <div className="grow">{tx("Guruh tarkibi o‘zgardi. Rejani guruhning hozirgi jamoalariga moslash mumkin — bajarilganlar saqlanadi.")}</div>
          <Allowed to="edit"><button className="btn btn-sm" onClick={syncMembers}>{tx("Rejani yangilash")}</button></Allowed>
        </div>
      )}
      {!p ? <CreatePlan groupID={gid} hasTeams={data.teams.length > 0} onDone={reload} /> : (
        <>
          <div className="card mr-anchor">
            <div className="mr-anchor-final">
              <div className="mr-over">{tx("Final o‘yin — reja shu sanadan hisoblanadi")}</div>
              <div className="row" style={{ gap: 10 }}><I.calendar size={20} /><span className="mr-final-day">{human(p.final_date)}{data.final_match?.kickoff_at ? ` · ${fmtDateTime(data.final_match.kickoff_at).slice(-5)}` : ""}</span></div>
              {data.final_match ? (
                <Link to={`/matches/${data.final_match.id}`} className="sec small row" style={{ gap: 6 }}><I.link size={14} />{data.final_match.home} — {data.final_match.away}{data.final_match.venue ? ` · ${data.final_match.venue}` : ""}</Link>
              ) : <span className="muted small">{tx("Sana qo‘lda kiritilgan — match bilan bog‘lanmagan")}</span>}
              <span className="muted small">{tx("Match sanasi o‘zgarsa, bajarilmagan topshiriqlarni surish taklif qilinadi")}</span>
            </div>
            <div className="mr-anchor-col">
              <div className="mr-over">{tx("Davr")}</div>
              <b>{short(p.start)} – {short(p.end)}</b>
              <span className="muted small">{tx("{0} kun · {1} topshiriq", diffDays(p.start, p.end) + 1, p.total)}</span>
            </div>
            <div className="mr-anchor-col" style={{ minWidth: 170 }}>
              <div className="mr-over">{tx("Bajarildi")}</div>
              <div><span className="mr-big">{p.done}</span> <span className="muted">/ {p.total}</span></div>
              <Bar done={p.done} total={p.total} />
            </div>
            <div className="stack" style={{ gap: 6 }}>
              {p.overdue > 0 && <StatePill state="overdue" label={tx("{0} kechikdi", p.overdue)} />}
              {p.review > 0 && <StatePill state="review" label={tx("{0} tekshiruvda", p.review)} />}
            </div>
            <Allowed to="edit">
              <div className="stack" style={{ gap: 8 }}>
                <button className="btn" onClick={() => setMove("manual")}>{tx("Sanani o‘zgartirish")}</button>
                <button className="btn btn-ghost btn-sm" onClick={del}><I.trash size={14} /> {tx("Rejani o‘chirish")}</button>
              </div>
            </Allowed>
          </div>
          <PlanGrid data={data} plan={p} onTask={setTask} onOrder={pg.edit ? () => setOrder(true) : undefined} />
          <div className="grid g2" style={{ marginTop: 24, alignItems: "start" }}>
            <div className="card">
              <div className="card-head"><h3>{tx("Menejerlar va bot")}</h3></div>
              <div className="mr-list">
                {data.teams.map((t) => (
                  <div key={t.id} className="mr-mgr">
                    <Crest team={t} size={28} />
                    <div className="grow">
                      <b>{t.name}</b>
                      <div className="muted small">{t.manager_phone ? `${t.manager_name || tx("Menejer")} · ${fmtPhone(t.manager_phone)}` : tx("Menejer biriktirilmagan")}</div>
                    </div>
                    {t.instagram && <span className="small sec nowrap"><I.camera size={13} /> {t.instagram}</span>}
                    <BotStatus team={t} />
                    <Allowed to="edit"><button className="btn btn-sm" onClick={() => setManager(t)}>{t.manager_phone ? tx("O‘zgartirish") : tx("Biriktirish")}</button></Allowed>
                  </div>
                ))}
              </div>
              <div className="mr-hint">{tx("Menejer Media botda (Live-pult emas) /start ni bosadi va «Telefon raqamni yuborish» tugmasi orqali shu raqamni yuboradi — shundan keyin eslatmalar keladi.")}</div>
            </div>
            <div className="card">
              <div className="card-head"><h3>{tx("So‘nggi harakatlar")}</h3></div>
              {!data.activity.length ? <Empty title={tx("Hali harakat yo‘q")} /> : (
                <div className="mr-list">
                  {data.activity.slice(0, 12).map((e) => (
                    <div key={e.id} className="mr-act">
                      <span className="muted small nowrap">{fmtDateTime(e.at)}</span>
                      <span className="grow">{e.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
      {task && <TaskDrawer id={task} team={data.teams} onClose={() => setTask(null)} onChange={reload} />}
      {move && p && <MoveModal plan={p} groupID={gid} pending={move === "pending"} onClose={() => setMove(null)} onDone={() => { setMove(null); reload(); }} />}
      {manager && <ManagerModal team={manager} onClose={() => setManager(null)} onDone={() => { setManager(null); reload(); }} />}
      {order && p && <OrderModal plan={p} teams={data.teams} onClose={() => setOrder(false)} onDone={() => { setOrder(false); reload(); }} />}
    </>
  );
}

function PlanGrid({ data, plan, onTask, onOrder }: { data: GroupData; plan: PlanSum; onTask: (id: number) => void; onOrder?: () => void }) {
  const days = useMemo(() => {
    const n = diffDays(plan.start, plan.end);
    return Array.from({ length: Math.max(1, n + 1) }, (_, i) => addDays(plan.start, i));
  }, [plan.start, plan.end]);
  const byCell = useMemo(() => {
    const m = new Map<string, MTask[]>();
    for (const t of data.tasks) {
      const k = `${t.team_id}:${t.due_date}`;
      m.set(k, [...(m.get(k) || []), t]);
    }
    return m;
  }, [data.tasks]);
  // stages: from the first team's tasks; a band runs until the next stage starts
  const phases = useMemo(() => {
    const first = plan.team_ids[0];
    const mine = data.tasks.filter((t) => t.team_id === first);
    const stages = [...new Set(mine.map((t) => t.stage))].sort((a, b) => a - b);
    const starts = stages.map((s) => mine.filter((t) => t.stage === s).reduce((d, t) => (t.due_date < d ? t.due_date : d), "9999"));
    return stages.map((s, i) => {
      const from = i === 0 ? plan.start : starts[i];
      const to = i + 1 < stages.length ? addDays(starts[i + 1], -1) : plan.end;
      const ts = data.tasks.filter((t) => t.stage === s);
      const names = [...new Set(ts.map((t) => (t.sponsor ? tx("Homiy") : t.short || t.title).toLowerCase()))];
      const joined = names.join(lang === "ru" ? " и " : " va ");
      const blog = ts.some((t) => t.with_bloggers);
      const span = Math.max(1, diffDays(from, to) + 1);
      return { stage: s, span, title: `${tx("{0}-bosqich", s)} · ${joined.charAt(0).toUpperCase()}${joined.slice(1)}`, sub: blog ? tx("blogerlar bilan") : tx("jamoa o‘zi") };
    });
  }, [data.tasks, plan]);
  const cols = `176px repeat(${days.length}, minmax(76px, 1fr))`;
  return (
    <div className="card mr-grid-card">
      <div className="mr-grid" style={{ gridTemplateColumns: cols }}>
        <div />
        {phases.map((ph) => <div key={ph.stage} className="mr-phase" style={{ gridColumn: `span ${ph.span}` }}><b>{ph.title}</b><span>{ph.sub}</span></div>)}
        <div className="mr-th">{tx("Jamoa")}{onOrder && <button className="btn btn-ghost btn-sm mr-order" onClick={onOrder} title={tx("Jamoalar tartibi")}>⇅</button>}</div>
        {days.map((d) => {
          const off = diffDays(plan.final_date, d);
          const today = d === data.today;
          return (
            <div key={d} className={`mr-day${today ? " today" : ""}`}>
              <span><b>{short(d)}</b> <span className="mr-wd">{weekday(d)}</span></span>
              <span className={`mr-off${off === 0 ? " final" : ""}`}>{today ? tx("Bugun") : off === 0 ? tx("Final") : dLabel(off)}</span>
            </div>
          );
        })}
        {plan.team_ids.map((tid, pos) => {
          const team = data.teams.find((t) => t.id === tid);
          if (!team) return null;
          return [
            <div key={`l${tid}`} className="mr-lead">
              <Crest team={team} size={30} />
              <div className="grow" style={{ minWidth: 0 }}>
                <b className="ellipsis" style={{ display: "block" }}>{team.name}</b>
                <span className="muted small ellipsis" style={{ display: "block" }}>{tx("{0}-jamoa", pos + 1)}{team.manager_name ? ` · ${team.manager_name}` : ""}</span>
                <BotStatus team={team} />
              </div>
            </div>,
            ...days.map((d) => {
              const list = byCell.get(`${tid}:${d}`) || [];
              if (!list.length) return <div key={`${tid}${d}`} className={`mr-empty${d === data.today ? " today" : ""}`} />;
              return (
                <div key={`${tid}${d}`} className="mr-cellwrap">
                  {list.map((t) => (
                    <button key={t.id} className={`mr-cell mr-${t.state}`} onClick={() => onTask(t.id)} title={t.label}>
                      <span className="mr-cell-top"><b>{t.sponsor ? tx("Homiy") : t.short || t.title}</b>{t.locked && <I.lock size={11} />}<CellIcon s={t.state} /></span>
                      <span className="mr-cell-sub">{cellSub(t)}<SponsorTag s={t.sponsor} /></span>
                    </button>
                  ))}
                </div>
              );
            }),
          ];
        })}
      </div>
      <div className="mr-legend">
        {LEGEND.map((s) => <StatePill key={s} state={s} />)}
        <span className="muted small">{tx("Katakni bosing — topshiriq tafsiloti va tekshiruv.")}</span>
      </div>
    </div>
  );
}

/** The second line of a grid cell: the rival, or the rest of the title after the short name. */
function cellSub(t: MTask) {
  if (t.target_name) return `→ ${t.target_name}`;
  if (t.sponsor || !t.short || t.short === t.title) return "";
  if (t.title.startsWith(t.short)) {
    const rest = t.title.slice(t.short.length).replace(/^[\s—–-]+/, "");
    return rest.includes(" ") && !t.title.startsWith(t.short + " ") ? rest.slice(rest.indexOf(" ") + 1) : rest;
  }
  return "";
}

/** +998901234567 → +998 90 123 45 67 */
const fmtPhone = (p: string) => (/^998\d{9}$/.test(p) ? `+998 ${p.slice(3, 5)} ${p.slice(5, 8)} ${p.slice(8, 10)} ${p.slice(10)}` : `+${p}`);

function CellIcon({ s }: { s: State }) {
  switch (s) {
    case "done": return <I.check size={12} />;
    case "review": return <I.eye size={12} />;
    case "overdue": return <I.alert size={12} />;
    case "returned": return <I.refresh size={12} />;
    case "today": return <I.calendar size={12} />;
    default: return null;
  }
}

/* ---------- create a plan ---------- */
function CreatePlan({ groupID, hasTeams, onDone }: { groupID: number; hasTeams: boolean; onDone: () => void }) {
  const toast = useToast();
  const cands = useLoad(() => api.get<{ items: FinalMatch[] }>(`/admin/media/groups/${groupID}/matches`), [groupID]);
  const [mode, setMode] = useState<"match" | "date">("match");
  const [matchID, setMatchID] = useState<number | "">("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const pg = usePage();
  useEffect(() => {
    const list = cands.data?.items || [];
    if (list.length && matchID === "") setMatchID(list[0].id);
    if (cands.data && !list.length) setMode("date");
  }, [cands.data, matchID]);
  async function create() {
    setBusy(true);
    try {
      await api.post(`/admin/media/groups/${groupID}/plan`, mode === "match" ? { final_match_id: matchID || null } : { final_date: date });
      toast(tx("Reja tuzildi"));
      onDone();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  if (!hasTeams) return <div className="card"><Empty title={tx("Guruhda jamoa yo‘q")} text={tx("Avval «Guruhlar» bo‘limida jamoalarni qo‘shing.")} /></div>;
  return (
    <div className="card card-pad mr-create">
      <h2 className="mr-h2">{tx("Reja hali tuzilmagan")}</h2>
      <p className="sec">{tx("Guruhning final o‘yinini tanlang — shablondagi topshiriqlar shu kundan orqaga hisoblanadi (D−10 … D).")}</p>
      {!pg.edit ? <p className="muted">{tx("Reja tuzish uchun «Media reja» sahifasini tahrirlash huquqi kerak.")}</p> : (
        <>
          <div className="seg" style={{ marginBottom: 16 }}>
            <button aria-pressed={mode === "match"} onClick={() => setMode("match")}>{tx("Matchdan")}</button>
            <button aria-pressed={mode === "date"} onClick={() => setMode("date")}>{tx("Sanani qo‘lda")}</button>
          </div>
          {mode === "match" ? (
            <Field label={tx("Final o‘yin")} hint={!cands.data?.items.length ? tx("Guruh jamoalarining sanasi kiritilgan matchlari yo‘q") : tx("Match sanasi o‘zgarsa, reja surishni taklif qiladi")}>
              <select className="select" value={matchID} onChange={(e) => setMatchID(e.target.value ? Number(e.target.value) : "")}>
                {(cands.data?.items || []).map((m) => <option key={m.id} value={m.id}>{short(m.day)} · {m.home} — {m.away}{m.venue ? ` · ${m.venue}` : ""}</option>)}
              </select>
            </Field>
          ) : (
            <Field label={tx("Final kuni")}><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 220 }} /></Field>
          )}
          <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy || (mode === "match" ? !matchID : !date)} onClick={create}>{tx("Rejani tuzish")}</button>
        </>
      )}
    </div>
  );
}

/* ---------- M3 · task drawer ---------- */
function TaskDrawer({ id, team, onClose, onChange }: { id: number; team: MTeam[]; onClose: () => void; onChange: () => void }) {
  const toast = useToast();
  const pg = usePage();
  const { data, error, reload } = useLoad(() => api.get<{ task: MTask; events: MEvent[]; team: MTeam | null }>(`/admin/media/tasks/${id}`), [id]);
  const [comment, setComment] = useState("");
  const [link, setLink] = useState("");
  const [date, setDate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = data?.task;
  const tm = data?.team || team.find((x) => x.id === t?.team_id) || null;

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      setComment("");
      setLink("");
      setDate(null);
      reload();
      onChange();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  const title = t ? (
    <div className="row" style={{ gap: 12 }}>
      {tm && <Crest team={tm} size={40} />}
      <div><div className="mr-over">{t.team_name} · {t.group_code ? tx("Guruh {0}", t.group_code) : ""}</div><div>{t.label}</div></div>
    </div>
  ) : tx("Topshiriq");
  return (
    <Drawer title={title} onClose={onClose}>
      {error ? <ErrorBox error={error} retry={reload} /> : !t ? <Loading /> : (
        <div className="stack" style={{ gap: 20 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <StatePill state={t.state} />
            <span className="sec">{human(t.due_date)} · {tx("muddat 23:59")} · {dLabel(diffDays(t.final_date, t.due_date))}</span>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="tag">{tx("{0}-bosqich", t.stage)}</span>
            <span className="tag">{t.with_bloggers ? tx("Blogerlar bilan") : tx("Jamoa o‘zi")}</span>
            {t.sponsor && <SponsorTag s={t.sponsor} />}
          </div>
          <div>
            <div className="mr-over">{tx("Topshiriq (botda shu matn ketadi)")}</div>
            <p style={{ margin: "6px 0 0" }}>{t.description || <span className="muted">{tx("Izoh yo‘q")}</span>}</p>
          </div>
          {t.link ? (
            <div className="card card-pad mr-sub">
              <div className="row" style={{ gap: 10 }}>
                <span className="mr-ig"><I.camera size={18} /></span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <a href={t.link} target="_blank" rel="noopener noreferrer" className="b ellipsis" style={{ display: "block" }}>{t.link.replace(/^https:\/\/www\./, "")}</a>
                  <span className="muted small">{t.submitted_at ? fmtDateTime(t.submitted_at) : ""} · {t.submitted_by}</span>
                </div>
                <a className="btn btn-sm" href={t.link} target="_blank" rel="noopener noreferrer">{tx("Ochish")}</a>
              </div>
              <ChecksList c={t.checks} />
            </div>
          ) : (
            <div className="mr-empty-box">
              <span className="muted">{tx("Havola hali yuborilmagan.")}</span>
              {pg.edit && t.status !== "done" && (
                <div className="row" style={{ marginTop: 10 }}>
                  <input className="input input-sm grow" placeholder="https://www.instagram.com/reel/…" value={link} onChange={(e) => setLink(e.target.value)} />
                  <button className="btn btn-sm" disabled={busy || !link.trim()} onClick={() => act(() => api.post(`/admin/media/tasks/${t.id}/submit`, { link }), tx("Havola saqlandi"))}>{tx("Havolani kiritish")}</button>
                </div>
              )}
            </div>
          )}
          {t.note && <div className="alert info"><I.telegram size={16} /><div>{tx("Menejer:")} {t.note}</div></div>}
          {t.status === "returned" && t.comment && <div className="alert warn"><I.refresh size={16} /><div>{tx("Qaytarilgan:")} «{t.comment}»</div></div>}
          {t.status === "done" && t.reviewed_at && <div className="alert ok"><I.check size={16} /><div>{tx("Tasdiqlangan: {0}", fmtDateTime(t.reviewed_at))}{t.reviewed_by ? ` · ${t.reviewed_by}` : ""}</div></div>}
          {pg.edit && t.status !== "done" && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="mr-over">{tx("Moderator izohi")}</div>
              <textarea className="textarea" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={tx("Qaytarishda majburiy — menejerga botda ko‘rinadi")} />
              <div className="row">
                <button className="btn grow" disabled={busy || !comment.trim()} onClick={() => act(() => api.post(`/admin/media/tasks/${t.id}/return`, { comment }), tx("Qaytarildi — menejerga yuborildi"))}>{tx("Qaytarish")}</button>
                <button className="btn btn-primary grow" disabled={busy} onClick={() => act(() => api.post(`/admin/media/tasks/${t.id}/approve`), tx("Tasdiqlandi"))}>{tx("Tasdiqlash")}</button>
              </div>
            </div>
          )}
          <div className="card card-pad">
            <div className="row" style={{ gap: 10 }}>
              <I.calendar size={16} />
              <span className="grow">{tx("Sana:")} <b>{short(t.due_date)}</b> {t.locked ? tx("(qo‘lda)") : tx("(shablon bo‘yicha)")}</span>
              {pg.edit && t.status !== "done" && date === null && <button className="btn btn-ghost btn-sm" onClick={() => setDate(t.due_date)}>{tx("O‘zgartirish")}</button>}
            </div>
            {date !== null && (
              <div className="row" style={{ marginTop: 10 }}>
                <input type="date" className="input input-sm" value={date} onChange={(e) => setDate(e.target.value)} />
                <button className="btn btn-sm btn-primary" disabled={busy || !date} onClick={() => act(() => api.patch(`/admin/media/tasks/${t.id}`, { due_date: date }), tx("Sana saqlandi"))}>{tx("Saqlash")}</button>
                {t.locked && <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api.patch(`/admin/media/tasks/${t.id}`, { due_date: "" }), tx("Shablon sanasi qaytarildi"))}>{tx("Shablon sanasi")}</button>}
                <button className="btn btn-sm btn-ghost" onClick={() => setDate(null)}>{tx("Bekor qilish")}</button>
              </div>
            )}
            <div className="muted small" style={{ marginTop: 8 }}>{tx("Qo‘lda o‘zgartirilgan sana qulflanadi: final ko‘chsa ham bu topshiriq joyida qoladi.")}</div>
          </div>
          <div>
            <div className="mr-over" style={{ marginBottom: 8 }}>{tx("Tarix")}</div>
            {!data.events.length ? <span className="muted small">{tx("Hali harakat yo‘q")}</span> : data.events.map((e) => (
              <div key={e.id} className="mr-act"><span className="muted small nowrap">{fmtDateTime(e.at)}</span><span className="grow">{e.text}</span></div>
            ))}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function ChecksList({ c }: { c: Checks }) {
  const kind = c.kind === "reel" ? "Instagram Reels" : c.kind === "story" ? "Instagram stories" : tx("Instagram post");
  return (
    <div className="mr-checks">
      <span className="ok"><I.check size={13} /> {kind}</span>
      {c.account === "match" && <span className="ok"><I.check size={13} /> {c.handle ? tx("Akkaunt @{0} — jamoaning akkaunti", c.handle) : tx("Jamoaning akkaunti")}</span>}
      {c.account === "mismatch" && <span className="bad"><I.alert size={13} /> {tx("@{0} — jamoa akkaunti (@{1}) emas", c.handle || "", c.team || "")}</span>}
      {(!c.account || c.account === "unknown") && <span className="mid"><I.eye size={13} /> {c.checked === false ? tx("Akkaunt tekshirilmadi") : tx("Akkaunt havolada ko‘rinmaydi — Instagramda tekshiring")}</span>}
      {c.on_time ? <span className="ok"><I.check size={13} /> {tx("Muddatda")}</span> : <span className="bad"><I.alert size={13} /> {tx("Muddatdan keyin")}</span>}
    </div>
  );
}

/* ---------- M5 · move the plan ---------- */
function MoveModal({ plan, groupID, pending, onClose, onDone }: { plan: PlanSum; groupID: number; pending: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const cands = useLoad(() => api.get<{ items: FinalMatch[] }>(`/admin/media/groups/${groupID}/matches`), [groupID]);
  const [mode, setMode] = useState<"match" | "date">(plan.final_match_id ? "match" : "date");
  const [matchID, setMatchID] = useState<number | "">(plan.final_match_id ?? "");
  const [date, setDate] = useState(pending ? plan.pending_date : plan.final_date);
  const [pv, setPv] = useState<MovePreview | null>(null);
  const [pvErr, setPvErr] = useState("");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const body = mode === "match" ? { final_match_id: matchID || null } : { final_date: date };
  const key = JSON.stringify(body);
  useEffect(() => {
    let off = false;
    setPvErr("");
    api.post<MovePreview>(`/admin/media/plans/${plan.id}/preview`, JSON.parse(key)).then((r) => !off && setPv(r)).catch((e) => !off && (setPv(null), setPvErr(errText(e))));
    return () => { off = true; };
  }, [key, plan.id]);
  async function go() {
    setBusy(true);
    try {
      const r = await api.post<{ moved: number }>(`/admin/media/plans/${plan.id}/move`, { ...body, notify });
      toast(tx("Reja surildi: {0} ta topshiriq", r.moved));
      onDone();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  async function keep() {
    setBusy(true);
    try {
      await api.post(`/admin/media/plans/${plan.id}/keep`);
      toast(tx("Reja o‘zgarmadi"));
      onDone();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  const days = pv?.days ?? 0;
  return (
    <Modal title={pending ? tx("Final o‘yin ko‘chirildi") : tx("Final sanasini o‘zgartirish")} onClose={onClose} footer={<>
      {pending ? <button className="btn btn-ghost" onClick={keep} disabled={busy}>{tx("Rejani o‘zgartirmaslik")}</button> : <button className="btn btn-ghost" onClick={onClose}>{tx("Bekor qilish")}</button>}
      <button className="btn btn-primary" onClick={go} disabled={busy || !pv || days === 0}>{days === 0 ? tx("Sana o‘zgarmadi") : days > 0 ? tx("Rejani {0} kunga surish", days) : tx("Rejani {0} kun oldinga surish", -days)}</button>
    </>}>
      <div className="stack" style={{ gap: 16 }}>
        {!pending && (
          <>
            <div className="seg">
              <button aria-pressed={mode === "match"} onClick={() => setMode("match")}>{tx("Matchdan")}</button>
              <button aria-pressed={mode === "date"} onClick={() => setMode("date")}>{tx("Sanani qo‘lda")}</button>
            </div>
            {mode === "match" ? (
              <Field label={tx("Final o‘yin")}>
                <select className="select" value={matchID} onChange={(e) => setMatchID(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">—</option>
                  {(cands.data?.items || []).map((m) => <option key={m.id} value={m.id}>{short(m.day)} · {m.home} — {m.away}</option>)}
                </select>
              </Field>
            ) : <Field label={tx("Final kuni")} hint={tx("Sana qo‘lda kiritilsa, reja match bilan bog‘lanmaydi")}><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 220 }} /></Field>}
          </>
        )}
        {pvErr && <div className="alert danger"><I.alert size={16} /><div>{pvErr}</div></div>}
        {pv && (
          <>
            <div className="mr-move">
              <div><div className="mr-over">{tx("Eski sana")}</div><s className="muted">{short(pv.from)} · {weekday(pv.from)}</s></div>
              <I.arrow size={18} />
              <div><div className="mr-over">{tx("Yangi sana")}</div><b>{short(pv.to)} · {weekday(pv.to)}</b></div>
              <span className="grow" />
              {days !== 0 && <span className="tag navy">{days > 0 ? `+${days}` : days} {tx("kun")}</span>}
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <span className="row" style={{ gap: 8 }}><I.refresh size={15} />{tx("{0} ta kelgusi topshiriq suriladi", pv.moved)}</span>
              <span className="row" style={{ gap: 8 }}><I.check size={15} />{tx("{0} ta bajarilgan yoki tekshiruvdagi joyida qoladi", pv.kept)}</span>
              {pv.overdue > 0 && <span className="row" style={{ gap: 8 }}><I.alert size={15} />{tx("{0} ta kechikkan topshiriq kechikkan holicha qoladi", pv.overdue)}</span>}
              <span className="row" style={{ gap: 8 }}><I.lock size={15} />{tx("Qo‘lda sanasi qulflangan: {0}", pv.locked)}</span>
            </div>
            {days !== 0 && pv.rows.length > 0 && (
              <div className="card table-wrap">
                <table className="table">
                  <thead><tr><th>{tx("Jamoa")}</th><th>{tx("Topshiriq")}</th><th>{tx("Eski")}</th><th>{tx("Yangi")}</th></tr></thead>
                  <tbody>
                    {pv.rows.slice(0, 6).map((r) => <tr key={r.task_id}><td>{r.team}</td><td>{r.label}</td><td><s className="muted">{short(r.from)}</s></td><td><b>{short(r.to)}</b></td></tr>)}
                  </tbody>
                </table>
                {pv.rows.length > 6 && <div className="muted small" style={{ padding: "8px 16px" }}>{tx("+ yana {0} ta topshiriq", pv.rows.length - 6)}</div>}
              </div>
            )}
            <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />{tx("Menejerlarga botda yangi jadvalni yuborish")}</label>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ---------- manager and order ---------- */
function ManagerModal({ team, onClose, onDone }: { team: MTeam; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(team.manager_name);
  const [phone, setPhone] = useState(team.manager_phone ? fmtPhone(team.manager_phone) : "");
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function save(clear = false) {
    setBusy(true);
    setErr({});
    try {
      await api.put(`/admin/media/teams/${team.id}/manager`, clear ? { name: "", phone: "" } : { name, phone });
      toast(clear ? tx("Menejer olib tashlandi") : tx("Menejer saqlandi"));
      onDone();
    } catch (e: any) {
      setErr(e?.fields || {});
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={tx("{0} — menejer", team.name)} onClose={onClose} footer={<>
      {team.manager_phone && <button className="btn btn-ghost" onClick={() => save(true)} disabled={busy}>{tx("Olib tashlash")}</button>}
      <button className="btn" onClick={onClose}>{tx("Bekor qilish")}</button>
      <button className="btn btn-primary" onClick={() => save()} disabled={busy || !phone.trim()}>{tx("Saqlash")}</button>
    </>}>
      <div className="stack">
        <Field label={tx("Ism")} error={err.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("Masalan: Aziz R.")} /></Field>
        <Field label={tx("Telefon")} error={err.phone} hint={tx("Shu raqam bilan botga kiradi. Raqam o‘zgarsa, eski Telegram ulanishi o‘chadi.")}><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+998 90 123 45 67" inputMode="tel" /></Field>
        <div className="alert info"><I.telegram size={16} /><div>{tx("Menejer Media botda (Live-pult emas) /start ni bosadi va «Telefon raqamni yuborish» tugmasini bosadi. Kechqurun va ertalab topshiriqlar keladi, post havolasini shu yerga yuboradi.")}</div></div>
      </div>
    </Modal>
  );
}

function OrderModal({ plan, teams, onClose, onDone }: { plan: PlanSum; teams: MTeam[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [ids, setIds] = useState(plan.team_ids);
  const [busy, setBusy] = useState(false);
  const moveTo = (i: number, d: number) => setIds((l) => { const n = [...l]; const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n; });
  async function save() {
    setBusy(true);
    try {
      await api.put(`/admin/media/plans/${plan.id}/teams`, { team_ids: ids });
      toast(tx("Tartib saqlandi"));
      onDone();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={tx("Jamoalar tartibi")} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{tx("Bekor qilish")}</button>
      <button className="btn btn-primary" onClick={save} disabled={busy}>{tx("Saqlash")}</button>
    </>}>
      <p className="sec" style={{ marginTop: 0 }}>{tx("1-jamoa D−10 dan boshlaydi, 2-jamoa bir kun keyin, 3-jamoa ikki kun keyin. Faqat kelgusi topshiriqlar qayta hisoblanadi.")}</p>
      <div className="stack" style={{ gap: 8 }}>
        {ids.map((id, i) => {
          const t = teams.find((x) => x.id === id);
          return (
            <div key={id} className="mr-order-row">
              <b className="tnum">{i + 1}</b><Crest team={t || null} size={26} /><span className="grow">{t?.name}</span>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => moveTo(i, -1)} disabled={i === 0}><I.up size={16} /></button>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => moveTo(i, 1)} disabled={i === ids.length - 1}><I.down size={16} /></button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

/* ---------- M4 · template ---------- */
function MediaTemplate() {
  const toast = useToast();
  const pg = usePage();
  const { data, error, loading, reload } = useLoad(() => api.get<{ items: Item[]; settings: Settings }>("/admin/media/template"), []);
  const [items, setItems] = useState<Item[]>([]);
  const [st, setSt] = useState<Settings | null>(null);
  const [apply, setApply] = useState<"new" | "unstarted" | "running">("unstarted");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) {
      setItems(data.items);
      setSt(data.settings);
    }
  }, [data]);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if ((loading && !data) || !st) return <Loading />;
  const ro = !pg.edit;
  const cols = Math.max(3, ...items.map((i) => i.offsets.length));
  const upd = (i: number, patch: Partial<Item>) => setItems((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const moveTo = (i: number, d: number) => setItems((l) => { const n = [...l]; const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const setOff = (i: number, k: number, v: string) => {
    const it = items[i];
    const offs = [...it.offsets];
    while (offs.length <= k) offs.push(offs[offs.length - 1] ?? 0);
    offs[k] = Number(v.replace("−", "-")) || 0;
    upd(i, { offsets: offs });
  };
  const add = () => setItems((l) => [...l, { id: 0, ord: l.length + 1, title: "", short: "", description: "", stage: l[l.length - 1]?.stage || 1, with_bloggers: false, sponsor: "", rival: 0, offsets: [-1, 0, 1].slice(0, cols).map(() => 0) }]);
  async function save() {
    setBusy(true);
    setErrs({});
    try {
      await api.put("/admin/media/template", { items, settings: st, apply });
      toast(tx("Shablon saqlandi"));
      reload();
    } catch (e: any) {
      setErrs(e?.fields || {});
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  // preview: which day each team is busy
  const preview = (() => {
    const all = items.flatMap((it) => it.offsets.slice(0, cols));
    const min = Math.min(-10, ...all), max = Math.max(0, ...all);
    return { days: Array.from({ length: max - min + 1 }, (_, i) => min + i) };
  })();
  const S = (k: keyof Settings, v: string | boolean) => setSt({ ...st, [k]: v });
  return (
    <>
      <PageHead title={tx("Media reja shabloni")} sub={tx("Har bir guruhga shu topshiriqlar qo‘llanadi. Kunlar final o‘yindan hisoblanadi: D — final kuni, D−10 — 10 kun oldin")}
        pre={<Link to="/media" className="muted">← {tx("Media reja")}</Link>}
        actions={!ro && <>
          <button className="btn" onClick={() => { if (data) { setItems(data.items); setSt(data.settings); } }}>{tx("Bekor qilish")}</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{tx("Saqlash")}</button>
        </>} />
      {errs.items && <div className="alert danger" style={{ marginBottom: 16 }}><I.alert size={16} /><div>{errs.items}</div></div>}
      <div className="card table-wrap">
        <table className="table mr-tpl">
          <thead><tr>
            <th /><th>#</th><th>{tx("Topshiriq")}</th><th>{tx("Bosqich")}</th><th>{tx("Kim bilan")}</th><th>{tx("Homiy")}</th><th>{tx("Javob")}</th>
            {Array.from({ length: cols }, (_, k) => <th key={k} className="center">{tx("{0}-jamoa", k + 1)}</th>)}
            <th />
          </tr></thead>
          <tbody>
            {items.map((it, i) => {
              const e = (f: string) => errs[`items.${i}.${f}`];
              return (
                <tr key={i}>
                  <td className="nowrap">
                    {!ro && <><button className="btn btn-ghost btn-icon btn-sm" onClick={() => moveTo(i, -1)} disabled={i === 0}><I.up size={14} /></button>
                      <button className="btn btn-ghost btn-icon btn-sm" onClick={() => moveTo(i, 1)} disabled={i === items.length - 1}><I.down size={14} /></button></>}
                  </td>
                  <td className="b sec">{i + 1}</td>
                  <td style={{ minWidth: 230 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <input className="input input-sm" value={it.title} disabled={ro} aria-invalid={!!e("title")} onChange={(ev) => upd(i, { title: ev.target.value })} placeholder={tx("Nomi")} />
                      <input className="input input-sm" style={{ width: 78 }} value={it.short} disabled={ro} onChange={(ev) => upd(i, { short: ev.target.value })} placeholder={tx("Qisqa")} title={tx("Jadval katagida ko‘rinadigan qisqa nom")} />
                    </div>
                    <textarea className="textarea mr-desc" rows={2} value={it.description} disabled={ro} onChange={(ev) => upd(i, { description: ev.target.value })} placeholder={tx("Botda menejerga ketadigan izoh (brief)")} />
                    {(e("title") || e("short") || e("description") || e("offsets")) && <span className="err small">{e("title") || e("short") || e("description") || e("offsets")}</span>}
                  </td>
                  <td><select className="select input-sm" value={it.stage} disabled={ro} onChange={(ev) => upd(i, { stage: Number(ev.target.value) })}>{[1, 2, 3, 4, 5].map((s) => <option key={s} value={s}>{tx("{0}-bosqich", s)}</option>)}</select></td>
                  <td><select className="select input-sm" value={it.with_bloggers ? "1" : ""} disabled={ro} onChange={(ev) => upd(i, { with_bloggers: !!ev.target.value })}><option value="1">{tx("Blogerlar")}</option><option value="">{tx("Jamoa o‘zi")}</option></select></td>
                  <td><input className="input input-sm" style={{ width: 66 }} value={it.sponsor} disabled={ro} onChange={(ev) => upd(i, { sponsor: ev.target.value.toUpperCase() })} placeholder="—" /></td>
                  <td><select className="select input-sm" value={it.rival} disabled={ro} onChange={(ev) => upd(i, { rival: Number(ev.target.value) })}><option value={0}>—</option><option value={1}>{tx("1-raqibga")}</option><option value={2}>{tx("2-raqibga")}</option><option value={3}>{tx("3-raqibga")}</option></select></td>
                  {Array.from({ length: cols }, (_, k) => {
                    const v = it.offsets[k] ?? it.offsets[it.offsets.length - 1] ?? 0;
                    return (
                      <td key={k} className="center">
                        <div className={`mr-off-in${v === 0 ? " final" : ""}`}>
                          <span>D</span>
                          <input className="input input-sm" type="number" min={-60} max={30} value={v} disabled={ro} onChange={(ev) => setOff(i, k, ev.target.value)} />
                        </div>
                      </td>
                    );
                  })}
                  <td>{!ro && <button className="btn btn-ghost btn-icon btn-sm" title={tx("O‘chirish")} onClick={() => setItems((l) => l.filter((_, j) => j !== i))}><I.trash size={15} /></button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!ro && <button className="btn btn-ghost mr-add" onClick={add}><I.plus size={16} /> {tx("Topshiriq qo‘shish")}</button>}
      </div>

      <div className="card card-pad" style={{ marginTop: 24 }}>
        <h3 className="mr-h3">{tx("Ko‘rinish: jamoalar qaysi kuni band")}</h3>
        <div className="mr-pv" style={{ gridTemplateColumns: `80px repeat(${preview.days.length}, minmax(40px, 1fr))` }}>
          <span />
          {preview.days.map((d) => <span key={d} className={`mr-pv-h${d === 0 ? " final" : ""}`}>{dLabel(d)}</span>)}
          {Array.from({ length: cols }, (_, k) => [
            <span key={`l${k}`} className="small sec b">{tx("{0}-jamoa", k + 1)}</span>,
            ...preview.days.map((d) => {
              const hit = items.filter((it) => (it.offsets[k] ?? it.offsets[it.offsets.length - 1]) === d);
              return <span key={`${k}${d}`} className={`mr-pv-c${hit.length ? (hit.some((h) => h.sponsor) ? " sp" : " on") : ""}`} title={hit.map((h) => h.title).join(", ")}>{hit.map((h) => (h.sponsor ? tx("Homiy") : h.short || h.title)).join(" + ")}</span>;
            }),
          ])}
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>{tx("2- va 3-jamoa jadvali 1 va 2 kunga suriladi — Google Sheets jadvalidagidek. Final kuni (D) uchala jamoa bir vaqtda TV-chaqiruv qiladi.")}</div>
      </div>

      <div className="grid g2" style={{ marginTop: 24, alignItems: "start" }}>
        <div className="card card-pad stack" style={{ gap: 14 }}>
          <h3 className="mr-h3">{tx("Eslatmalar va nazorat")}</h3>
          <SetRow on={st.evening_on} time={st.evening_time} ro={ro} title={tx("Kechki eslatma")} sub={tx("Topshiriqdan oldingi kun")} onOn={(v) => S("evening_on", v)} onTime={(v) => S("evening_time", v)} err={errs["settings.evening_time"]} />
          <SetRow on={st.morning_on} time={st.morning_time} ro={ro} title={tx("Ertalabki eslatma")} sub={tx("Topshiriq kuni")} onOn={(v) => S("morning_on", v)} onTime={(v) => S("morning_time", v)} err={errs["settings.morning_time"]} />
          <SetRow time={st.deadline_time} ro={ro} title={tx("Muddat")} sub={tx("Topshiriq kunining shu vaqtigacha")} onTime={(v) => S("deadline_time", v)} err={errs["settings.deadline_time"]} />
          <SetRow on={st.overdue_on} time={st.overdue_time} ro={ro} title={tx("Muddat o‘tsa — qayta eslatish")} sub={tx("Ertasi kuni menejerga")} onOn={(v) => S("overdue_on", v)} onTime={(v) => S("overdue_time", v)} err={errs["settings.overdue_time"]} />
          <SetRow time={st.escalate_time} ro={ro} title={tx("Moderatorlarga ro‘yxat")} sub={tx("Ertasi kuni hali bajarilmaganlar")} onTime={(v) => S("escalate_time", v)} err={errs["settings.escalate_time"]} />
          <SetRow on={st.report_on} time={st.report_time} ro={ro} title={tx("Kunlik hisobot")} sub={tx("Moderatorlarga, har kuni")} onOn={(v) => S("report_on", v)} onTime={(v) => S("report_time", v)} err={errs["settings.report_time"]} />
          <SetRow on={st.auto_check} ro={ro} title={tx("Havolani avtomatik tekshirish")} sub={tx("Instagram post/Reels va jamoa akkaunti")} onOn={(v) => S("auto_check", v)} />
          <SetRow on={st.require_review} ro={ro} title={tx("Moderator tasdig‘i")} sub={tx("O‘chirilsa, to‘g‘ri havola darhol «Bajarildi» bo‘ladi")} onOn={(v) => S("require_review", v)} />
        </div>
        {!ro && (
          <div className="card card-pad stack" style={{ gap: 14 }}>
            <h3 className="mr-h3">{tx("O‘zgarishlarni qayerga qo‘llash")}</h3>
            {([
              ["new", tx("Faqat yangi rejalar"), tx("Final o‘yini hali tanlanmagan guruhlar")],
              ["unstarted", tx("Boshlanmagan rejalar ham"), tx("Hali birorta topshiriq kuni kelmagan guruhlar — to‘liq qayta tuziladi")],
              ["running", tx("Davom etayotganlar ham"), tx("Faqat kelgusi topshiriqlar o‘zgaradi, bajarilganlar va o‘tganlar qoladi")],
            ] as const).map(([v, a, b]) => (
              <label key={v} className="mr-radio"><input type="radio" name="apply" checked={apply === v} onChange={() => setApply(v)} /><span><b>{a}</b><small>{b}</small></span></label>
            ))}
            <div className="mr-hint">{tx("Bitta jamoa topshirig‘ining sanasini guruh rejasida katakni bosib alohida o‘zgartirish mumkin.")}</div>
          </div>
        )}
      </div>
    </>
  );
}

function SetRow({ on, time, title, sub, ro, onOn, onTime, err }: { on?: boolean; time?: string; title: string; sub: string; ro: boolean; onOn?: (v: boolean) => void; onTime?: (v: string) => void; err?: string }) {
  return (
    <div className="mr-set">
      <div className="grow"><b>{title}</b><small>{sub}</small>{err && <span className="err small">{err}</span>}</div>
      {time !== undefined && onTime && <input type="time" className="input input-sm" style={{ width: 110 }} value={time} disabled={ro || on === false} onChange={(e) => onTime(e.target.value)} />}
      {on !== undefined && onOn && <label className="mr-switch"><input type="checkbox" checked={on} disabled={ro} onChange={(e) => onOn(e.target.checked)} /><span /></label>}
    </div>
  );
}

/* ---------- M6 · review queue ---------- */
function MediaReview() {
  const toast = useToast();
  const pg = usePage();
  const [status, setStatus] = useState<"review" | "returned" | "done">("review");
  const { data, error, loading, reload } = useLoad(() => api.get<{ items: MTask[]; teams: Record<string, MTeam>; counts: { review: number; returned: number; done: number } }>(`/admin/media/review?status=${status}`), [status]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [ret, setRet] = useState<MTask | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (status === "review" && data) setSel(new Set(data.items.filter((t) => t.checks.account !== "mismatch").map((t) => t.id)));
    else setSel(new Set());
  }, [data, status]);
  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      reload();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  const c = data?.counts;
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <>
      <PageHead title={tx("Tekshiruv navbati")} sub={tx("Menejerlar botga yuborgan Instagram havolalari")}
        pre={<Link to="/media" className="muted">← {tx("Media reja")}</Link>}
        actions={pg.edit && status === "review" && <button className="btn btn-primary" disabled={busy || !sel.size} onClick={() => run(() => api.post("/admin/media/review/approve", { ids: [...sel] }), tx("Tasdiqlandi"))}>{tx("Belgilanganlarni tasdiqlash · {0}", sel.size)}</button>} />
      <div className="tabs">
        {([["review", tx("Tekshiruvda")], ["returned", tx("Qaytarilgan")], ["done", tx("Tasdiqlangan")]] as const).map(([k, l]) => (
          <button key={k} aria-selected={status === k} onClick={() => setStatus(k)}>{l}{c ? ` · ${c[k]}` : ""}</button>
        ))}
      </div>
      {error ? <ErrorBox error={error} retry={reload} /> : loading && !data ? <Loading /> : !data?.items.length ? (
        <div className="card"><Empty title={status === "review" ? tx("Tekshiruvda havola yo‘q") : tx("Bo‘sh")} text={status === "review" ? tx("Menejer botga havola yuborsa, shu yerda paydo bo‘ladi.") : undefined} /></div>
      ) : (
        <div className="card">
          {data.items.map((t) => {
            const team = data.teams[String(t.team_id)];
            return (
              <div key={t.id} className={`mr-q${t.checks.account === "mismatch" ? " bad" : ""}`}>
                {status === "review" && pg.edit && <input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} />}
                <div className="mr-q-team">{team && <Crest team={team} size={32} />}<div><b>{t.team_name}</b><span className="muted small">{tx("Guruh {0}", t.group_code)}</span></div></div>
                <button className="mr-q-task" onClick={() => setOpen(t.id)}><b>{t.label}</b><span className="muted small">{short(t.due_date)} · {weekday(t.due_date)}</span></button>
                <div className="mr-q-link grow">
                  {t.link ? <a href={t.link} target="_blank" rel="noopener noreferrer" className="b row" style={{ gap: 6, minWidth: 0 }}><I.camera size={14} /><span className="ellipsis">{t.link.replace(/^https:\/\/www\./, "")}</span></a> : <span className="muted">{tx("Havolasiz")}</span>}
                  <span className="muted small">{t.submitted_at ? fmtDateTime(t.submitted_at) : ""}{t.submitted_by ? ` · ${t.submitted_by}` : ""}</span>
                  {status !== "review" && t.comment && <span className="small sec">«{t.comment}»</span>}
                </div>
                {t.link && <div className="mr-q-checks"><ChecksList c={t.checks} /></div>}
                {pg.edit && status !== "done" && (
                  <div className="row">
                    <button className="btn btn-sm" onClick={() => { setRet(t); setComment(""); }}>{tx("Qaytarish")}</button>
                    <button className={`btn btn-sm${t.checks.account === "mismatch" ? "" : " btn-primary"}`} disabled={busy} onClick={() => run(() => api.post(`/admin/media/tasks/${t.id}/approve`), tx("Tasdiqlandi"))}>{tx("Tasdiqlash")}</button>
                  </div>
                )}
                {status === "done" && <StatePill state="done" label={t.reviewed_by || tx("Bajarildi")} />}
              </div>
            );
          })}
        </div>
      )}
      <div className="mr-note"><I.telegram size={16} /><span>{tx("Moderatorlar xuddi shu navbatni Media botda ham oladi: har bir yangi havola — «Tasdiqlash / Qaytarish» tugmalari bilan. Huquq: «Media reja — tahrirlash», kartochkada telefon.")}</span></div>
      {ret && (
        <Modal title={tx("Qaytarish: {0} · {1}", ret.team_name, ret.label)} onClose={() => setRet(null)} footer={<>
          <button className="btn" onClick={() => setRet(null)}>{tx("Bekor qilish")}</button>
          <button className="btn btn-primary" disabled={busy || !comment.trim()} onClick={() => run(() => api.post(`/admin/media/tasks/${ret.id}/return`, { comment }), tx("Qaytarildi — menejerga yuborildi")).then(() => setRet(null))}>{tx("Qaytarish")}</button>
        </>}>
          <Field label={tx("Menejerga izoh")} hint={tx("Botda menejerga shu matn boradi")}>
            <textarea className="textarea" rows={4} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus placeholder={tx("Masalan: raqib jamoa akkaunti belgilanmagan")} />
          </Field>
        </Modal>
      )}
      {open && <TaskDrawer id={open} team={Object.values(data?.teams || {})} onClose={() => setOpen(null)} onChange={reload} />}
    </>
  );
}

