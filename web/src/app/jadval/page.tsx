import type { Metadata } from "next";
import Link from "next/link";
import { api, safe } from "@/lib/api";
import { fmtDate, fmtTime } from "@/lib/format";
import type { Match, Standings, Team } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { StandingsTable } from "@/components/Standings";
import { Crest } from "@/components/Crest";

export const metadata: Metadata = { title: "Turnir jadvali", description: "United MFL guruhlar jadvali va pley-off setkasi." };

function BracketMatch({ m }: { m: Match }) {
  const played = m.home_score != null && m.away_score != null && m.status === "finished";
  const hs = m.home_score ?? 0, as = m.away_score ?? 0, hp = m.home_pen ?? 0, ap = m.away_pen ?? 0;
  const homeWin = played && (hs > as || (hs === as && hp > ap));
  const awayWin = played && (as > hs || (hs === as && ap > hp));
  return (
    <Link href={`/matchlar/${m.id}`} className="card card-hover bracket-match">
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>{fmtDate(m.kickoff_at)} · {fmtTime(m.kickoff_at)}</div>
      <div className={`bracket-team${homeWin ? " win" : ""}`}><Crest team={m.home} size={24} /> {m.home?.name || "Aniqlanmagan"}<span className="s">{played ? m.home_score : ""}</span></div>
      <div className={`bracket-team${awayWin ? " win" : ""}`}><Crest team={m.away} size={24} /> {m.away?.name || "Aniqlanmagan"}<span className="s">{played ? m.away_score : ""}</span></div>
      {m.home_pen != null && <div className="muted" style={{ fontSize: 11 }}>Penaltilar {m.home_pen}:{m.away_pen}</div>}
    </Link>
  );
}

export default async function StandingsPage() {
  const [st, teams] = await Promise.all([safe(api<Standings | null>("/standings"), null), safe(api<Team[]>("/teams"), [])]);
  const teamMap = new Map(teams.map((t) => [t.id, t]));
  const groups = st ? Object.keys(st.groups).sort() : [];
  const order = ["round_of_16", "quarter", "semi", "final", "other"];
  const label: Record<string, string> = { round_of_16: "1/8 final", quarter: "Chorak final", semi: "Yarim final", final: "Final", other: "Boshqa" };
  const rounds = order.map((k) => ({ k, items: (st?.playoff || []).filter((m) => m.stage?.kind === k) })).filter((r) => r.items.length);

  return (
    <>
      <PageTitle overline="United MFL 2026" title="Turnir jadvali" lead={st ? `Ochkolar: g‘alaba — ${st.rules.win}, durang — ${st.rules.draw}, mag‘lubiyat — ${st.rules.loss}. Teng ochkoda: gollar farqi, urilgan gollar.` : undefined}>
        {st?.groups_provisional && <div className="note" style={{ marginTop: 16 }}><span className="badge badge-outline">Taxminiy</span> Guruhlar tarkibi rasman e’lon qilinmagan — natijalar asosida taxminiy.</div>}
      </PageTitle>
      <div className="container">
        {!st || groups.length === 0 ? (
          <div className="empty" style={{ marginTop: 32 }}>Jadval hali shakllanmagan.</div>
        ) : (
          <div className="grid grid-2" style={{ marginTop: 32 }}>
            {groups.map((g) => <StandingsTable key={g} group={g} rows={st.groups[g]} provisional={st.groups_provisional} teams={teamMap} compact />)}
          </div>
        )}

        {rounds.length > 0 && (
          <section className="section" style={{ paddingBottom: 0 }}>
            <div className="overline">Pley-off</div>
            <h2 className="h2" style={{ marginBottom: 28 }}>Pley-off setkasi</h2>
            <div className="bracket" style={{ gridTemplateColumns: `repeat(${rounds.length}, minmax(0, 1fr))` }}>
              {rounds.map((r) => (
                <div key={r.k} className="bracket-col">
                  <h4>{label[r.k]}</h4>
                  {r.items.map((m) => <BracketMatch key={m.id} m={m} />)}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
