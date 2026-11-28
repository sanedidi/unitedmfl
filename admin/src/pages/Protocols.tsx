import { useEffect, useMemo, useRef, useState } from "react";
import { Allowed } from "@/lib/auth";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, blobUrl, request, type Page } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { EVENT_LABEL, fmtBytes, fmtDateTime, fmtShort } from "@/lib/format";
import type { Extracted, Issue, Match, Protocol, ProtoEvent, ProtoPlayer } from "@/lib/types";
import { PageHead } from "@/components/Layout";
import { Badge, Crest, Empty, ErrorBox, Loading, Modal, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";
import { MatchVs } from "./Matches";

import { tx } from "@/lib/i18n";
const STATUS: Record<string, { label: string; tone: string }> = {
  uploaded: { label: tx("Yuklandi"), tone: "info" },
  processing: { label: tx("Tanilmoqda"), tone: "info" },
  review: { label: tx("Tekshiruvda"), tone: "warn" },
  applied: { label: tx("Qo‘llandi"), tone: "ok" },
  failed: { label: tx("Xato"), tone: "danger" },
  rejected: { label: tx("Rad etildi"), tone: "" },
};

/* ---------- List + upload ---------- */
export function ProtocolsPage() {
  const [status, setStatus] = useState("");
  const { data, error, loading, reload } = useLoad(() => api.get<Page<Protocol>>(`/admin/protocols?limit=100${status ? `&status=${status}` : ""}`), [status]);
  const [upload, setUpload] = useState(false);
  const nav = useNavigate();
  // refresh while something is being processed
  useEffect(() => {
    if (!data?.items.some((p) => p.status === "processing" || p.status === "uploaded")) return;
    const t = setTimeout(reload, 2000);
    return () => clearTimeout(t);
  }, [data, reload]);
  return (
    <>
      <PageHead title={tx("Protokollar")} sub={tx("Match protokollarini yuklash (PDF, rasm yoki telefon surati), tekshirish va natijaga qo‘llash")} actions={<Allowed to="create"><button className="btn btn-primary" onClick={() => setUpload(true)}><I.upload size={16} />{" "}{tx("Protokol yuklash")}</button></Allowed>} />
      <div className="card">
        <div className="toolbar">
          <div className="seg">
            {[["", tx("Hammasi")], ["review", tx("Tekshiruvda")], ["applied", tx("Qo‘llangan")], ["failed", tx("Xato")]].map(([v, l]) => <button key={v} aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>)}
          </div>
        </div>
        {error ? <div className="card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : !data?.items.length ? (
          <Empty title={tx("Protokollar yo‘q")} text={tx("Birinchi protokolni yuklang — tizim jamoalar, hisob, tarkib, voqealar va hakamlarni o‘zi taniydi.")} action={<Allowed to="create"><button className="btn btn-primary" onClick={() => setUpload(true)}><I.upload size={16} />{" "}{tx("Yuklash")}</button></Allowed>} />
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{tx("Fayl")}</th><th>{tx("Match (protokol bo‘yicha)")}</th><th className="hide-mobile">{tx("Yuklangan")}</th><th>{tx("Holat")}</th><th>{tx("Muammolar")}</th></tr></thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => nav(`/protocols/${p.id}`)}>
                  <td><div className="row"><I.doc /><div><b className="ellipsis" style={{ maxWidth: 220, display: "block" }}>{p.file_name}</b><span className="muted small">{fmtBytes(p.size_bytes)} · {p.pages || "?"}{" "}{tx("bet ·")}{" "}{p.method === "ocr" ? "OCR" : tx("PDF matn")}</span></div></div></td>
                  <td>{p.home_name ? <><b>{p.home_name} — {p.away_name}</b><div className="muted small">{p.tournament} · {p.stage} · {p.date}</div></> : <span className="muted">—</span>}</td>
                  <td className="hide-mobile nowrap">{fmtDateTime(p.created_at)}<div className="muted small">{p.uploaded_by_name}</div></td>
                  <td>
                    <Badge tone={STATUS[p.status]?.tone}>{STATUS[p.status]?.label || p.status}</Badge>
                    {p.status === "processing" && <div className="progress" style={{ marginTop: 6, width: 100 }}><i style={{ width: `${p.progress}%` }} /></div>}
                  </td>
                  <td>{p.problems_count ? <Badge tone="warn">{p.problems_count}</Badge> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
      {upload && <UploadModal onClose={() => setUpload(false)} onDone={(id) => nav(`/protocols/${id}`)} />}
    </>
  );
}

function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: (id: number) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [matchId, setMatchId] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const matches = useLoad(() => api.get<Page<Match>>("/admin/matches?limit=200"), []);
  async function send() {
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    if (matchId) fd.append("match_id", matchId);
    try {
      const r = await request<{ id: number }>("POST", "/admin/protocols", fd);
      toast(tx("Protokol yuklandi, tanilmoqda…"));
      onDone(r.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={tx("Protokol yuklash")} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{tx("Bekor qilish")}</button>
      <button className="btn btn-primary" onClick={send} disabled={!file || busy}>{busy ? tx("Yuklanmoqda…") : tx("Yuklash va tanish")}</button>
    </>}>
      <div className="stack">
        <div className={`dropzone${over ? " over" : ""}`} onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); setFile(e.dataTransfer.files?.[0] || null); }}>
          <I.upload size={28} />
          <div style={{ marginTop: 10, fontWeight: 600 }}>{file ? file.name : tx("Faylni shu yerga tashlang yoki tanlang")}</div>
          <div className="muted small" style={{ marginTop: 4 }}>{file ? fmtBytes(file.size) : tx("PDF, JPG, PNG — 20 MB gacha")}</div>
        </div>
        <button type="button" className="btn btn-block mobile-only" onClick={() => camera.current?.click()}><I.camera size={16} />{" "}{tx("Suratga olish")}</button>
        <input ref={input} type="file" hidden accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <input ref={camera} type="file" hidden accept="image/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <div className="field">
          <label>{tx("Match (ixtiyoriy)")}</label>
          <select className="select" value={matchId} onChange={(e) => setMatchId(e.target.value)}>
            <option value="">{tx("Avtomatik aniqlash (jamoalar va sana bo‘yicha)")}</option>
            {matches.data?.items.map((m) => <option key={m.id} value={m.id}>{fmtShort(m.kickoff_at)} · {m.home?.name || "?"} — {m.away?.name || "?"}</option>)}
          </select>
        </div>
        <div className="alert info"><I.alert size={16} />{" "}{tx("Hech narsa avtomatik saqlanmaydi: tanilgan ma’lumotlarni tekshirib, so‘ng «Qo‘llash» tugmasini bosasiz.")}</div>
      </div>
    </Modal>
  );
}

