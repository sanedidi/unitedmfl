import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { api, ApiError, rememberDraft, type Application } from "@/lib/api";
import { fmtDateTime, fmtDeadline } from "@/lib/format";
import { CompactHero, HELP_URL, Page, SITE_URL, StateCard } from "@/components/Shell";
import { Loading, Pill, STATUS_PILL } from "@/components/ui";
import { I } from "@/components/Icons";
import { Summary, Wizard } from "./Wizard";

import { tx } from "@/lib/i18n";
/** /a/{token}: the wizard while the application can be edited, the status page after. */
export function ApplicationPage() {
  const { token = "" } = useParams();
  const [app, setApp] = useState<Application | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.get(token)
      .then((a) => {
        setApp(a);
        if (a.link) rememberDraft(a.link.code, a.token);
      })
      .catch((e) => (e instanceof ApiError && e.status === 404 ? setApp(null) : setFailed(true)));
  }, [token]);

  if (failed) return <Page><StateCard state="none"><p className="danger-text">{tx("Sahifani yuklab bo‘lmadi — internetni tekshirib, qayta oching.")}</p></StateCard></Page>;
  if (app === undefined) return <Page><Loading /></Page>;
  if (app === null) return <Page><StateCard state="missing" /></Page>;
  if ((app.status === "draft" || app.status === "changes") && app.can_submit) return <Wizard initial={app} onDone={(a) => { setApp(a); window.scrollTo({ top: 0 }); }} />;
  if (app.status === "draft") {
    // the link was closed while the draft was unfinished
    const st = app.link?.state && app.link.state !== "open" ? app.link.state : "paused";
    return <Page><CompactHero link={app.link} title={app.team.name ? tx("{0} — ariza", app.team.name) : tx("Jamoa arizasi")} /><StateCard state={st} link={app.link}><p className="sec">{tx("Boshlangan arizangiz saqlangan — qabul qayta ochilsa, shu havola orqali davom etasiz.")}</p></StateCard></Page>;
  }
  return <StatusView app={app} />;
}

function StatusView({ app }: { app: Application }) {
  const [show, setShow] = useState(false);
  const pill = STATUS_PILL[app.status];
  const head: Record<string, { icon: React.ReactNode; tone: string; title: string; text: string }> = {
    submitted: { icon: <I.check size={32} />, tone: "", title: tx("Ariza yuborildi"), text: tx("Ariza raqami {0}. Holatni shu sahifada kuzatishingiz mumkin — havolani saqlab qo‘ying.", app.number) },
    review: { icon: <I.check size={32} />, tone: "", title: tx("Ariza ko‘rib chiqilmoqda"), text: tx("Ariza raqami {0}. Liga ma’muriyati arizani tekshirmoqda.", app.number) },
    changes: { icon: <I.alert size={30} />, tone: "warn", title: tx("Tuzatish muddati tugagan"), text: tx("Arizani tahrirlab bo‘lmaydi — liga menejeriga yozing.") },
    approved: { icon: <I.trophy size={30} />, tone: "", title: tx("{0} ligaga qabul qilindi!", app.team.name), text: tx("Jamoa sahifasi saytda ochildi. Guruhlar va match jadvali haqida liga xabar beradi.") },
    rejected: { icon: <I.x size={30} />, tone: "danger", title: tx("Ariza rad etildi"), text: app.reject_reason ? tx("Sabab: {0}", app.reject_reason) : tx("Batafsil ma’lumot uchun liga menejeriga yozing.") },
  };
  const h = head[app.status] || head.submitted;
  const timeline = [
    { st: "done", t: tx("Ariza yuborildi"), d: app.submitted_at ? fmtDateTime(app.submitted_at) : "" },
    app.status === "approved" || app.status === "rejected"
      ? { st: "done", t: tx("Ko‘rib chiqildi"), d: "" }
      : { st: "cur", t: tx("Ko‘rib chiqilmoqda"), d: "Liga ma’muriyati arizani tekshirmoqda" },
    app.status === "approved" ? { st: "done", t: tx("Tasdiqlandi"), d: app.decided_at ? fmtDateTime(app.decided_at) : "" }
      : app.status === "rejected" ? { st: "done", t: tx("Rad etildi"), d: app.decided_at ? fmtDateTime(app.decided_at) : "" }
        : { st: "todo", t: tx("Qaror"), d: "Natija shu sahifada ko‘rinadi" },
  ];
  return (
    <Page>
      <CompactHero link={app.link} title={app.team.name ? tx("{0} — ariza", app.team.name) : tx("Jamoa arizasi")} />
      <div className="wrap">
        <div className="center-col">
          <div className="status-hero">
            <div className={`big-ok ${h.tone}`}>{h.icon}</div>
            <h1>{h.title}</h1>
            <p className="sec" style={{ fontSize: 16, maxWidth: 560 }}>{h.text}</p>
          </div>
          <div className="card">
            <div className="card-head"><h3>{tx("Ariza holati")}</h3><Pill tone={pill.tone}>{pill.label}</Pill></div>
            <div className="timeline">
              {timeline.map((x, i) => (
                <div key={i} className="tl">
                  <div className="tl-rail"><span className={`tl-dot ${x.st}`}>{x.st === "done" && <I.check size={14} />}</span>{i < timeline.length - 1 && <span className="tl-line" />}</div>
                  <div className="tl-body"><b className={x.st === "todo" ? "muted" : ""}>{x.t}</b>{x.d && <small>{x.d}</small>}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="row card-pad wrapx" style={{ gap: 16 }}>
              <div className="logo-prev" style={{ width: 56, height: 56, fontSize: 14 }}>{app.team.crest_url ? <img src={app.team.crest_url} alt="" /> : app.team.short_name}</div>
              <div className="grow"><b style={{ fontSize: 18 }}>{app.team.name}</b><div className="small sec">{app.players.filter((p) => p.role !== "media").length}{" "}{tx("o‘yinchi ·")}{" "}{app.players.filter((p) => p.role === "media").length}{" "}{tx("media · {0} murabbiy ·", app.staff.length)}{" "}{app.number}</div></div>
              <button type="button" className="btn" onClick={() => setShow((v) => !v)}>{show ? tx("Yopish") : tx("Arizani ko‘rish")}</button>
            </div>
          </div>
          {show && <div className="stack"><Summary doc={app} /></div>}
          <div className="row wrapx">
            {app.status === "approved" && <a className="btn btn-primary" href={app.team_url || SITE_URL}>{tx("Jamoa sahifasini ochish")}</a>}
            <a className="btn" href={HELP_URL} target="_blank" rel="noopener noreferrer"><I.telegram size={16} />{" "}{tx("Liga menejeriga yozish")}</a>
          </div>
          {(app.status === "submitted" || app.status === "review") && (
            <div className="note"><I.lock size={16} /><div>{tx("Ko‘rib chiqish vaqtida arizani tahrirlab bo‘lmaydi. Tuzatish kerak bo‘lsa, admin izoh qoldiradi va shu sahifada tahrirlash ochiladi")}{app.changes_deadline ? tx(" ({0} gacha)", fmtDeadline(app.changes_deadline)) : ""}.</div></div>
          )}
        </div>
      </div>
    </Page>
  );
}
