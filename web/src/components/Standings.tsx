import Link from "next/link";
import { Crest } from "./Crest";
import type { StandingRow, TeamRef } from "@/lib/types";

const FORM_LABEL: Record<string, string> = { W: "G", D: "D", L: "M" };

export function StandingsTable({ group, rows, provisional, qualify = 2, teams, compact = false }: { group: string; rows: StandingRow[]; provisional: boolean; qualify?: number; teams?: Map<number, TeamRef>; compact?: boolean }) {
  return (
    <section className="card" aria-label={`Guruh ${group}`}>
      <div className="row" style={{ padding: "18px 20px 6px", flexWrap: "wrap" }}>
        <h3 className="h4">Guruh {group}</h3>
        {provisional && <span className="badge badge-outline">Guruh tarkibi taxminiy</span>}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th className="l">Jamoa</th>
              <th title="O‘yinlar">O</th>
              <th title="G‘alaba">G</th>
              <th title="Durang">D</th>
              <th title="Mag‘lubiyat">M</th>
              {!compact && <th>Gollar</th>}
              <th title="Gollar farqi">±</th>
              <th>Ochko</th>
              {!compact && <th>Forma</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.team_id}>
                <td className={`pos${r.position <= qualify ? " q" : ""}`}>{r.position}</td>
                <td className="l">
                  <Link href={`/jamoalar/${r.slug}`} className="team-cell">
                    <Crest team={teams?.get(r.team_id) || { id: r.team_id, name: r.team }} size={28} />
                    {r.team}
                  </Link>
                </td>
                <td>{r.played}</td>
                <td>{r.won}</td>
                <td>{r.drawn}</td>
                <td>{r.lost}</td>
                {!compact && <td>{r.goals_for}:{r.goals_against}</td>}
                <td className="gd-pos">{r.goal_diff > 0 ? `+${r.goal_diff}` : r.goal_diff}</td>
                <td className="strong">
                  {r.points}
                  {r.adjustment !== 0 && <sup className="muted" title="Tuzatish"> {r.adjustment > 0 ? `+${r.adjustment}` : r.adjustment}</sup>}
                </td>
                {!compact && (
                  <td>
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
      <div className="row muted" style={{ padding: "12px 20px 16px", fontSize: 12, borderTop: "1px solid var(--ink-800)", gap: 8 }}>
        <span style={{ width: 3, height: 14, background: "var(--accent)", borderRadius: 2 }} /> Pley-off zonasi (har guruhdan {qualify} jamoa — taxmin)
      </div>
    </section>
  );
}