/* ---------- Review ---------- */
type Detail = { protocol: Protocol; file_url: string; suggested_matches: Match[] };
type Tab = "events" | "players" | "officials" | "header";

export function ProtocolReviewPage() {
  const { id } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const { data, error, loading, reload, setData } = useLoad(() => api.get<Detail>(`/admin/protocols/${id}`), [id]);
  const [ex, setEx] = useState<Extracted | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("events");
  const [matchId, setMatchId] = useState<number | null>(null);
  const [fileUrl, setFileUrl] = useState("");
  const [applyOpen, setApplyOpen] = useState(false);
  const p = data?.protocol;

  useEffect(() => {
    if (p?.extracted && !dirty) setEx(structuredClone(p.extracted));
    if (p) setMatchId((v) => v ?? p.match_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p]);
  useEffect(() => {
    if (p && (p.status === "processing" || p.status === "uploaded")) {
      const t = setTimeout(reload, 1500);
      return () => clearTimeout(t);
    }
  }, [p, reload]);
  useEffect(() => {
    let url = "";
    if (data?.protocol.id) blobUrl(`/admin/protocols/${data.protocol.id}/file`).then((u) => setFileUrl((url = u))).catch(() => {});
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [data?.protocol.id]);

  const issues: Issue[] = p?.issues || [];
  const flags = useMemo(() => {
    const m = new Map<string, Issue>();
    for (const i of issues) if (!m.has(i.ref) || i.severity === "error") m.set(i.ref, i);
    return m;
  }, [issues]);

  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading && !data) return <Loading />;
  if (!p) return null;
  const editable = p.status === "review";

  async function save(rederive = false) {
    if (!ex) return;
    try {
      const r = await api.put<{ issues: Issue[] }>(`/admin/protocols/${p!.id}/extracted`, { extracted: ex, match_id: matchId });
      if (rederive) await api.post(`/admin/protocols/${p!.id}/rederive`);
      setDirty(false);
      toast(rederive ? tx("Voqealar tarkibdan qayta tuzildi") : tx("Saqlandi"));
      if (!rederive) setData((d) => (d ? { ...d, protocol: { ...d.protocol, issues: r.issues, extracted: ex, match_id: matchId } } : d));
      else { setEx(null); reload(); }
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    }
  }
  async function reject() {
    if (!(await confirm({ title: tx("Protokolni rad etish?"), text: tx("Ma’lumotlar natijaga qo‘llanmaydi."), ok: tx("Rad etish"), danger: true }))) return;
    await api.post(`/admin/protocols/${p!.id}/reject`).then(() => { toast(tx("Rad etildi")); reload(); }, (e) => toast(e.message, "error"));
  }
  async function reprocess() {
    await api.post(`/admin/protocols/${p!.id}/reprocess`).then(() => { setEx(null); setDirty(false); reload(); }, (e) => toast(e.message, "error"));
  }
  const upd = (fn: (x: Extracted) => void) => setEx((cur) => {
    if (!cur) return cur;
    const next = structuredClone(cur);
    fn(next);
    setDirty(true);
    return next;
  });
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><Link to="/protocols" className="btn btn-ghost btn-sm"><I.back size={16} />{" "}{tx("Protokollar")}</Link></div>
      <PageHead title={ex ? `${ex.home.name || "?"} — ${ex.away.name || "?"}` : p.file_name}
        sub={<span className="row wrap"><Badge tone={STATUS[p.status]?.tone}>{STATUS[p.status]?.label}</Badge> {ex && <span>{ex.tournament} · {ex.stage} · {ex.date} {ex.time}</span>}</span>}
        actions={<>
          {fileUrl && <a className="btn" href={fileUrl} target="_blank" rel="noreferrer"><I.eye size={16} />{" "}{tx("Asl fayl")}</a>}
          <Allowed to="edit">
            {(p.status === "failed" || p.status === "review") && <button className="btn" onClick={reprocess}><I.refresh size={16} />{" "}{tx("Qayta tanish")}</button>}
            {editable && <button className="btn btn-danger" onClick={reject}>{tx("Rad etish")}</button>}
            {editable && <button className="btn btn-primary" onClick={async () => { if (dirty) await save(); setApplyOpen(true); }} disabled={!matchId}><I.check size={16} />{" "}{tx("Qo‘llash")}</button>}
          </Allowed>
        </>} />

      {(p.status === "processing" || p.status === "uploaded") && (
        <div className="card card-pad stack"><b>{tx("Protokol tanilmoqda…")}</b><div className="progress"><i style={{ width: `${p.progress}%` }} /></div><span className="muted small">{tx("PDF matn qatlami yoki OCR orqali jadval tuzilmasi o‘qilmoqda.")}</span></div>
      )}
      {p.status === "failed" && <div className="alert danger"><I.alert size={16} /> {p.error || tx("Protokolni tanib bo‘lmadi")}</div>}
      {p.status === "applied" && <div className="alert ok" style={{ marginBottom: 16 }}><I.check size={16} />{" "}{tx("Protokol {0} da qo‘llangan.", fmtDateTime(p.applied_at))}{" "}{p.match_id && <Link to={`/matches/${p.match_id}`} style={{ textDecoration: "underline" }}>{tx("Matchni ochish")}</Link>}</div>}

      {ex && (
        <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px", alignItems: "start" }} data-split>
          <div className="stack">
            <div className="card card-pad">
              <div className="grid g3" style={{ alignItems: "center" }}>
                <ScoreSide name={ex.home.name} s={ex.home} />
                <div className="center"><div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 36 }}>{ex.home.total ?? "?"} : {ex.away.total ?? "?"}</div>
                  <div className="muted small">{tx("1-taym {0}:{1} · q.v.", ex.home.half1 ?? "–", ex.away.half1 ?? "–")}{" "}{ex.home.extra ?? "–"}:{ex.away.extra ?? "–"}{" "}{tx("· pen. {0}:", ex.home.penalty ?? "–")}{ex.away.penalty ?? "–"}</div></div>
                <ScoreSide name={ex.away.name} s={ex.away} right />
              </div>
              <hr className="sep" />
              <div className="row wrap small sec" style={{ gap: 16 }}>
                <span>{tx("Stadion:")}{" "}<b>{ex.venue || "—"}</b></span><span>{tx("Tomoshabinlar:")}{" "}<b>{ex.attendance ?? "—"}</b></span>
                <span>{tx("Qo‘shilgan vaqt:")}{" "}<b>{ex.added_time_1h ?? "–"} / {ex.added_time_2h ?? "–"}</b></span>
                <span>{tx("Usul:")}{" "}<b>{p.method === "ocr" ? "OCR" : tx("PDF matn qatlami")}</b></span>
              </div>
            </div>

            <div className="tabs" role="tablist" style={{ marginBottom: 0 }}>
              {([["events", tx("Voqealar ({0})", ex.events.length)], ["players", tx("Tarkiblar ({0})", ex.players.length)], ["officials", tx("Rasmiylar")], ["header", tx("Sarlavha va hisob")]] as [Tab, string][]).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>
            {tab === "events" && <EventsTable ex={ex} flags={flags} editable={editable} upd={upd} />}
            {tab === "players" && <PlayersTable ex={ex} flags={flags} editable={editable} upd={upd} onRederive={() => save(true)} />}
            {tab === "officials" && <OfficialsTable ex={ex} editable={editable} upd={upd} />}
            {tab === "header" && <HeaderForm ex={ex} editable={editable} upd={upd} />}
            {editable && dirty && (
              <div className="card card-pad row" style={{ justifyContent: "space-between", position: "sticky", bottom: 12, boxShadow: "var(--shadow-lg)" }}>
                <span>{tx("Saqlanmagan o‘zgarishlar bor")}</span>
                <div className="row"><button className="btn" onClick={() => { setEx(structuredClone(p.extracted!)); setDirty(false); }}>{tx("Bekor qilish")}</button><button className="btn btn-primary" onClick={() => save()}>{tx("Saqlash va tekshirish")}</button></div>
              </div>
            )}
          </div>

          <aside className="stack">
            <div className="card">
              <div className="card-head"><h3>{tx("Match")}</h3></div>
              <div className="card-pad stack" style={{ gap: 10 }}>
                {data!.suggested_matches.length === 0 && <span className="muted small">{tx("Mos match topilmadi — ro‘yxatdan tanlang yoki «Matchlar» bo‘limida yarating.")}</span>}
                {data!.suggested_matches.map((m) => (
                  <label key={m.id} className="check" style={{ alignItems: "flex-start", padding: 10, border: "1px solid var(--border)", borderRadius: 10, background: matchId === m.id ? "var(--bg-accent-subtle)" : undefined }}>
                    <input type="radio" name="match" checked={matchId === m.id} disabled={!editable} onChange={() => { setMatchId(m.id); setDirty(true); }} />
                    <span className="grow"><MatchVs m={m} /><span className="muted small">{fmtShort(m.kickoff_at)}</span></span>
                  </label>
                ))}
                {editable && <MatchSelect value={matchId} onChange={(v) => { setMatchId(v); setDirty(true); }} />}
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h3>{tx("Tekshiruv")}</h3><span className="row small">{errors > 0 && <Badge tone="danger">{errors}</Badge>}{warnings > 0 && <Badge tone="warn">{warnings}</Badge>}</span></div>
              <div className="card-pad stack" style={{ gap: 8 }}>
                {issues.length === 0 && <span className="row" style={{ color: "var(--text-accent)" }}><I.check size={16} />{" "}{tx("Muammo topilmadi")}</span>}
                {issues.map((i, k) => (
                  <div key={k} className={`issue ${i.severity}`}><I.alert size={16} /><div className="small">{i.message}</div></div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      )}

      {applyOpen && ex && matchId && (
        <ApplyModal protocol={p} ex={ex} matchId={matchId} hasErrors={errors > 0} onClose={() => setApplyOpen(false)} onApplied={(mid) => { setApplyOpen(false); toast(tx("Protokol qo‘llandi")); nav(`/matches/${mid}`); }} />
      )}
    </>
  );
}

function ScoreSide({ name, s, right }: { name: string; s: Extracted["home"]; right?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: right ? "flex-start" : "flex-end", flexDirection: right ? "row" : "row-reverse" }}>
      <Crest team={{ id: name.length, name }} size={40} />
      <b style={{ fontSize: 18 }}>{name || "?"}</b>
      <span className="muted small">{s.half1 ?? "–"} / {s.half2 ?? "–"}</span>
    </div>
  );
}

