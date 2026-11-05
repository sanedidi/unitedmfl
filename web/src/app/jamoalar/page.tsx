import type { Metadata } from "next";
import Link from "next/link";
import { api, safe } from "@/lib/api";
import type { Team } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { Crest } from "@/components/Crest";

export const metadata: Metadata = { title: "Jamoalar", description: "United MFL ishtirokchi jamoalari." };

export default async function TeamsPage() {
  const teams = await safe(api<Team[]>("/teams"), []);
  const league = teams.filter((t) => t.group_label);
  const groups = [...new Set(league.map((t) => t.group_label))].sort();
  const others = teams.filter((t) => !t.group_label);
  const provisional = league.some((t) => t.group_is_provisional);
  return (
    <>
      <PageTitle overline="United MFL 2026" title="Jamoalar" lead={`${league.length} jamoa ${groups.length} guruhda.`}>
        {provisional && <div className="note" style={{ marginTop: 16 }}><span className="badge badge-outline">Taxminiy</span> Guruhlarga bo‘linish rasman e’lon qilinmagan.</div>}
      </PageTitle>
      <div className="container">
        {groups.map((g) => (
          <section key={g} style={{ marginTop: 40 }}>
            <h2 className="h3" style={{ marginBottom: 16 }}>Guruh {g}</h2>
            <div className="grid grid-4">
              {league.filter((t) => t.group_label === g).map((t) => (
                <Link key={t.id} href={`/jamoalar/${t.slug}`} className="card card-hover team-tile">
                  <Crest team={t} size={84} />
                  <b>{t.name}</b>
                  {t.leader && <span className="muted" style={{ fontSize: 13 }}>{t.leader}</span>}
                </Link>
              ))}
            </div>
          </section>
        ))}
        {others.length > 0 && (
          <section style={{ marginTop: 40 }}>
            <h2 className="h3" style={{ marginBottom: 16 }}>Boshqa jamoalar</h2>
            <div className="grid grid-4">
              {others.map((t) => (
                <Link key={t.id} href={`/jamoalar/${t.slug}`} className="card card-hover team-tile"><Crest team={t} size={64} /><b>{t.name}</b></Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
