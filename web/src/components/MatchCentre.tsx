"use client";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Crest } from "./Crest";
import { Ball, Calendar, Clock, Doc, Pin, Play, Swap, Ticket, Users } from "./Icons";
import { LiveMinute } from "./LiveMinute";
import { fmtDate, fmtTime, isFileVideo, isLive, matchMinute, STATUS_LABEL, youtubeId } from "@/lib/format";
import type { MatchDetail, MatchEvent } from "@/lib/types";
import { Lineups } from "./Lineups";
import { Lightbox, PhotoGrid, PhotoTeaser } from "./MatchPhotos";

import { lazyT, useT } from "@/lib/i18n";
const EVENT_LABEL: Record<string, string> = lazyT({
  goal: "Gol",
  own_goal: "Avtogol",
  penalty_goal: "Gol (penalti)",
  penalty_missed: "Penalti amalga oshmadi",
  yellow: "Sariq kartochka",
  second_yellow: "Ikkinchi sariq",
  red: "Qizil kartochka",
  sub: "Almashtirish",
  shootout_scored: "Seriya: urdi",
  shootout_missed: "Seriya: o‘tkazib yubordi",
  note: "Izoh",
  formation: "Sxema o‘zgardi",
});

function EventIcon({ type }: { type: string }) {
  if (type === "yellow") return <span className="ev-icon"><span className="card-y" /></span>;
  if (type === "red") return <span className="ev-icon"><span className="card-r" /></span>;
  if (type === "second_yellow")
    return (
      <span className="ev-icon" style={{ position: "relative" }}>
        <span className="card-y" style={{ position: "absolute", left: 3, top: 2 }} />
        <span className="card-r" style={{ position: "absolute", left: 8, top: 5 }} />
      </span>
    );
  if (type === "sub") return <span className="ev-icon" style={{ color: "var(--accent)" }}><Swap size={18} /></span>;
  if (type === "goal" || type === "penalty_goal" || type === "own_goal" || type === "shootout_scored")
    return <span className="ev-icon" style={{ color: type === "own_goal" ? "var(--red-500)" : "var(--text)" }}><Ball size={18} /></span>;
  return <span className="ev-icon muted"><Ball size={18} /></span>;
}

const minuteText = (e: MatchEvent) => (e.extra_minute ? `${e.minute}+${e.extra_minute}'` : `${e.minute}'`);

function periodOf(e: MatchEvent) {
  const tx = useT();
  if (e.type.startsWith("shootout")) return tx("Penaltilar seriyasi");
  if (e.minute <= 45) return "1-taym";
  if (e.minute <= 90) return "2-taym";
  return tx("Qo‘shimcha vaqt");
}

type Tab = "media" | "overview" | "lineups" | "officials";

