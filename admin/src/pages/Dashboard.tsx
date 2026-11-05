import { Link, useNavigate } from "react-router";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { ago, fmtShort } from "@/lib/format";
import type { Match } from "@/lib/types";
import { PageHead } from "@/components/Layout";
import { Empty, ErrorBox, Loading, Crest } from "@/components/ui";
import { I } from "@/components/Icons";
import { StageTag, StatusBadge } from "./Matches";

type Dash = {
  kpi: { matches_total: number; matches_planned: number | null; results_entered: number; teams: number; news_published: number; news_drafts: number; requests_new: number; protocols_review: number };
  upcoming: Match[];
  recent_results: Match[];
  activity: { action: string; entity: string; entity_id: number | null; created_at: string; user_name: string | null }[];
};

const ACTION: Record<string, string> = { create: "yaratdi", update: "tahrirladi", delete: "o‘chirdi", period: "davrni o‘zgartirdi", event_add: "voqea qo‘shdi", event_edit: "voqeani tahrirladi", event_delete: "voqeani o‘chirdi", lineups: "tarkibni saqladi", upload: "fayl yukladi", apply: "protokolni qo‘lladi", reject: "protokolni rad etdi", edit: "protokolni tahrirladi", reorder: "tartibni o‘zgartirdi", login: "tizimga kirdi" };
const ENTITY: Record<string, string> = { match: "match", team: "jamoa", player: "o‘yinchi", news: "yangilik", banner: "banner", video: "video", product: "mahsulot", protocol: "protokol", user: "foydalanuvchi", season: "mavsum", stage: "bosqich", contact_request: "murojaat", image: "rasm", product_variant: "o‘lcham", standing_adjustment: "jadval tuzatishi" };

export function DashboardPage() {
  const { user, can } = useAuth();
  const nav = useNavigate();
  const { data, error, loading, reload } = useLoad(() => api.get<Dash>("/admin/dashboard"), []);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  const k = data.kpi;
  return (
    <>
      <PageHead title={`Xush kelibsiz, ${user?.name || ""}`} sub="United MFL boshqaruv paneli"
        actions={<>
          {can("protocols") && <Link className="btn" to="/protocols"><I.doc size={16} /> Natija kiritish</Link>}
          {can("matches:edit") && <Link className="btn btn-primary" to="/matches/new"><I.plus size={16} /> Yangi match</Link>}
        </>} />
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Kpi icon={<I.calendar />} label="Matchlar" value={k.matches_planned ?? k.matches_total} sub={`${k.results_entered} ta natija kiritilgan`} to="/matches" />
        <Kpi icon={<I.shirt />} label="Jamoalar" value={k.teams} to="/teams" />
        <Kpi icon={<I.news />} label="Yangiliklar" value={k.news_published} sub={k.news_drafts ? `${k.news_drafts} ta qoralama` : undefined} to="/news" />
        <Kpi icon={<I.inbox />} label="Yangi murojaatlar" value={k.requests_new} sub={k.protocols_review ? `${k.protocols_review} protokol tekshiruvda` : undefined} to={k.protocols_review ? "/protocols" : "/requests"} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 320px", alignItems: "start" }} data-split>
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Yaqin matchlar</h2><Link to="/matches" className="row small b" style={{ color: "var(--text-accent)" }}>Barchasi <I.arrow size={16} /></Link></div>
            {!data.upcoming.length ? <Empty title="Rejalashtirilgan matchlar yo‘q" /> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Sana</th><th>Bosqich</th><th>Match</th><th>Holat</th><th /></tr></thead>
                <tbody>{data.upcoming.map((m) => (
                  <tr key={m.id} className="clickable" onClick={() => nav(`/matches/${m.id}`)}>
                    <td className="nowrap">{fmtShort(m.kickoff_at)}</td><td><StageTag m={m} /></td>
                    <td><span className="vs"><Crest team={m.home} size={20} /> {m.home?.name || "Aniqlanmagan"} — {m.away?.name || "Aniqlanmagan"} <Crest team={m.away} size={20} /></span></td>
                    <td><StatusBadge s={m.status} /></td>
                    <td className="actions" onClick={(e) => e.stopPropagation()}>{can("live") && m.home && m.away && <Link className="btn btn-sm" to={`/live/${m.id}`}>Live-pult <I.radio size={15} /></Link>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h2>So‘nggi natijalar</h2></div>
            {!data.recent_results.length ? <Empty title="Natijalar yo‘q" /> : (
              <div className="table-wrap"><table className="table">
                <tbody>{data.recent_results.map((m) => (
                  <tr key={m.id} className="clickable" onClick={() => nav(`/matches/${m.id}`)}>
                    <td className="nowrap muted">{fmtShort(m.kickoff_at)}</td>
                    <td className="right"><span className="row" style={{ justifyContent: "flex-end" }}><b>{m.home?.name}</b><Crest team={m.home} size={22} /></span></td>
                    <td className="center tnum nowrap" style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16 }}>{m.home_score} : {m.away_score}</td>
                    <td><span className="row"><Crest team={m.away} size={22} /><b>{m.away?.name}</b></span></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        </div>
        <div className="stack">
          <div className="card card-pad stack" style={{ gap: 10 }}>
            <h2 style={{ fontSize: 16 }}>Tezkor amallar</h2>
            {can("matches:edit") && <Quick to="/matches/new" icon={<I.calendar size={16} />} label="Match qo‘shish" />}
            {can("news") && <Quick to="/news" icon={<I.news size={16} />} label="Yangilik yozish" />}
            {can("banners") && <Quick to="/banners" icon={<I.image size={16} />} label="Hero-banner" />}
            {can("videos") && <Quick to="/videos" icon={<I.play size={16} />} label="Video qo‘shish" />}
            {can("protocols") && <Quick to="/protocols" icon={<I.doc size={16} />} label="Protokol yuklash" />}
          </div>
          <div className="card">
            <div className="card-head"><h2>So‘nggi faoliyat</h2></div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              {!data.activity.length && <span className="muted">Hali faoliyat yo‘q</span>}
              {data.activity.map((a, i) => (
                <div key={i} className="row" style={{ alignItems: "flex-start" }}>
                  <span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{(a.user_name || "?").slice(0, 2).toUpperCase()}</span>
                  <div className="small"><b>{a.user_name || "Tizim"}</b> {ACTION[a.action] || a.action} {ENTITY[a.entity] || a.entity}{a.entity_id ? ` #${a.entity_id}` : ""}<div className="muted">{ago(a.created_at)}</div></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Kpi({ icon, label, value, sub, to }: { icon: React.ReactNode; label: string; value: number; sub?: string; to: string }) {
  return (
    <Link to={to} className="card kpi">
      <div className="row"><span className="icon">{icon}</span><span className="sec b">{label}</span></div>
      <div className="val tnum">{value}</div>
      {sub && <small>{sub}</small>}
    </Link>
  );
}
function Quick({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return <Link to={to} className="row" style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10 }}><span className="kpi" style={{ padding: 0 }}><span className="icon" style={{ width: 28, height: 28 }}>{icon}</span></span><span className="grow b">{label}</span><I.plus size={16} /></Link>;
}
