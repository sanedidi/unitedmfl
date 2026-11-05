import type { Metadata } from "next";
import Link from "next/link";
import { api, safe } from "@/lib/api";
import { POSITION_LABEL } from "@/lib/format";
import type { Player, Team } from "@/lib/types";
import { PageTitle } from "@/components/SectionHead";
import { Search } from "@/components/Icons";
import { pageMeta, playerPath } from "@/lib/seo";

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.sahifa || "1", 10) || 1);
  const filtered = !!(sp.q || sp.jamoa || sp.pozitsiya);
  return pageMeta({
    title: page > 1 ? `O‘yinchilar — ${page}-sahifa` : "O‘yinchilar — tarkiblar va statistika",
    description: "United MFL o‘yinchilari: jamoa, amplua, raqam va mavsum statistikasi.",
    path: page > 1 && !filtered ? `/oyinchilar?sahifa=${page}` : "/oyinchilar",
    noindex: filtered,
  });
}

type SP = Promise<{ q?: string; jamoa?: string; pozitsiya?: string; sahifa?: string }>;
const LIMIT = 48;

export default async function PlayersPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.sahifa || "1", 10) || 1);
  const qs = new URLSearchParams({ limit: String(LIMIT), page: String(page) });
  if (sp.q) qs.set("q", sp.q.slice(0, 80));
  if (sp.jamoa) qs.set("team", sp.jamoa);
  if (sp.pozitsiya) qs.set("position", sp.pozitsiya);
  const [players, teams] = await Promise.all([safe(api<Player[]>(`/players?${qs}`), []), safe(api<Team[]>("/teams"), [])]);
  const link = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { q: sp.q, jamoa: sp.jamoa, pozitsiya: sp.pozitsiya, sahifa: undefined as string | undefined, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/oyinchilar?${s}` : "/oyinchilar";
  };

  return (
    <>
      <PageTitle overline="United MFL 2026" title="O‘yinchilar" />
      <div className="container">
        <form className="filters" action="/oyinchilar" role="search">
          <div className="search-form grow">
            <input className="input" name="q" defaultValue={sp.q} placeholder="O‘yinchi ismi" aria-label="O‘yinchi ismi" />
            <select className="select" name="jamoa" defaultValue={sp.jamoa || ""} aria-label="Jamoa" style={{ maxWidth: 200 }}>
              <option value="">Barcha jamoalar</option>
              {teams.map((t) => <option key={t.id} value={t.slug}>{t.name}</option>)}
            </select>
            {sp.pozitsiya && <input type="hidden" name="pozitsiya" value={sp.pozitsiya} />}
            <button className="btn btn-primary" aria-label="Qidirish"><Search /></button>
          </div>
          <div className="chips">
            <Link className="chip" href={link({ pozitsiya: undefined })} aria-current={!sp.pozitsiya ? "page" : undefined}>Hammasi</Link>
            {Object.entries(POSITION_LABEL).map(([k, v]) => (
              <Link key={k} className="chip" href={link({ pozitsiya: k })} aria-current={sp.pozitsiya === k ? "page" : undefined}>{v}</Link>
            ))}
          </div>
        </form>

        {players.length === 0 ? (
          <div className="empty" style={{ marginTop: 32 }}>O‘yinchilar topilmadi.</div>
        ) : (
          <div className="grid grid-4" style={{ marginTop: 32, gap: 12 }}>
            {players.map((p) => (
              <Link key={p.id} href={playerPath(p)} className="card card-hover player-tile">
                <span className="player-num">{p.number ?? "–"}</span>
                <span className="avatar">{p.photo_url ? <img src={p.photo_url} alt="" /> : p.full_name.slice(0, 1)}</span>
                <span className="grow">
                  <b style={{ display: "block", fontSize: 14 }}>{p.full_name}</b>
                  <small className="muted">{p.team?.name || "—"} · {POSITION_LABEL[p.position] || p.position || "—"}</small>
                </span>
              </Link>
            ))}
          </div>
        )}
        <div className="pagination">
          {page > 1 && <Link className="btn btn-ghost btn-sm" href={link({ sahifa: String(page - 1) })}>← Oldingi</Link>}
          {players.length === LIMIT && <Link className="btn btn-ghost btn-sm" href={link({ sahifa: String(page + 1) })}>Keyingi →</Link>}
        </div>
      </div>
    </>
  );
}
