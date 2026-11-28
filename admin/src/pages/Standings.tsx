import { api } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { useRefs, activeSeason } from "@/lib/refs";
import { Route, Routes } from "react-router";
import { CrudEditPage, CrudPage, type CrudProps, type Rec } from "@/components/Crud";
import { PageHead } from "@/components/Layout";
import { Badge, Crest, ErrorBox, Loading } from "@/components/ui";

import { tx } from "@/lib/i18n";
type Row = { position: number; team_id: number; team: string; played: number; won: number; drawn: number; lost: number; goals_for: number; goals_against: number; goal_diff: number; adjustment: number; points: number; form: string[] };
type GInfo = { name: string; ord: number; confirmed: boolean };
type St = { groups: Record<string, Row[]>; groups_provisional: boolean; group_info?: Record<string, GInfo>; rules: { win: number; draw: number; loss: number } };

export function StandingsPage() {
  return (
    <Routes>
      <Route index element={<StandingsOverview />} />
      <Route path="adjustments/new" element={<AdjustmentEdit />} />
      <Route path="adjustments/:id" element={<AdjustmentEdit />} />
    </Routes>
  );
}

function useAdjustmentProps(onChanged?: () => void): CrudProps<Rec> & { base: string } {
  const { teams, seasons } = useRefs();
  const byId = new Map(teams.map((t) => [t.id, t]));
  const season = activeSeason(seasons);
  return {
    title: tx("Ochko tuzatishlari"), sub: tx("Texnik mag‘lubiyat, jarima va boshqa qarorlar"), resource: "/admin/standing-adjustments", singular: tx("Tuzatish"),
    base: "/standings/adjustments", listPath: "/standings", titleField: "reason", reloadKey: teams.length,
    defaults: { season_id: String(season?.id || "") },
    onChanged,
    fields: [
      { name: "season_id", label: tx("Mavsum"), type: "select", numeric: true, required: true, options: seasons.map((s) => ({ value: String(s.id), label: s.name })) },
      { name: "team_id", label: tx("Jamoa"), type: "select", numeric: true, required: true, options: teams.map((t) => ({ value: String(t.id), label: t.name })) },
      { name: "points", label: tx("Ochko (+/−)"), type: "number", required: true, hint: tx("Manfiy — jarima, musbat — qaytarish") },
      { name: "reason", label: tx("Sabab (saytdagi izohda ko‘rinadi)"), type: "textarea", required: true },
    ],
    columns: [
      { label: tx("Jamoa"), render: (a) => byId.get(a.team_id)?.name || a.team_id },
      { label: tx("Ochko"), render: (a) => <b>{a.points > 0 ? `+${a.points}` : a.points}</b> },
      { label: tx("Sabab"), render: (a) => a.reason },
    ],
  };
}

function AdjustmentEdit() {
  const p = useAdjustmentProps();
  return <CrudEditPage {...p} />;
}

function StandingsOverview() {
  const { data, error, loading, reload } = useLoad(() => api.get<St>("/admin/standings"), []);
  const { teams } = useRefs();
  const byId = new Map(teams.map((t) => [t.id, t]));
  const adj = useAdjustmentProps(reload);
  return (
    <div className="stack" style={{ gap: 32 }}>
      <div>
        <PageHead title={tx("Turnir jadvali")} sub={data ? tx("Avtomatik hisoblanadi: g‘alaba {0}, durang {1}, mag‘lubiyat {2}. Faqat e’lon qilingan, yakunlangan guruh matchlari.", data.rules.win, data.rules.draw, data.rules.loss) : undefined} />
        {data?.groups_provisional && <div className="alert warn" style={{ marginBottom: 16 }}>{tx("Guruhlar tarkibi taxminiy deb belgilangan. «Guruhlar» bo‘limida tarkibni tasdiqlang.")}</div>}
        {error ? <ErrorBox error={error} retry={reload} /> : loading || !data ? <Loading /> : (
          <div className="grid g2" data-split>
            {Object.keys(data.groups).sort((a, b) => (data.group_info?.[a]?.ord ?? 99) - (data.group_info?.[b]?.ord ?? 99) || a.localeCompare(b)).map((g) => (
              <div key={g} className="card">
                <div className="card-head"><h3>{g ? data.group_info?.[g]?.name || `Guruh ${g}` : tx("Guruhsiz")}</h3>{g && data.group_info?.[g] && !data.group_info[g].confirmed && <Badge tone="warn">{tx("Taxminiy")}</Badge>}</div>
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>#</th><th>{tx("Jamoa")}</th><th>O</th><th>G</th><th>D</th><th>M</th><th>{tx("Gollar")}</th><th>±</th><th>{tx("Ochko")}</th></tr></thead>
                  <tbody>{data.groups[g].map((r) => (
                    <tr key={r.team_id}>
                      <td>{r.position}</td>
                      <td><span className="row"><Crest team={byId.get(r.team_id) || { id: r.team_id, name: r.team }} size={22} /> <b>{r.team}</b></span></td>
                      <td>{r.played}</td><td>{r.won}</td><td>{r.drawn}</td><td>{r.lost}</td><td>{r.goals_for}:{r.goals_against}</td><td>{r.goal_diff}</td>
                      <td><b>{r.points}</b>{r.adjustment !== 0 && <Badge tone="warn" plain>{r.adjustment > 0 ? "+" : ""}{r.adjustment}</Badge>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </div>
            ))}
          </div>
        )}
      </div>
      <CrudPage {...adj} />
    </div>
  );
}
