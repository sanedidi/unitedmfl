import { useMemo, useState } from "react";
import { I } from "@/components/Icons";
import { Drawer, Modal, useConfirm } from "@/components/ui";
import { SITE_URL } from "@/components/Layout";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import { blockLabel, fmtDur, shortLocal, tashkentMs, toLocal, type Block, type Layout, type MatchTime } from "@/lib/layout";
import { BI, Seg, type Device } from "./shared";

import { tx } from "@/lib/i18n";
export type HpState = {
  draft: { config: Layout; base_version: number | null; updated_at: string; updated_by: string; exists: boolean };
  dirty: boolean;
  published: { version: number; publish_at: string; by: string } | null;
  published_config: Layout;
  scheduled: { version: number; publish_at: string; summary: string }[];
};

type Version = { version: number; summary: string; changes: string[]; created_at: string; publish_at: string; by: string; live: boolean; scheduled: boolean };

// ---------------- history ----------------

export function HistoryDrawer({ onClose, onState, dirty }: { onClose: () => void; onState: (s: HpState) => void; dirty: boolean }) {
  const { data, error, loading, reload } = useLoad(() => api.get<Version[]>("/admin/homepage/versions"), []);
  const confirm = useConfirm();
  const [busy, setBusy] = useState(0);
  const restore = async (v: Version) => {
    if (!(await confirm({ title: tx("v{0} ni tiklash", v.version), text: tx("Qoralama v{0} holatiga qaytadi{1}. Saytdagi sahifa «Nashr qilish» bosilmaguncha o‘zgarmaydi.", v.version, dirty ? " — nashr qilinmagan o‘zgarishlar yo‘qoladi" : ""), ok: tx("Tiklash") }))) return;
    setBusy(v.version);
    try {
      onState(await api.post<HpState>(`/admin/homepage/versions/${v.version}/restore`));
      onClose();
    } finally {
      setBusy(0);
    }
  };
  const cancel = async (v: Version) => {
    if (!(await confirm({ title: tx("Rejalashtirilgan nashrni bekor qilish"), text: tx("v{0} {1} da saytga chiqmaydi.", v.version, fmtDateTime(v.publish_at)), ok: tx("Bekor qilish"), danger: true }))) return;
    await api.del(`/admin/homepage/versions/${v.version}`);
    reload();
  };
  const discard = async () => {
    if (!(await confirm({ title: tx("Qoralamani bekor qilish"), text: tx("Barcha nashr qilinmagan o‘zgarishlar o‘chadi, konstruktor saytdagi holatga qaytadi."), ok: tx("Bekor qilish"), danger: true }))) return;
    onState(await api.del<HpState>("/admin/homepage/draft"));
    onClose();
  };
  return (
    <Drawer title={tx("Tarix va versiyalar")} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>{tx("Qoralama har bir o‘zgarishdan keyin avtomatik saqlanadi. Har bir nashr — alohida versiya; tiklash yangi qoralama yaratadi.")}</p>
      {dirty && (
        <div className="hb-ver current">
          <i className="draft" />
          <div className="grow"><b>{tx("Hozir · qoralama")}</b><small>{tx("Nashr qilinmagan o‘zgarishlar bor")}</small></div>
          <button className="btn btn-sm btn-danger" onClick={discard}>{tx("Bekor qilish")}</button>
        </div>
      )}
      {error ? <p className="alert danger">{tx("Yuklab bo‘lmadi")}</p> : loading ? <p className="muted">{tx("Yuklanmoqda…")}</p> : !data?.length ? <p className="muted">{tx("Hali nashr qilinmagan — saytda standart tartib.")}</p> : data.map((v) => (
        <div key={v.version} className={`hb-ver${v.live ? " live" : ""}`}>
          <i className={v.live ? "live" : v.scheduled ? "draft" : ""} />
          <div className="grow">
            <b>v{v.version}{v.live && tx(" · saytda")}{v.scheduled && tx(" · rejalashtirilgan")}</b>
            <small>{v.scheduled ? tx("{0} da chiqadi", fmtDateTime(v.publish_at)) : fmtDateTime(v.publish_at)}{v.summary ? ` · ${v.summary}` : ""}</small>
            {v.changes?.length > 0 && <small className="muted">{v.changes.slice(0, 3).join(" · ")}{v.changes.length > 3 ? ` +${v.changes.length - 3}` : ""}</small>}
            <small className="muted">{v.by || "—"}</small>
          </div>
          {v.scheduled ? <button className="btn btn-sm" onClick={() => cancel(v)}>{tx("Bekor qilish")}</button>
            : <button className="btn btn-sm" disabled={busy === v.version} onClick={() => restore(v)}><I.refresh size={14} />{" "}{tx("Tiklash")}</button>}
        </div>
      ))}
    </Drawer>
  );
}

