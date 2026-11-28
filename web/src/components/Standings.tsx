import Link from "next/link";
import { Crest } from "./Crest";
import { groupName, type StandingRow, type TeamRef } from "@/lib/types";

import { useT } from "@/lib/i18n";
const FORM_LABEL: Record<string, string> = { W: "G", D: "D", L: "M" };

export function StandingsTable({ group, title, rows, provisional, qualify = 2, teams, compact = false }: { group: string; title?: string; rows: StandingRow[]; provisional: boolean; qualify?: number; teams?: Map<number, TeamRef>; compact?: boolean }) {
  const tx = useT();
  return (
    <section className="card" aria-label={title || groupName(group)}>
      <div className="card-head">
        <h3 className="h4">{title || groupName(group)}</h3>
        {provisional && <span className="badge badge-upcoming" title={tx("Guruhlar tarkibi liga tomonidan rasman e’lon qilinmagan")}>{tx("dastlabki")}</span>}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th className="l">{tx("Jamoa")}</th>
              <th title={tx("O‘yinlar")}>O</th>
              <th className="hm" title={tx("G‘alaba")}>G</th>
              <th className="hm" title={tx("Durang")}>D</th>
              <th className="hm" title={tx("Mag‘lubiyat")}>M</th>
              {!compact && <th className="hm">{tx("Gollar")}</th>}
              <th title={tx("Gollar farqi")}>±</th>
              <th title={tx("Ochko")}>{tx("Och")}</th>
              {!compact && <th className="hm">{tx("Forma")}</th>}
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
                  {r.adjustment !== 0 && <sup className="muted" title={tx("Tuzatish")}> {r.adjustment > 0 ? `+${r.adjustment}` : r.adjustment}</sup>}
                </td>
                {!compact && (
                  <td className="hm">
                    <span className="form" aria-label={tx("Forma: {0}", r.form.join(", "))}>
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
        <i aria-hidden />{" "}{tx("Pley-off zonasi: har guruhdan {0} jamoa (taxmin)", qualify)}</div>
    </section>
  );
}
