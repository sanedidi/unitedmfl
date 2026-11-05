import type { Metadata } from "next";
import Link from "next/link";
import { api, safe } from "@/lib/api";
import { dayKey, fmtDate, fmtWeekday, isLive } from "@/lib/format";
import type { Match, Season } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { ResultRow } from "@/components/Match";

export const metadata: Metadata = { title: "Matchlar", description: "United MFL matchlari: taqvim, natijalar va jonli o‘yinlar." };

type SP = Promise<{ bosqich?: string; holat?: string }>;

export default async function MatchesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const status = sp.holat === "yakunlangan" ? "finished" : sp.holat === "kelgusi" ? "scheduled" : "";
  const qs = new URLSearchParams({ limit: "200" });
  if (status) qs.set("status", status);
  if (sp.bosqich) qs.set("stage", sp.bosqich);
  const [matches, seasons] = await Promise.all([safe(api<Match[]>(`/matches?${qs}`), []), safe(api<Season[]>("/seasons"), [])]);
  const stages = (seasons.find((s) => s.is_active) || seasons[0])?.stages || [];

  const sorted = [...matches].sort((a, b) => (status === "finished" ? +new Date(b.kickoff_at) - +new Date(a.kickoff_at) : +new Date(a.kickoff_at) - +new Date(b.kickoff_at)));
  const live = sorted.filter(isLive);
  const rest = sorted.filter((m) => !isLive(m));
  const days: { key: string; items: Match[] }[] = [];
  for (const m of rest) {
    const k = dayKey(m.kickoff_at);
    if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, items: [] });
    days[days.length - 1].items.push(m);
  }

  const href = (p: { bosqich?: string; holat?: string }) => {
    const q = new URLSearchParams();
    const b = "bosqich" in p ? p.bosqich : sp.bosqich;
    const h = "holat" in p ? p.holat : sp.holat;
    if (b) q.set("bosqich", b);
    if (h) q.set("holat", h);
    const s = q.toString();
    return s ? `/matchlar?${s}` : "/matchlar";
  };

  return (
    <>
      <PageTitle overline="United MFL 2026" title="Matchlar" lead="Mavsumning barcha o‘yinlari: taqvim, natijalar va match markazlari." />
      <div className="container">
        <div className="filters">
          <span className="label">Holat</span>
          <div className="chips">
            <Link className="chip" href={href({ holat: undefined })} aria-current={!sp.holat ? "page" : undefined}>Barchasi</Link>
            <Link className="chip" href={href({ holat: "kelgusi" })} aria-current={sp.holat === "kelgusi" ? "page" : undefined}>Kelgusi</Link>
            <Link className="chip" href={href({ holat: "yakunlangan" })} aria-current={sp.holat === "yakunlangan" ? "page" : undefined}>Yakunlangan</Link>
          </div>
          {stages.length > 0 && (
            <>
              <span className="label">Bosqich</span>
              <div className="chips">
                <Link className="chip" href={href({ bosqich: undefined })} aria-current={!sp.bosqich ? "page" : undefined}>Hammasi</Link>
                {stages.map((s) => (
                  <Link key={s.id} className="chip" href={href({ bosqich: String(s.id) })} aria-current={sp.bosqich === String(s.id) ? "page" : undefined}>{s.name}</Link>
                ))}
              </div>
            </>
          )}
        </div>

        {live.length > 0 && (
          <>
            <div className="day-head"><span className="badge badge-live">Jonli</span><b>Hozir maydonda</b></div>
            <div className="card">{live.map((m) => <ResultRow key={m.id} match={m} />)}</div>
          </>
        )}

        {days.length === 0 && live.length === 0 && <div className="empty" style={{ marginTop: 32 }}>Tanlangan filtr bo‘yicha matchlar topilmadi.</div>}

        {days.map((d) => (
          <section key={d.key}>
            <div className="day-head"><b>{fmtDate(d.items[0].kickoff_at)}</b><span>{fmtWeekday(d.items[0].kickoff_at)}</span></div>
            <div className="card">{d.items.map((m) => <ResultRow key={m.id} match={m} />)}</div>
          </section>
        ))}
      </div>
    </>
  );
}
