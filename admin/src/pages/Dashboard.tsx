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
import { SiteVisits } from "@/components/SiteVisits";

import { tx } from "@/lib/i18n";
type Dash = {
  kpi: { matches_total: number; matches_planned: number | null; results_entered: number; teams: number; news_published: number; news_drafts: number; requests_new: number; protocols_review: number };
  upcoming: Match[];
  recent_results: Match[];
  activity: { action: string; entity: string; entity_id: number | null; created_at: string; user_name: string | null }[];
};

const ACTION: Record<string, string> = { create: tx("yaratdi"), update: tx("tahrirladi"), delete: tx("o‘chirdi"), period: tx("davrni o‘zgartirdi"), event_add: tx("voqea qo‘shdi"), event_edit: tx("voqeani tahrirladi"), event_delete: tx("voqeani o‘chirdi"), lineups: tx("tarkibni saqladi"), upload: tx("fayl yukladi"), apply: tx("protokolni qo‘lladi"), reject: tx("protokolni rad etdi"), edit: tx("protokolni tahrirladi"), reorder: tx("tartibni o‘zgartirdi"), login: tx("tizimga kirdi") };
const ENTITY: Record<string, string> = { match: tx("match"), team: tx("jamoa"), player: tx("o‘yinchi"), news: tx("yangilik"), banner: tx("banner"), video: "video", product: tx("mahsulot"), protocol: tx("protokol"), user: tx("foydalanuvchi"), season: tx("mavsum"), stage: tx("bosqich"), contact_request: tx("murojaat"), image: "rasm", product_variant: tx("o‘lcham"), standing_adjustment: tx("jadval tuzatishi") };

export function DashboardPage() {
  const { user, can } = useAuth();
  const nav = useNavigate();
  const { data, error, loading, reload } = useLoad(() => api.get<Dash>("/admin/dashboard"), []);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  const k = data.kpi;
  return (
    <>
      <PageHead title={tx("Xush kelibsiz, {0}", user?.name || "")} sub={tx("United MFL boshqaruv paneli")}
        actions={<>
          {can("protocols") && <Link className="btn" to="/protocols"><I.doc size={16} />{" "}{tx("Natija kiritish")}</Link>}
          {can("matches:create") && <Link className="btn btn-primary" to="/matches/new"><I.plus size={16} />{" "}{tx("Yangi match")}</Link>}
        </>} />
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Kpi icon={<I.calendar />} label={tx("Matchlar")} value={k.matches_planned ?? k.matches_total} sub={tx("{0} ta natija kiritilgan", k.results_entered)} to="/matches" />
        <Kpi icon={<I.shirt />} label={tx("Jamoalar")} value={k.teams} to="/teams" />
        <Kpi icon={<I.news />} label={tx("Yangiliklar")} value={k.news_published} sub={k.news_drafts ? tx("{0} ta qoralama", k.news_drafts) : undefined} to="/news" />
        <Kpi icon={<I.inbox />} label={tx("Yangi murojaatlar")} value={k.requests_new} sub={k.protocols_review ? tx("{0} protokol tekshiruvda", k.protocols_review) : undefined} to={k.protocols_review ? "/protocols" : "/requests"} />
      </div>
      <SiteVisits />
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 320px", alignItems: "start" }} data-split>
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>{tx("Yaqin matchlar")}</h2><Link to="/matches" className="row small b" style={{ color: "var(--text-accent)" }}>{tx("Barchasi")}{" "}<I.arrow size={16} /></Link></div>
            {!data.upcoming.length ? <Empty title={tx("Rejalashtirilgan matchlar yo‘q")} /> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>{tx("Sana")}</th><th>{tx("Bosqich")}</th><th>{tx("Match")}</th><th>{tx("Holat")}</th><th /></tr></thead>
                <tbody>{data.upcoming.map((m) => (
                  <tr key={m.id} className="clickable" onClick={() => nav(`/matches/${m.id}`)}>
                    <td className="nowrap">{fmtShort(m.kickoff_at)}</td><td><StageTag m={m} /></td>
                    <td><span className="vs"><Crest team={m.home} size={20} /> {m.home?.name || tx("Aniqlanmagan")} — {m.away?.name || tx("Aniqlanmagan")} <Crest team={m.away} size={20} /></span></td>
                    <td><StatusBadge s={m.status} /></td>
                    <td className="actions" onClick={(e) => e.stopPropagation()}>{can("live") && m.home && m.away && <Link className="btn btn-sm" to={`/live/${m.id}`}>{tx("Live-pult")}{" "}<I.radio size={15} /></Link>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h2>{tx("So‘nggi natijalar")}</h2></div>
            {!data.recent_results.length ? <Empty title={tx("Natijalar yo‘q")} /> : (
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
            <h2 style={{ fontSize: 16 }}>{tx("Tezkor amallar")}</h2>
            {can("matches:create") && <Quick to="/matches/new" icon={<I.calendar size={16} />} label={tx("Match qo‘shish")} />}
            {can("news") && <Quick to="/news" icon={<I.news size={16} />} label={tx("Yangilik yozish")} />}
            {can("banners") && <Quick to="/banners" icon={<I.image size={16} />} label={tx("Hero-banner")} />}
            {can("videos") && <Quick to="/videos" icon={<I.play size={16} />} label={tx("Video qo‘shish")} />}
            {can("protocols") && <Quick to="/protocols" icon={<I.doc size={16} />} label={tx("Protokol yuklash")} />}
          </div>
          <div className="card">
            <div className="card-head"><h2>{tx("So‘nggi faoliyat")}</h2></div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              {!data.activity.length && <span className="muted">{tx("Hali faoliyat yo‘q")}</span>}
              {data.activity.map((a, i) => (
                <div key={i} className="row" style={{ alignItems: "flex-start" }}>
                  <span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{(a.user_name || "?").slice(0, 2).toUpperCase()}</span>
                  <div className="small"><b>{a.user_name || tx("Tizim")}</b> {ACTION[a.action] || a.action} {ENTITY[a.entity] || a.entity}{a.entity_id ? ` #${a.entity_id}` : ""}<div className="muted">{ago(a.created_at)}</div></div>
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