// ---------------- publish ----------------

export function PublishModal({ changes, onClose, onPublish, onPreview, busy, nextVersion }: {
  changes: string[]; onClose: () => void; onPublish: (summary: string, at: string | null) => void; onPreview: () => void; busy: boolean; nextVersion: number;
}) {
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState(() => toLocal(Date.now() + 3600_000));
  const [summary, setSummary] = useState("");
  const atMs = tashkentMs(at);
  const bad = when === "later" && !(atMs > Date.now());
  return (
    <Modal title={tx("O‘zgarishlarni nashr qilish")} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{tx("Bekor qilish")}</button>
      <button className="btn" onClick={onPreview}><I.eye size={16} />{" "}{tx("Avval ko‘rish")}</button>
      <button className="btn btn-primary" disabled={busy || bad} onClick={() => onPublish(summary.trim(), when === "later" ? new Date(atMs).toISOString() : null)}>{busy ? tx("Nashr qilinmoqda…") : when === "later" ? tx("Rejalashtirish") : tx("Nashr qilish")}</button>
    </>}>
      <p className="sec" style={{ marginTop: 0 }}>{tx("Bosh sahifa v{0} sifatida saytga chiqadi. Avvalgi versiya tarixda qoladi va bir bosishda tiklanadi.", nextVersion)}</p>
      <div className="hb-changes">
        {changes.length ? changes.map((c, i) => <div key={i}><I.check size={14} /> {c}</div>) : <div className="muted">{tx("O‘zgarishlar yo‘q")}</div>}
      </div>
      <div className="field" style={{ marginTop: 16 }}>
        <label>{tx("Izoh (ixtiyoriy)")}</label>
        <input className="input" value={summary} maxLength={300} placeholder={tx("Masalan: Yarim final banneri")} onChange={(e) => setSummary(e.target.value)} />
      </div>
      <div className="field" style={{ marginTop: 16 }}>
        <label>{tx("Qachon")}</label>
        <Seg full value={when} onChange={setWhen} options={[{ key: "now", label: tx("Hozir") }, { key: "later", label: tx("Rejalashtirish…") }]} />
        {when === "later" && (
          <>
            <input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} style={{ marginTop: 8 }} aria-invalid={bad} />
            <span className="hint">{tx("Toshkent vaqti.")}{" "}{bad ? tx("Kelajakdagi vaqtni tanlang.") : tx("Sayt {0}dan keyin yangilanadi.", fmtDur(atMs - Date.now()))}</span>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------- preview ----------------

const WIDTH: Record<Device, number> = { desktop: 1440, tablet: 768, mobile: 390 };

export function PreviewModal({ token, at, onClose, device: initial }: { token: string; at: number | null; onClose: () => void; device: Device }) {
  const [device, setDevice] = useState<Device>(initial);
  const url = `${SITE_URL}/preview?token=${encodeURIComponent(token)}${at ? `&at=${encodeURIComponent(toLocal(at))}` : ""}`;
  const w = WIDTH[device];
  return (
    <div className="overlay hb-preview" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="hb-preview-box" role="dialog" aria-modal="true" aria-label={tx("Oldindan ko‘rish")}>
        <div className="hb-preview-bar">
          <b>{tx("Oldindan ko‘rish")}</b>
          {at && <span className="hb-tt on small"><BI.clock size={14} /> {shortLocal(toLocal(at))}{" "}{tx("holatida")}</span>}
          <span className="grow" />
          <Seg value={device} onChange={setDevice} options={[{ key: "desktop", label: <><BI.monitor size={14} /> 1440</> }, { key: "tablet", label: <><BI.tablet size={14} /> 768</> }, { key: "mobile", label: <><BI.phone size={14} /> 390</> }]} />
          <a className="btn btn-sm" href={url} target="_blank" rel="noopener noreferrer"><I.globe size={14} />{" "}{tx("Yangi oynada")}</a>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label={tx("Yopish")}><I.x /></button>
        </div>
        <div className="hb-preview-stage">
          <div className="hb-preview-frame" style={{ ["--w" as string]: `${w}px` }}>
            <iframe key={device} title={tx("Bosh sahifa qoralamasi")} src={url} style={{ width: w }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- timeline ----------------

type Bar = { from: number; to: number };
const DAY = 86400_000;

function bars(b: Block, from: number, to: number, matches: MatchTime[]): Bar[] {
  const s = b.schedule;
  if (!s || s.mode === "always") return [];
  if (s.mode === "range") return [{ from: s.start ? tashkentMs(s.start) : from, to: s.end ? tashkentMs(s.end) : to }];
  if (s.mode === "weekly") {
    const out: Bar[] = [];
    const [fh, fm] = (s.from || "00:00").split(":").map(Number);
    const [th, tm] = (s.to || "00:00").split(":").map(Number);
    // walk Tashkent days
    const start = Math.floor((from + 5 * 3600_000) / DAY) * DAY - 5 * 3600_000;
    for (let d = start - DAY; d < to; d += DAY) {
      const dow = (new Date(d + 5 * 3600_000).getUTCDay() + 6) % 7;
      if (!(s.days || []).includes(dow)) continue;
      const a = d + (fh * 60 + fm) * 60_000;
      let z = d + (th * 60 + tm) * 60_000;
      if (z <= a) z += DAY;
      out.push({ from: a, to: z });
    }
    return out;
  }
  const before = (s.before ?? 60) * 60_000, after = (s.after ?? 120) * 60_000;
  return matches.filter((m) => m.status !== "cancelled" && m.status !== "postponed").map((m) => {
    const k = Date.parse(m.kickoff_at);
    return { from: k - before, to: k + 100 * 60_000 + after };
  });
}

export function TimelinePanel({ layout, matches, realNow, at, onPick, onAt, onClose }: {
  layout: Layout; matches: MatchTime[]; realNow: number; at: number | null; onPick: (id: string) => void; onAt: (ms: number | null) => void; onClose: () => void;
}) {
  const [range, setRange] = useState<7 | 30 | 90>(30);
  const from = realNow - 2 * DAY, to = from + range * DAY;
  const items = useMemo(() => layout.rows.flatMap((r) => r.blocks).filter((b) => b.schedule && b.schedule.mode !== "always"), [layout]);
  const x = (t: number) => `${Math.max(0, Math.min(100, ((t - from) / (to - from)) * 100))}%`;
  const ticks: number[] = [];
  const step = range === 7 ? 1 : range === 30 ? 2 : 7;
  const day0 = Math.ceil((from + 5 * 3600_000) / DAY) * DAY - 5 * 3600_000;
  for (let t = day0; t < to; t += step * DAY) ticks.push(t);
  const pick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = from + ((e.clientX - r.left) / r.width) * (to - from);
    onAt(Math.round(t / 600_000) * 600_000);
  };
  return (
    <div className="hb-timeline">
      <div className="hb-tl-head">
        <BI.clock size={16} /><b>{tx("Vaqt jadvali")}</b><span className="muted small">{items.length ? tx("{0} ta blok vaqtga bog‘langan", items.length) : tx("Vaqtga bog‘langan bloklar yo‘q — blokning «Vaqt» bo‘limida sozlang")}</span>
        <span className="grow" />
        <Seg value={range} onChange={setRange} options={[{ key: 7, label: tx("Hafta") }, { key: 30, label: tx("Oy") }, { key: 90, label: tx("Mavsum") }]} />
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label={tx("Yopish")}><I.x /></button>
      </div>
      <div className="hb-tl-grid">
        <div className="hb-tl-axis">
          <span />
          <div className="hb-tl-track" onClick={pick} title={tx("Bosing — sahifani shu vaqtda ko‘rish")}>
            {ticks.map((t) => <span key={t} className="tick" style={{ left: x(t) }}>{shortLocal(toLocal(t)).split(" ")[0]}</span>)}
          </div>
        </div>
        {items.map((b) => (
          <div key={b.id} className="hb-tl-row">
            <button className="hb-tl-name" onClick={() => onPick(b.id)}><b>{blockLabel(b)}</b><small>{b.schedule!.mode === "range" ? tx("Muddat") : b.schedule!.mode === "weekly" ? tx("Takroriy") : tx("Matchga bog‘liq")}{b.alt ? tx(" · o‘rniga {0}", blockLabel(b.alt)) : ""}</small></button>
            <div className="hb-tl-track" onClick={pick}>
              {bars(b, from, to, matches).filter((z) => z.to > from && z.from < to).map((z, i) => (
                <i key={i} className={`bar m-${b.schedule!.mode}`} style={{ left: x(z.from), width: `calc(${x(z.to)} - ${x(z.from)})` }} title={`${shortLocal(toLocal(z.from))} — ${shortLocal(toLocal(z.to))}`} />
              ))}
            </div>
          </div>
        ))}
        <div className="hb-tl-lines">
          <span />
          <div>
            <i className="now" style={{ left: x(realNow) }}><em>{tx("Hozir")}</em></i>
            {at && <i className="at" style={{ left: x(at) }}><em>{shortLocal(toLocal(at))}</em></i>}
          </div>
        </div>
      </div>
    </div>
  );
}
