import Link from "next/link";
import { Crest } from "./Crest";
import { ArrowRight, Calendar, Clock, Ticket } from "./Icons";
import { LiveMinute } from "./LiveMinute";
import { fmtDate, fmtTime, fmtWeekday, isLive, isToday, matchMinute } from "@/lib/format";
import type { Match } from "@/lib/types";

export function StageBadge({ match }: { match: Match }) {
  if (isLive(match)) return <span className="badge badge-live">Jonli</span>;
  if (!match.stage) return null;
  const k = match.stage.kind;
  if (k === "final") return <span className="badge badge-accent">Final</span>;
  if (k === "group") return <span className="badge badge-muted">{match.round || "Guruh"}</span>;
  return <span className="badge badge-stage">{match.stage.name}</span>;
}

function placeholder(m: Match, side: "home" | "away") {
  const k = m.stage?.kind;
  if (k === "final") return "Yarim final g‘olibi";
  return "Aniqlanmagan";
}

export function MatchCard({ match: m, season = "United MFL 2026" }: { match: Match; season?: string }) {
  const live = isLive(m);
  const hasScore = m.home_score != null && m.away_score != null && m.status !== "scheduled";
  const day = isToday(m.kickoff_at) ? "Bugun" : fmtDate(m.kickoff_at);
  return (
    <article className={`card card-hover match-card${live ? " is-live" : ""}`}>
      <div className="match-card-top">
        <span>{season}</span>
        <StageBadge match={m} />
      </div>
      <div className="match-card-mid">
        <div className="match-team">
          <Crest team={m.home} size={52} />
          <span>{m.home?.name || placeholder(m, "home")}</span>
        </div>
        <div>
          {hasScore ? (
            <div className="match-score">{m.home_score} : {m.away_score}</div>
          ) : (
            <div className="match-time">{fmtTime(m.kickoff_at)}</div>
          )}
          <div className="match-sub">
            {live ? (
              <span style={{ color: "var(--live-text)", fontWeight: 700 }}>
                <LiveMinute match={m} initial={matchMinute(m)} />
              </span>
            ) : hasScore ? (
              m.home_pen != null ? <span>pen. {m.home_pen}:{m.away_pen}</span> : <span>Yakunlandi</span>
            ) : (
              <><Clock size={13} /> {fmtWeekday(m.kickoff_at)}</>
            )}
          </div>
        </div>
        <div className="match-team">
          <Crest team={m.away} size={52} />
          <span>{m.away?.name || placeholder(m, "away")}</span>
        </div>
      </div>
      <div className="match-card-foot">
        <span className="row" style={{ gap: 6 }}>
          <Calendar size={14} /> {day}{m.venue ? ` · ${m.venue.split(",")[0]}` : ""}
        </span>
        {m.ticket_url && m.status === "scheduled" ? (
          <a className="ticket" href={m.ticket_url} target="_blank" rel="noopener noreferrer">Chipta <Ticket /></a>
        ) : (
          <Link href={`/matchlar/${m.id}`}>Batafsil <ArrowRight /></Link>
        )}
      </div>
    </article>
  );
}

export function ResultRow({ match: m }: { match: Match }) {
  const played = m.home_score != null && m.away_score != null && m.status !== "scheduled";
  return (
    <Link href={`/matchlar/${m.id}`} className="result-row">
      <div className="result-meta">
        <b>{fmtDate(m.kickoff_at, false)}</b>
        {m.stage?.kind === "group" ? m.round || m.stage.name : m.stage?.name}
      </div>
      <div className="team home">
        <span>{m.home?.name || "Aniqlanmagan"}</span>
        <Crest team={m.home} size={36} />
      </div>
      <div className={`result-score tnum${played ? "" : " upcoming"}`}>
        {played ? `${m.home_score}:${m.away_score}` : fmtTime(m.kickoff_at)}
      </div>
      <div className="team">
        <Crest team={m.away} size={36} />
        <span>{m.away?.name || "Aniqlanmagan"}</span>
      </div>
      <span className="result-link">{isLive(m) ? <span className="badge badge-live">Jonli</span> : <>Match markazi →</>}</span>
    </Link>
  );
}
