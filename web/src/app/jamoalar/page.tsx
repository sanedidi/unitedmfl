import type { Metadata } from "next";
import { pageMeta } from "@/lib/seo";
import Link from "next/link";
import { api, safe } from "@/lib/api";
import { groupName, type Team } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { Crest } from "@/components/Crest";

import { getT } from "@/lib/i18n/server";
export async function generateMetadata(): Promise<Metadata> {
  const tx = await getT();
  return pageMeta({ title: tx("Jamoalar — United MFL ishtirokchilari"), description: tx("United MFL 2026 ishtirokchi jamoalari guruhlar bo‘yicha: tarkiblar, matchlar va natijalar."), path: "/jamoalar" });
}

export default async function TeamsPage() {
  const tx = await getT();
  const teams = await safe(api<Team[]>("/teams"), []);
  const league = teams.filter((t) => t.group_label);
  // API order = the admin's group order, then position inside the group
  const groups = [...new Set(league.map((t) => t.group_label))];
  const title = (g: string) => groupName(g, league.find((t) => t.group_label === g)?.group_name);
  const others = teams.filter((t) => !t.group_label);
  const provisional = league.some((t) => t.group_is_provisional);
  return (
    <>
      <PageTitle overline={tx("United MFL 2026")} title={tx("Jamoalar")} lead={tx("{0} jamoa {1} guruhda.", league.length, groups.length)}>
        {provisional && <div className="note" style={{ marginTop: 16 }}><span className="badge badge-outline">{tx("Taxminiy")}</span>{" "}{tx("Guruhlarga bo‘linish rasman e’lon qilinmagan.")}</div>}
      </PageTitle>
      <div className="container">
        {groups.map((g) => (
          <section key={g} style={{ marginTop: 40 }}>
            <h2 className="h3" style={{ marginBottom: 16 }}>{title(g)}</h2>
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
            <h2 className="h3" style={{ marginBottom: 16 }}>{tx("Boshqa jamoalar")}</h2>
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
