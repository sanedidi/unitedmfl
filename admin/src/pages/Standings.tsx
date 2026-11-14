import { api } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { useRefs, activeSeason } from "@/lib/refs";
import { Route, Routes } from "react-router";
import { CrudEditPage, CrudPage, type CrudProps, type Rec } from "@/components/Crud";
import { PageHead } from "@/components/Layout";
import { Badge, Crest, ErrorBox, Loading } from "@/components/ui";

type Row = { position: number; team_id: number; team: string; played: number; won: number; drawn: number; lost: number; goals_for: number; goals_against: number; goal_diff: number; adjustment: number; points: number; form: string[] };
type St = { groups: Record<string, Row[]>; groups_provisional: boolean; rules: { win: number; draw: number; loss: number } };

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
    title: "Ochko tuzatishlari", sub: "Texnik mag‘lubiyat, jarima va boshqa qarorlar", resource: "/admin/standing-adjustments", singular: "Tuzatish",
    base: "/standings/adjustments", listPath: "/standings", titleField: "reason", reloadKey: teams.length,
    defaults: { season_id: String(season?.id || "") },
    onChanged,
    fields: [
      { name: "season_id", label: "Mavsum", type: "select", numeric: true, required: true, options: seasons.map((s) => ({ value: String(s.id), label: s.name })) },
      { name: "team_id", label: "Jamoa", type: "select", numeric: true, required: true, options: teams.map((t) => ({ value: String(t.id), label: t.name })) },
      { name: "points", label: "Ochko (+/−)", type: "number", required: true, hint: "Manfiy — jarima, musbat — qaytarish" },
      { name: "reason", label: "Sabab (saytdagi izohda ko‘rinadi)", type: "textarea", required: true },
    ],
    columns: [
      { label: "Jamoa", render: (a) => byId.get(a.team_id)?.name || a.team_id },
      { label: "Ochko", render: (a) => <b>{a.points > 0 ? `+${a.points}` : a.points}</b> },
      { label: "Sabab", render: (a) => a.reason },
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
        <PageHead title="Turnir jadvali" sub={data ? `Avtomatik hisoblanadi: g‘alaba ${data.rules.win}, durang ${data.rules.draw}, mag‘lubiyat ${data.rules.loss}. Faqat e’lon qilingan, yakunlangan guruh matchlari.` : undefined} />
        {data?.groups_provisional && <div className="alert warn" style={{ marginBottom: 16 }}>Guruhlar tarkibi taxminiy deb belgilangan. «Jamoalar» bo‘limida guruhni tasdiqlang.</div>}
        {error ? <ErrorBox error={error} retry={reload} /> : loading || !data ? <Loading /> : (
          <div className="grid g2" data-split>
            {Object.keys(data.groups).sort().map((g) => (
              <div key={g} className="card">
                <div className="card-head"><h3>Guruh {g}</h3></div>
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>#</th><th>Jamoa</th><th>O</th><th>G</th><th>D</th><th>M</th><th>Gollar</th><th>±</th><th>Ochko</th></tr></thead>
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