function MatchSelect({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const { data } = useLoad(() => api.get<Page<Match>>("/admin/matches?limit=200"), []);
  return (
    <select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{tx("Boshqa matchni tanlash…")}</option>
      {data?.items.map((m) => <option key={m.id} value={m.id}>{fmtShort(m.kickoff_at)} · {m.home?.name || "?"} — {m.away?.name || "?"}</option>)}
    </select>
  );
}

type Upd = (fn: (x: Extracted) => void) => void;
const rawMinute = (m: number, x: number) => (x ? `${m}+${x}` : String(m));
const TYPES = ["goal", "own_goal", "penalty_goal", "penalty_missed", "yellow", "second_yellow", "red", "sub", "shootout_scored", "shootout_missed"];

function EventsTable({ ex, flags, editable, upd }: { ex: Extracted; flags: Map<string, Issue>; editable: boolean; upd: Upd }) {
  const set = (i: number, patch: Partial<ProtoEvent>) => upd((x) => Object.assign(x.events[i], patch));
  return (
    <div className="card">
      <div className="table-wrap"><table className="table">
        <thead><tr><th>{tx("Daqiqa")}</th><th>{tx("Jamoa")}</th><th>{tx("Voqea")}</th><th>№</th><th>{tx("O‘yinchi")}</th><th>{tx("Almashgan")}</th><th /></tr></thead>
        <tbody>
          {ex.events.map((e, i) => {
            const f = flags.get(`events[${i}]`);
            return (
              <tr key={i} className={f ? `flag-${f.severity}` : ""} title={f?.message}>
                <td style={{ width: 120 }}>{editable ? <div className="row" style={{ gap: 4 }}><input className="input input-sm" style={{ width: 54 }} type="number" value={e.minute} onChange={(ev) => set(i, { minute: Number(ev.target.value), raw: rawMinute(Number(ev.target.value), e.extra), uncertain: false })} />+<input className="input input-sm" style={{ width: 46 }} type="number" value={e.extra} onChange={(ev) => set(i, { extra: Number(ev.target.value), raw: rawMinute(e.minute, Number(ev.target.value)) })} /></div> : <b>{e.minute}{e.extra ? `+${e.extra}` : ""}′</b>}</td>
                <td>{editable ? <select className="select input-sm" value={e.side} onChange={(ev) => set(i, { side: ev.target.value as "home" | "away" })}><option value="home">{ex.home.name}</option><option value="away">{ex.away.name}</option></select> : e.side === "home" ? ex.home.name : ex.away.name}</td>
                <td>{editable ? <select className="select input-sm" value={e.type} onChange={(ev) => set(i, { type: ev.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{EVENT_LABEL[t]}</option>)}</select> : EVENT_LABEL[e.type]}</td>
                <td className="tnum">{e.number ?? "—"}</td>
                <td>{editable ? <input className="input input-sm" value={e.player || ""} onChange={(ev) => set(i, { player: ev.target.value })} /> : e.player}</td>
                <td>{e.type === "sub" ? (editable ? <input className="input input-sm" value={e.related || ""} onChange={(ev) => set(i, { related: ev.target.value, uncertain: false })} /> : e.related) : <span className="muted">—</span>}</td>
                <td className="actions">{editable && <button className="btn btn-ghost btn-sm btn-icon" aria-label={tx("O‘chirish")} onClick={() => upd((x) => x.events.splice(i, 1))}><I.x size={16} /></button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      {editable && <div style={{ padding: 12 }}><button className="btn btn-sm btn-ghost" onClick={() => upd((x) => x.events.push({ side: "home", type: "goal", minute: 1, extra: 0, raw: "1", player: "" }))}><I.plus size={14} />{" "}{tx("Voqea qo‘shish")}</button></div>}
    </div>
  );
}

function PlayersTable({ ex, flags, editable, upd, onRederive }: { ex: Extracted; flags: Map<string, Issue>; editable: boolean; upd: Upd; onRederive: () => void }) {
  const set = (i: number, patch: Partial<ProtoPlayer>) => upd((x) => Object.assign(x.players[i], patch));
  const side = (s: "home" | "away") => (
    <div className="card">
      <div className="card-head"><h3>{s === "home" ? ex.home.name : ex.away.name}</h3><span className="muted small">{tx("asosiy:")}{" "}{ex.players.filter((p) => p.side === s && p.starter).length}</span></div>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>№</th><th>{tx("F.I.Sh.")}</th><th>{tx("Amp.")}</th><th title={tx("Asosiy")}>{tx("Asos.")}</th><th title={tx("Sardor")}>C</th><th title={tx("Gol")}>G</th><th title={tx("Sariq")}>S</th><th title={tx("Qizil")}>Q</th><th title={tx("Almashtirish")}>A</th></tr></thead>
        <tbody>
          {ex.players.map((p, i) => p.side !== s ? null : (
            <tr key={i} className={flags.get(`players[${i}]`) ? `flag-${flags.get(`players[${i}]`)!.severity}` : ""}>
              <td className="tnum b">{p.number ?? "—"}</td>
              <td>{editable ? <input className="input input-sm" value={p.name} onChange={(e) => set(i, { name: e.target.value })} /> : p.name}</td>
              <td className="muted small">{p.position}</td>
              <td><input type="checkbox" disabled={!editable} checked={p.starter} onChange={(e) => set(i, { starter: e.target.checked })} /></td>
              <td><input type="checkbox" disabled={!editable} checked={p.captain} onChange={(e) => set(i, { captain: e.target.checked })} /></td>
              {(["g", "s", "q", "a"] as const).map((k) => (
                <td key={k} style={{ width: 64 }}>{editable ? <input className="input input-sm" style={{ width: 56 }} value={p[k] || ""} onChange={(e) => set(i, { [k]: e.target.value })} /> : p[k] || ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
  return (
    <div className="stack">
      {editable && <div className="alert info"><I.alert size={16} /><div className="grow">{tx("G/S/Q/A ustunlaridagi daqiqalarni tuzatgandan so‘ng voqealar ro‘yxatini tarkibdan qayta tuzish mumkin (qo‘lda kiritilgan voqea o‘zgarishlari almashtiriladi).")}</div><button className="btn btn-sm" onClick={onRederive}>{tx("Voqealarni qayta tuzish")}</button></div>}
      {side("home")}
      {side("away")}
    </div>
  );
}

function OfficialsTable({ ex, editable, upd }: { ex: Extracted; editable: boolean; upd: Upd }) {
  return (
    <div className="grid g2" data-split>
      <div className="card">
        <div className="card-head"><h3>{tx("Hakamlar va komissar")}</h3></div>
        <table className="table"><tbody>
          {ex.officials.map((o, i) => (
            <tr key={i}><td className="muted small" style={{ width: 160 }}>{o.role}</td><td>{editable ? <input className="input input-sm" value={o.name} onChange={(e) => upd((x) => (x.officials[i].name = e.target.value))} /> : o.name}</td></tr>
          ))}
        </tbody></table>
      </div>
      <div className="card">
        <div className="card-head"><h3>{tx("Jamoa rasmiylari")}</h3></div>
        <table className="table"><tbody>
          {ex.team_officials.map((o, i) => (
            <tr key={i}><td className="muted small" style={{ width: 90 }}>{o.side === "home" ? ex.home.name : ex.away.name}</td><td className="muted small">{o.role}</td><td>{editable ? <input className="input input-sm" value={o.name} onChange={(e) => upd((x) => (x.team_officials[i].name = e.target.value))} /> : o.name}</td></tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}

function HeaderForm({ ex, editable, upd }: { ex: Extracted; editable: boolean; upd: Upd }) {
  const num = (v: string) => (v === "" ? null : Number(v));
  const txt = (label: string, get: (x: Extracted) => string | undefined, set: (x: Extracted, v: string) => void) => (
    <div className="field"><label>{label}</label><input className="input" disabled={!editable} value={get(ex) || ""} onChange={(e) => upd((x) => set(x, e.target.value))} /></div>
  );
  const n = (label: string, get: (x: Extracted) => number | null | undefined, set: (x: Extracted, v: number | null) => void) => (
    <div className="field"><label>{label}</label><input className="input" type="number" disabled={!editable} value={get(ex) ?? ""} onChange={(e) => upd((x) => set(x, num(e.target.value)))} /></div>
  );
  return (
    <div className="card card-pad stack">
      <div className="form-grid">
        {txt(tx("Turnir"), (x) => x.tournament, (x, v) => (x.tournament = v))}
        {txt(tx("Bosqich"), (x) => x.stage, (x, v) => (x.stage = v))}
        {txt(tx("Sana (KK.OO.YYYY)"), (x) => x.date, (x, v) => (x.date = v))}
        {txt(tx("Vaqt"), (x) => x.time, (x, v) => (x.time = v))}
        {txt(tx("Stadion"), (x) => x.venue, (x, v) => (x.venue = v))}
        {n(tx("Tomoshabinlar"), (x) => x.attendance, (x, v) => (x.attendance = v))}
        {n(tx("Qo‘shilgan vaqt, 1-taym"), (x) => x.added_time_1h, (x, v) => (x.added_time_1h = v))}
        {n(tx("Qo‘shilgan vaqt, 2-taym"), (x) => x.added_time_2h, (x, v) => (x.added_time_2h = v))}
      </div>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>{tx("Jamoa")}</th><th>{tx("Nomi")}</th><th>{tx("1-taym")}</th><th>{tx("2-taym")}</th><th>{tx("Qo‘sh. vaqt")}</th><th>{tx("Penalti")}</th><th>{tx("Jami")}</th></tr></thead>
        <tbody>
          {(["home", "away"] as const).map((s) => (
            <tr key={s}>
              <td className="muted">{s === "home" ? tx("Uy egasi") : tx("Mehmon")}</td>
              <td><input className="input input-sm" disabled={!editable} value={ex[s].name} onChange={(e) => upd((x) => (x[s].name = e.target.value))} /></td>
              {(["half1", "half2", "extra", "penalty", "total"] as const).map((k) => (
                <td key={k}><input className="input input-sm" style={{ width: 64 }} type="number" disabled={!editable} value={ex[s][k] ?? ""} onChange={(e) => upd((x) => (x[s][k] = num(e.target.value)))} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}

function ApplyModal({ protocol, ex, matchId, hasErrors, onClose, onApplied }: { protocol: Protocol; ex: Extracted; matchId: number; hasErrors: boolean; onClose: () => void; onApplied: (mid: number) => void }) {
  const { data } = useLoad(() => api.get<{ match: Match }>(`/admin/matches/${matchId}`), [matchId]);
  const m = data?.match;
  const guessSwap = !!m && !!m.home && !!m.away && norm(m.home.name) === norm(ex.away.name) && norm(m.away.name) === norm(ex.home.name);
  const [opts, setOpts] = useState({ swap_sides: false, create_missing_players: true, publish_pdf: protocol.publish_pdf ?? true, force: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { if (guessSwap) setOpts((o) => ({ ...o, swap_sides: true })); }, [guessSwap]);
  async function go() {
    setBusy(true);
    setErr("");
    try {
      const r = await api.post<{ match_id: number }>(`/admin/protocols/${protocol.id}/apply`, { match_id: matchId, ...opts });
      onApplied(r.match_id);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "blocking_issues" ? tx("Protokolda xatolar bor. Tuzating yoki «Xatolarga qaramay qo‘llash» ni belgilang.") : e instanceof Error ? e.message : tx("Xato"));
    } finally {
      setBusy(false);
    }
  }
  const box = (k: keyof typeof opts, label: string, hint?: string) => (
    <label className="check" style={{ alignItems: "flex-start" }}><input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /><span>{label}{hint && <div className="muted small">{hint}</div>}</span></label>
  );
  return (
    <Modal title={tx("Protokolni qo‘llash")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{tx("Bekor qilish")}</button><button className="btn btn-primary" onClick={go} disabled={busy || !m}>{busy ? tx("Qo‘llanmoqda…") : tx("Qo‘llash")}</button></>}>
      <div className="stack">
        {m && <div className="card card-pad"><MatchVs m={m} /><div className="muted small" style={{ marginTop: 6 }}>{fmtShort(m.kickoff_at)} · {m.venue}</div></div>}
        <div className="small sec">{tx("Quyidagilar yangilanadi: hisob (taymlar, qo‘shimcha vaqt, penaltilar), voqealar, tarkiblar, hakamlar va jamoa rasmiylari, tomoshabinlar. Jadval va statistika avtomatik qayta hisoblanadi.")}</div>
        {box("swap_sides", tx("Jamoalar o‘rnini almashtirish"), guessSwap ? tx("Protokoldagi uy egasi matchda mehmon sifatida ko‘rsatilgan — belgilandi.") : tx("Protokolda uy/mehmon matchdagidan teskari bo‘lsa"))}
        {box("create_missing_players", tx("Topilmagan o‘yinchilarni jamoaga qo‘shish"))}
        {box("publish_pdf", tx("PDF protokolni match sahifasida e’lon qilish"))}
        {hasErrors && box("force", tx("Xatolarga qaramay qo‘llash"))}
        {err && <div className="alert danger">{err}</div>}
      </div>
    </Modal>
  );
}
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