export function MatchCentre({ initial, ticketFallback, ticketOwn }: { initial: MatchDetail; ticketFallback?: string; ticketOwn?: string }) {
  const tx = useT();
  const [d, setD] = useState(initial);
  const photos = d.photos ?? [];
  const hasMedia = photos.length > 0 || d.videos.length > 0 || !!d.match.video_url;
  // A finished match with a photo report or video opens on «Media».
  const [tab, setTab] = useState<Tab>(hasMedia && !isLive(initial.match) ? "media" : "overview");
  const [photo, setPhoto] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const offset = useRef(new Date(initial.server_time).getTime() - Date.now());
  const m = d.match;
  const live = isLive(m);

  // Live updates over SSE while the match is (or is about to be) in progress.
  useEffect(() => {
    const soon = m.status === "scheduled" && new Date(m.kickoff_at).getTime() - Date.now() < 3 * 3600 * 1000;
    if (!(isLive(m) || soon)) return;
    const es = new EventSource(`/api/v1/live/${m.id}`);
    es.addEventListener("match", (ev) => {
      try {
        const next = JSON.parse((ev as MessageEvent).data) as MatchDetail;
        if (next.server_time) offset.current = new Date(next.server_time).getTime() - Date.now();
        setD((prev) => ({ ...prev, ...next }));
      } catch {
        /* ignore malformed frames */
      }
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, m.status]);

  // ?foto=N opens the viewer on photo N, so a single photo can be shared.
  useEffect(() => {
    const n = Number(new URLSearchParams(window.location.search).get("foto"));
    if (n >= 1 && n <= photos.length) {
      setTab("media");
      setPhoto(n - 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const u = new URL(window.location.href);
    if (photo == null) u.searchParams.delete("foto");
    else u.searchParams.set("foto", String(photo + 1));
    if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u);
  }, [photo]);
  const credit = m.photographer ? tx("Foto: {0}", m.photographer) : "";
  const openAll = () => {
    setTab("media");
    document.getElementById("panel-media")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const events = useMemo(
    () => [...d.events].filter((e) => e.type !== "period").sort((a, b) => a.minute - b.minute || a.extra_minute - b.extra_minute || a.id - b.id),
    [d.events],
  );
  const grouped = useMemo(() => {
    const g: { label: string; items: MatchEvent[] }[] = [];
    for (const e of events) {
      const label = periodOf(e);
      if (!g.length || g[g.length - 1].label !== label) g.push({ label, items: [] });
      g[g.length - 1].items.push(e);
    }
    return g;
  }, [events]);

  const goals = (side: "home" | "away") =>
    events.filter((e) => (e.type === "goal" || e.type === "penalty_goal") ? e.side === side : e.type === "own_goal" ? e.side !== side : false);

  const hasScore = m.home_score != null && m.away_score != null && m.status !== "scheduled";
  const ticket = m.ticket_url || ticketFallback;
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "media", label: tx("Media"), show: hasMedia },
    { id: "overview", label: tx("Umumiy"), show: true },
    { id: "lineups", label: tx("Tarkiblar"), show: m.status !== "cancelled" },
    { id: "officials", label: tx("Hakamlar"), show: d.officials.length > 0 },
  ];

  return (
    <>
      <section className={`mc-top${live ? " live" : ""}`}>
        <h1 className="sr-only">
          {m.home?.name || tx("Aniqlanmagan")} — {m.away?.name || tx("Aniqlanmagan")}
          {hasScore ? ` ${m.home_score}:${m.away_score}` : ""}, {m.stage?.name || "United MFL"}, {fmtDate(m.kickoff_at)}
        </h1>
        <div className="row" style={{ justifyContent: "center", flexWrap: "wrap", gap: 8 }}>
          {live ? <span className="badge badge-live">{tx("Jonli")}</span> : m.stage && <span className="badge badge-muted">{m.stage.name}</span>}
          <span className="overline" style={{ color: "var(--text-2)", fontSize: 11 }}>{m.season_id == null ? m.round || tx("O‘rtoqlik o‘yini") : tx("United MFL 2026{0}", m.round && m.stage?.kind === "group" ? ` · ${m.round}` : "")}</span>
        </div>

        <div className="mc-board">
          <div className="mc-team home">
            {m.home ? <Link href={`/jamoalar/${m.home.slug}`}>{m.home.name}</Link> : <span className="muted">{tx("Aniqlanmagan")}</span>}
            <Crest team={m.home} size={72} />
          </div>
          <div>
            <div className="mc-score tnum" aria-live="polite">
              {hasScore ? <>{m.home_score}<span style={{ opacity: .6 }}> : </span>{m.away_score}</> : fmtTime(m.kickoff_at)}
            </div>
          </div>
          <div className="mc-team away">
            <Crest team={m.away} size={72} />
            {m.away ? <Link href={`/jamoalar/${m.away.slug}`}>{m.away.name}</Link> : <span className="muted">{tx("Aniqlanmagan")}</span>}
          </div>
        </div>

        <div className={`mc-status${live ? " live" : ""}`}>
          {live ? (
            <>
              <LiveMinute match={m} serverOffsetMs={offset.current} initial={matchMinute(m, new Date(initial.server_time).getTime())} />
              {connected ? tx(" · Jonli yangilanmoqda") : ""}
            </>
          ) : (
            STATUS_LABEL[m.status] || m.status
          )}
          {m.home_ht != null && m.status === "finished" && <>{" "}{tx("· 1-taym {0}:", m.home_ht)}{m.away_ht}</>}
          {m.home_pen != null && <>{" "}{tx("· Penaltilar {0}:", m.home_pen)}{m.away_pen}</>}
        </div>

        {hasScore && (goals("home").length > 0 || goals("away").length > 0) && (
          <div className="mc-board" style={{ margin: "14px 0 0", fontSize: 13, color: "var(--text-2)", alignItems: "start" }}>
            <div style={{ textAlign: "right" }}>{goals("home").map((e) => <div key={e.id}>{e.player_name || "—"} {minuteText(e)}{e.type === "penalty_goal" ? tx(" (p)") : e.type === "own_goal" ? tx(" (a.g.)") : ""}</div>)}</div>
            <Ball size={14} />
            <div style={{ textAlign: "left" }}>{goals("away").map((e) => <div key={e.id}>{e.player_name || "—"} {minuteText(e)}{e.type === "penalty_goal" ? tx(" (p)") : e.type === "own_goal" ? tx(" (a.g.)") : ""}</div>)}</div>
          </div>
        )}

        <div className="mc-meta">
          <span><Calendar size={14} /> {fmtDate(m.kickoff_at)}</span>
          <span><Clock size={14} /> {fmtTime(m.kickoff_at)}</span>
          <span><Pin size={14} /> {m.venue || tx("Stadion: e’lon qilinmagan")}</span>
          {m.attendance != null && <span><Users size={14} />{" "}{tx("{0} tomoshabin", m.attendance.toLocaleString("ru-RU"))}</span>}
        </div>

        <div className="row" style={{ justifyContent: "center", marginTop: 24, flexWrap: "wrap" }}>
          {m.status === "scheduled" && ticketOwn ? (
            <Link className="btn btn-primary" href={ticketOwn}>{tx("Chipta sotib olish")}{" "}<Ticket /></Link>
          ) : m.status === "scheduled" && ticket && (
            <a className="btn btn-primary" href={ticket} target="_blank" rel="noopener noreferrer">{tx("Chipta sotib olish")}{" "}<Ticket /></a>
          )}
          {m.video_url && (
            <a className="btn btn-ghost" href={m.video_url} target="_blank" rel="noopener noreferrer">{tx("Videosharhni ko‘rish")}{" "}<Play /></a>
          )}
          {d.protocol_pdf && (
            <a className="btn btn-ghost" href={d.protocol_pdf} target="_blank" rel="noopener noreferrer"><Doc />{" "}{tx("Match protokoli (PDF)")}</a>
          )}
        </div>
      </section>

      <div className="tabs" role="tablist">
        {tabs.filter((t) => t.show).map((t) => (
          <button key={t.id} role="tab" aria-controls={`panel-${t.id}`} aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div role="tabpanel" id="panel-overview" aria-label="overview" hidden={tab !== "overview"}>
        <div className="grid" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", alignItems: "start" }} data-mc-grid>
          <div className="stack" style={{ minWidth: 0 }}>
          <section className="card card-pad">
            <h2 className="h4" style={{ marginBottom: 8 }}>{tx("Voqealar")}</h2>
            {events.length === 0 ? (
              <p className="muted" style={{ margin: "12px 0" }}>{m.status === "scheduled" ? tx("Match hali boshlanmagan.") : tx("Voqealar hali kiritilmagan.")}</p>
            ) : (
              <div className="timeline">
                {grouped.map((g) => (
                  <div key={g.label}>
                    <div className="tl-period">{g.label}</div>
                    {g.items.map((e) => (
                      <div className="tl-row" key={e.id}>
                        <div className={`tl-ev home`}>{e.side === "home" && <EventLine e={e} />}</div>
                        <div className="tl-min">{e.type.startsWith("shootout") ? "•" : minuteText(e)}</div>
                        <div className="tl-ev">{e.side === "away" && <EventLine e={e} />}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>
          {photos.length > 0 && <PhotoTeaser photos={photos} credit={credit} onOpen={setPhoto} onAll={openAll} />}
          </div>
          <aside className="stack">
            <section className="card card-pad">
              <h2 className="h4" style={{ marginBottom: 16 }}>{tx("Match ma’lumotlari")}</h2>
              <dl className="kv">
                <dt>{tx("Bosqich")}</dt><dd>{m.stage?.name || "—"}</dd>
                <dt>{tx("Sana")}</dt><dd>{fmtDate(m.kickoff_at)}, {fmtTime(m.kickoff_at)}</dd>
                <dt>{tx("Stadion")}</dt><dd>{m.venue || "—"}</dd>
                {m.attendance != null && (<><dt>{tx("Tomoshabinlar")}</dt><dd>{m.attendance.toLocaleString("ru-RU")}</dd></>)}
                {m.home_ht != null && (<><dt>{tx("1-taym")}</dt><dd>{m.home_ht}:{m.away_ht}</dd></>)}
                {m.home_et != null && (<><dt>{tx("Qo‘sh. vaqt")}</dt><dd>{m.home_et}:{m.away_et}</dd></>)}
                {m.home_pen != null && (<><dt>{tx("Penaltilar")}</dt><dd>{m.home_pen}:{m.away_pen}</dd></>)}
              </dl>
            </section>
            {d.news.length > 0 && (
              <section className="card card-pad">
                <h2 className="h4" style={{ marginBottom: 12 }}>{tx("Match haqida")}</h2>
                <div className="stack" style={{ gap: 12 }}>
                  {d.news.map((n) => (
                    <Link key={n.slug} href={`/yangiliklar/${n.slug}`} style={{ fontWeight: 600 }}>{n.title}</Link>
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>

      <div role="tabpanel" id="panel-lineups" aria-label="lineups" hidden={tab !== "lineups"}>
        <Lineups d={d} live={live} serverOffset={offset.current} />
      </div>

      <div role="tabpanel" id="panel-officials" aria-label="officials" hidden={tab !== "officials"}>
        <div className="grid grid-3">
          {[
            { t: tx("Match hakamlari"), rows: d.officials.filter((o) => !o.side) },
            { t: m.home?.name || tx("Uy egalari"), rows: d.officials.filter((o) => o.side === "home") },
            { t: m.away?.name || tx("Mehmonlar"), rows: d.officials.filter((o) => o.side === "away") },
          ].filter((x) => x.rows.length).map((x) => (
            <section key={x.t} className="card card-pad">
              <h2 className="h4" style={{ marginBottom: 12 }}>{x.t}</h2>
              <dl className="kv">
                {x.rows.map((o) => (<Fragment key={o.id}><dt>{cap(o.role)}</dt><dd>{o.name}</dd></Fragment>))}
              </dl>
            </section>
          ))}
        </div>
      </div>

      <div role="tabpanel" id="panel-media" aria-label="media" hidden={tab !== "media"}>
        <div className="stack" style={{ gap: 48 }}>
        {photos.length > 0 && (
          <section>
            <div className="ph-head">
              <div>
                <h2 className="h3">{tx("Foto hisobot")}</h2>
                <p className="muted" style={{ marginTop: 6, fontSize: 14 }}>{[tx("{0} ta foto", photos.length), credit, m.venue].filter(Boolean).join(" · ")}</p>
              </div>
            </div>
            <PhotoGrid photos={photos} onOpen={setPhoto} />
          </section>
        )}
        {(d.videos.length > 0 || !!m.video_url) && (
          <section>
            <h2 className="h3" style={{ marginBottom: 20 }}>{tx("Video")}</h2>
        <div className="grid grid-2">
          {[...(m.video_url ? [{ id: 0, title: tx("Videosharh"), url: m.video_url, youtube_id: "", thumbnail_url: "" }] : []), ...d.videos].map((v) => {
            const yt = youtubeId(v.url, v.youtube_id);
            return (
              <section key={v.id} className="stack" style={{ gap: 10 }}>
                {isFileVideo(v) ? (
                  <video className="embed" src={v.url} poster={v.thumbnail_url || undefined} controls playsInline preload="metadata" />
                ) : yt ? (
                  <iframe className="embed" src={`https://www.youtube-nocookie.com/embed/${yt}`} title={v.title} loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
                ) : (
                  <a className="btn btn-ghost" href={v.url} target="_blank" rel="noopener noreferrer"><Play /> {v.title}</a>
                )}
                <b>{v.title}</b>
              </section>
            );
          })}
            </div>
          </section>
        )}
        </div>
      </div>

      {photo != null && photos[photo] && (
        <Lightbox photos={photos} index={photo} onIndex={setPhoto} onClose={() => setPhoto(null)} credit={credit}
          title={`${m.home?.name || "?"} — ${m.away?.name || "?"}${hasScore ? ` · ${m.home_score}:${m.away_score}` : ""}`} />
      )}
    </>
  );
}

function cap(s: string) {
  const l = s.toLocaleLowerCase("uz");
  return l.charAt(0).toLocaleUpperCase("uz") + l.slice(1);
}

function EventLine({ e }: { e: MatchEvent }) {
  const tx = useT();
  const right = e.side === "home";
  const text = (
    <span>
      {e.player_name || EVENT_LABEL[e.type] || e.type}
      <small>
        {e.type === "sub" ? (e.related_player_name ? `↓ ${e.related_player_name}` : tx("Almashtirish")) : EVENT_LABEL[e.type] || ""}
        {e.note ? ` · ${e.note}` : ""}
      </small>
    </span>
  );
  return right ? (<>{text}<EventIcon type={e.type} /></>) : (<><EventIcon type={e.type} />{text}</>);
}
