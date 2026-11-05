import Link from "next/link";
import { Crest } from "./Crest";
import type { StandingRow, TeamRef } from "@/lib/types";

const FORM_LABEL: Record<string, string> = { W: "G", D: "D", L: "M" };

export function StandingsTable({ group, rows, provisional, qualify = 2, teams, compact = false }: { group: string; rows: StandingRow[]; provisional: boolean; qualify?: number; teams?: Map<number, TeamRef>; compact?: boolean }) {
  return (
    <section className="card" aria-label={`Guruh ${group}`}>
      <div className="card-head">
        <h3 className="h4">Guruh {group}</h3>
        {provisional && <span className="badge badge-upcoming" title="Guruhlar tarkibi liga tomonidan rasman e’lon qilinmagan">dastlabki</span>}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th className="l">Jamoa</th>
              <th title="O‘yinlar">O</th>
              <th className="hm" title="G‘alaba">G</th>
              <th className="hm" title="Durang">D</th>
              <th className="hm" title="Mag‘lubiyat">M</th>
              {!compact && <th className="hm">Gollar</th>}
              <th title="Gollar farqi">±</th>
              <th title="Ochko">Och</th>
              {!compact && <th className="hm">Forma</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.team_id}>
                <td className={`pos${r.position <= qualify ? " q" : ""}`}>{r.position}</td>
                <td className="l">
                  <Link href={`/jamoalar/${r.slug}`} className="team-cell">
                    <Crest team={teams?.get(r.team_id) || { id: r.team_id, name: r.team }} size={24} />
                    {r.team}
                  </Link>
                </td>
                <td>{r.played}</td>
                <td className="hm">{r.won}</td>
                <td className="hm">{r.drawn}</td>
                <td className="hm">{r.lost}</td>
                {!compact && <td className="hm">{r.goals_for}:{r.goals_against}</td>}
                <td className={r.goal_diff > 0 ? "gd-pos" : "gd-neg"}>{r.goal_diff > 0 ? `+${r.goal_diff}` : r.goal_diff < 0 ? `−${-r.goal_diff}` : 0}</td>
                <td className="strong">
                  {r.points}
                  {r.adjustment !== 0 && <sup className="muted" title="Tuzatish"> {r.adjustment > 0 ? `+${r.adjustment}` : r.adjustment}</sup>}
                </td>
                {!compact && (
                  <td className="hm">
                    <span className="form" aria-label={`Forma: ${r.form.join(", ")}`}>
                      {Array.from({ length: 5 }).map((_, i) => {
                        const f = r.form[i];
                        return <i key={i} className={f || ""}>{f ? FORM_LABEL[f] : "–"}</i>;
                      })}
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-note">
        <i aria-hidden /> Pley-off zonasi: har guruhdan {qualify} jamoa (taxmin)
      </div>
    </section>
  );
}
