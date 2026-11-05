import Link from "next/link";
import { Crest } from "./Crest";
import { ArrowRight, ChevronRight } from "./Icons";
import { LiveMinute } from "./LiveMinute";
import { fmtDate, fmtTime, fmtWeekday, isLive, isToday, matchMinute } from "@/lib/format";
import type { Match } from "@/lib/types";
import { matchPath } from "@/lib/seo";

export function StageBadge({ match }: { match: Match }) {
  if (isLive(match)) return <span className="badge badge-live">Jonli</span>;
  if (!match.stage) return null;
  const k = match.stage.kind;
  if (k === "final") return <span className="badge badge-accent">Final</span>;
  if (k === "group") return <span className="badge badge-muted">{match.round || "Guruh"}</span>;
  return <span className="badge badge-stage">{match.stage.name}</span>;
}

function placeholder(m: Match) {
  return m.stage?.kind === "final" ? "Yarim final g‘olibi" : "Aniqlanmagan";
}

/** Status badge for the card corner: live minute, date for upcoming, «Yakunlandi» for results. */
function StatusBadge({ m }: { m: Match }) {
  if (isLive(m)) return <span className="badge badge-live">Jonli · <LiveMinute match={m} initial={matchMinute(m)} /></span>;
  if (m.status === "scheduled") return <span className="badge badge-upcoming">{isToday(m.kickoff_at) ? "Bugun" : fmtDate(m.kickoff_at, false)}</span>;
  if (m.status === "postponed" || m.status === "cancelled") return <span className="badge badge-outline">{m.status === "postponed" ? "Qoldirildi" : "Bekor qilindi"}</span>;
  return <span className="badge badge-muted">Yakunlandi</span>;
}

export function MatchCard({ match: m, season = "United MFL 2026" }: { match: Match; season?: string }) {
  const live = isLive(m);
  const hasScore = m.home_score != null && m.away_score != null && m.status !== "scheduled";
  const stage = m.stage ? (m.stage.kind === "group" ? m.round || m.stage.name : m.stage.name) : season;
  const winner = hasScore && m.home_score !== m.away_score ? (m.home_score! > m.away_score! ? "home" : "away") : m.home_pen != null && m.away_pen != null ? (m.home_pen > m.away_pen ? "home" : "away") : null;
  const row = (side: "home" | "away") => {
    const t = side === "home" ? m.home : m.away;
    const score = side === "home" ? m.home_score : m.away_score;
    return (
      <div className={`mt-row${winner && winner !== side && m.status === "finished" ? " lose" : ""}`}>
        <Crest team={t} size={32} />
        <span className={`name${t ? "" : " tbd"}`}>{t?.name || placeholder(m)}</span>
        {hasScore && <span className="score tnum">{score}</span>}
      </div>
    );
  };
  return (
    <article className={`card card-hover match-card${live ? " is-live" : ""}`}>
      <div className="match-card-top">
        <span className="overline">{stage} · {season}</span>
        <StatusBadge m={m} />
      </div>
      <div className="match-card-teams">
        {row("home")}
        {row("away")}
        {!hasScore && (
          <div className="match-card-ko"><b className="tnum">{fmtTime(m.kickoff_at)}</b>{fmtWeekday(m.kickoff_at)} · Toshkent vaqti</div>
        )}
        {hasScore && m.home_pen != null && <div className="match-card-ko">Penaltilar {m.home_pen}:{m.away_pen}</div>}
      </div>
      <div className="match-card-foot">
        <span className="venue">{m.venue ? m.venue : fmtDate(m.kickoff_at)}</span>
        {m.ticket_url && m.status === "scheduled" ? (
          <a href={m.ticket_url} target="_blank" rel="noopener noreferrer">Chipta <ArrowRight size={14} /></a>
        ) : (
          <Link href={matchPath(m)}>Match markazi <ArrowRight size={14} /></Link>
        )}
      </div>
    </article>
  );
}

export function ResultRow({ match: m }: { match: Match }) {
  const played = m.home_score != null && m.away_score != null && m.status !== "scheduled";
  return (
    <Link href={matchPath(m)} className="result-row">
      <div className="result-meta">
        <b>{fmtDate(m.kickoff_at, false)}</b>
        {m.stage?.kind === "group" ? m.round || m.stage.name : m.stage?.name}
      </div>
      <div className="team home">
        <span>{m.home?.name || "Aniqlanmagan"}</span>
        <Crest team={m.home} size={24} />
      </div>
      <div className={`result-score tnum${played ? "" : " upcoming"}${isLive(m) ? " live" : ""}`}>
        {played ? `${m.home_score} – ${m.away_score}` : fmtTime(m.kickoff_at)}
      </div>
      <div className="team">
        <Crest team={m.away} size={24} />
        <span>{m.away?.name || "Aniqlanmagan"}</span>
      </div>
      <span className="result-link" aria-hidden>{isLive(m) ? <span className="badge badge-live">Jonli</span> : <ChevronRight size={18} />}</span>
    </Link>
  );
}
