import type { Metadata } from "next";
import { pageMeta } from "@/lib/seo";
import { api, safe } from "@/lib/api";
import type { Season } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { ContactForm } from "@/components/ContactForm";

export const metadata: Metadata = pageMeta({ title: "Liga haqida — format, hamkorlik va aloqa", description: "United MFL media futbol ligasi haqida: mavsum formati, bosqichlar, hamkorlik, homiylik va jamoa ro‘yxatdan o‘tishi bo‘yicha aloqa.", path: "/biz-haqimizda" });

const STATUS: Record<string, string> = { finished: "Yakunlangan", live: "Davom etmoqda", scheduled: "Rejalashtirilgan" };

export default async function AboutPage() {
  const seasons = await safe(api<Season[]>("/seasons"), []);
  const s = seasons.find((x) => x.is_active) || seasons[0];
  return (
    <>
      <PageTitle overline="United MFL" title="Liga haqida" lead="United MFL — blogerlar, sportchilar va san’at yulduzlari jamoalari ishtirok etadigan media futbol ligasi." />
      <div className="container">
        {s && (
          <section className="section" style={{ paddingBottom: 0 }}>
            <div className="overline">Mavsum formati</div>
            <h2 className="h2" style={{ marginBottom: 24 }}>{s.name}</h2>
            <div className="grid grid-4">
              {s.stages.sort((a, b) => a.ord - b.ord).map((st, i) => (
                <div key={st.id} className="card card-pad stack" style={{ gap: 8 }}>
                  <span className="muted" style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 28 }}>0{i + 1}</span>
                  <b style={{ fontSize: 18 }}>{st.name}</b>
                  <span className={`badge ${st.status === "finished" ? "badge-muted" : st.status === "live" ? "badge-live" : "badge-stage"}`} style={{ alignSelf: "flex-start" }}>{STATUS[st.status] || st.status}</span>
                </div>
              ))}
            </div>
            <p className="muted" style={{ marginTop: 16, fontSize: 14 }}>{s.teams_planned} jamoa · {s.matches_planned} match</p>
          </section>
        )}
        <section className="section" id="aloqa">
          <div className="grid grid-2" style={{ gap: 48, alignItems: "start" }}>
            <div>
              <div className="overline">Aloqa</div>
              <h2 className="h2">Hamkorlik va savollar</h2>
              <p className="lead" style={{ marginTop: 16 }}>Homiylik, jamoa ro‘yxatdan o‘tishi, chiptalar yoki media bo‘yicha so‘rov qoldiring — menejer siz bilan bog‘lanadi.</p>
            </div>
            <div className="card card-pad"><ContactForm /></div>
          </div>
        </section>
      </div>
    </>
  );
}
