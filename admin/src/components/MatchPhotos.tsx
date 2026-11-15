import { useEffect, useRef, useState } from "react";
import { api, uploadWithProgress } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { I } from "./Icons";
import { ErrorBox, Loading, useConfirm, useToast } from "./ui";

export type MatchPhoto = {
  id: number; match_id: number; url: string; thumb_url: string; width: number; height: number;
  bytes: number; original_bytes: number; caption: string; ord: number;
};

type Job = {
  key: string; name: string; size: number; share: number;
  stage: "queued" | "uploading" | "converting" | "done" | "error";
  bytes?: number; error?: string;
};

const PARALLEL = 3;
const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif";

export function fmtBytes(n: number) {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * Photo report of a match: drop many photos at once, the server turns each
 * into WebP (large + thumbnail). Order is set by dragging; the first photo is
 * the cover.
 */
export function MatchPhotos({ matchId }: { matchId: number }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoad(() => api.get<{ items: MatchPhoto[]; photographer: string }>(`/admin/matches/${matchId}/photos`), [matchId]);
  const [photos, setPhotos] = useState<MatchPhoto[]>([]);
  const [photographer, setPhotographer] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [over, setOver] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef<{ job: Job; file: File }[]>([]);
  const running = useRef(0);

  useEffect(() => {
    if (!data) return;
    setPhotos(data.items);
    setPhotographer(data.photographer);
  }, [data]);

  const patchJob = (key: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));

  function pump() {
    while (running.current < PARALLEL && queue.current.length) {
      const { job, file } = queue.current.shift()!;
      running.current++;
      patchJob(job.key, { stage: "uploading" });
      uploadWithProgress<MatchPhoto>(`/admin/matches/${matchId}/photos`, file,
        (share) => patchJob(job.key, { share }),
        () => patchJob(job.key, { stage: "converting", share: 1 }))
        .then((p) => {
          patchJob(job.key, { stage: "done", bytes: p.bytes });
          setPhotos((ps) => [...ps, p].sort((a, b) => a.ord - b.ord || a.id - b.id));
        })
        .catch((e) => patchJob(job.key, { stage: "error", error: e instanceof Error ? e.message : "Xato" }))
        .finally(() => {
          running.current--;
          pump();
        });
    }
  }

  function add(files: FileList | File[] | null) {
    if (!files) return;
    const list = [...files];
    if (!list.length) return;
    const fresh = list.map((file) => ({
      job: { key: crypto.randomUUID(), name: file.name, size: file.size, share: 0, stage: "queued" as const },
      file,
    }));
    setJobs((js) => [...js.filter((j) => j.stage !== "done"), ...fresh.map((f) => f.job)]);
    queue.current.push(...fresh);
    pump();
  }

  async function savePhotographer() {
    if (photographer.trim() === (data?.photographer || "")) return;
    try {
      await api.patch(`/admin/matches/${matchId}`, { photographer: photographer.trim() });
      toast("Fotograf saqlandi");
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }

  async function saveOrder(next: MatchPhoto[]) {
    setPhotos(next);
    try {
      await api.put(`/admin/matches/${matchId}/photos/order`, next.map((p) => p.id));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Tartib saqlanmadi", "error");
      reload();
    }
  }

  async function saveCaption(p: MatchPhoto, caption: string) {
    if (caption.trim() === p.caption) return;
    try {
      const r = await api.patch<MatchPhoto>(`/admin/match-photos/${p.id}`, { caption });
      setPhotos((ps) => ps.map((x) => (x.id === p.id ? r : x)));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }

  async function remove(p: MatchPhoto) {
    if (!(await confirm({ title: "Fotoni o‘chirish", text: "Foto saytdan ham o‘chadi.", ok: "O‘chirish", danger: true }))) return;
    try {
      await api.del(`/admin/match-photos/${p.id}`);
      setPhotos((ps) => ps.filter((x) => x.id !== p.id));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }

  async function removeAll() {
    if (!(await confirm({ title: "Barcha fotolarni o‘chirish", text: `${photos.length} ta foto saytdan ham o‘chadi. Buni qaytarib bo‘lmaydi.`, ok: "Hammasini o‘chirish", danger: true }))) return;
    try {
      await api.del(`/admin/matches/${matchId}/photos`);
      setPhotos([]);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }

  function dragOver(target: number) {
    if (drag === null || drag === target) return;
    setPhotos((ps) => {
      const from = ps.findIndex((p) => p.id === drag);
      const to = ps.findIndex((p) => p.id === target);
      if (from < 0 || to < 0) return ps;
      const next = [...ps];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  }

  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading && !data) return <Loading />;
  const active = jobs.filter((j) => j.stage !== "done" && j.stage !== "error").length;

  return (
    <section className="card">
      <div className="card-head row" style={{ justifyContent: "space-between" }}>
        <h3>Foto hisobot</h3>
        <span className="small muted">{photos.length} ta foto</span>
      </div>
      <div className="card-pad stack" style={{ gap: 16 }}>
        <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
        <div
          className={`dropzone${over ? " over" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setOver(false); add(e.dataTransfer.files); } }}
        >
          <I.upload size={24} />
          <b>Fotolarni shu yerga tashlang yoki tanlang</b>
          <span className="small muted">JPG, PNG, HEIC yoki WebP · bir vaqtda 100 tagacha · avtomatik WebP ga o‘tkaziladi</span>
        </div>

        <label className="field">
          <span className="label">Fotograf</span>
          <input className="input" value={photographer} maxLength={120} placeholder="Ism Familiya" onChange={(e) => setPhotographer(e.target.value)} onBlur={savePhotographer} />
          <span className="hint">Saytda «Foto: …» deb ko‘rsatiladi</span>
        </label>

        {jobs.length > 0 && (
          <div className="stack" style={{ gap: 8 }}>
            {jobs.map((j) => (
              <div key={j.key} className="upload-row">
                <span className="ellipsis small" title={j.name}>{j.name}</span>
                <div className="progress"><i style={{ width: `${Math.round((j.stage === "done" ? 1 : j.share) * 100)}%`, opacity: j.stage === "converting" ? 0.5 : 1 }} /></div>
                <span className={`small ${j.stage === "error" ? "danger-text" : "muted"}`}>
                  {j.stage === "queued" && "navbatda"}
                  {j.stage === "uploading" && `${Math.round(j.share * 100)}% · yuklanmoqda`}
                  {j.stage === "converting" && "WebP ga o‘tkazilmoqda…"}
                  {j.stage === "done" && `Tayyor · ${fmtBytes(j.size)} → ${fmtBytes(j.bytes || 0)} WebP`}
                  {j.stage === "error" && j.error}
                </span>
              </div>
            ))}
            {active === 0 && <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setJobs([])}>Ro‘yxatni tozalash</button>}
          </div>
        )}

        {photos.length > 0 && (
          <>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="small muted">Tartibni sudrab o‘zgartiring. Birinchi foto — muqova.</span>
              <button type="button" className="btn btn-ghost btn-sm danger-text" onClick={removeAll}>Hammasini o‘chirish</button>
            </div>
            <div className="photo-grid">
              {photos.map((p, i) => (
                <div
                  key={p.id}
                  className={`photo-cell${drag === p.id ? " dragging" : ""}`}
                  draggable
                  onDragStart={(e) => { setDrag(p.id); e.dataTransfer.effectAllowed = "move"; }}
                  onDragOver={(e) => { if (drag !== null) { e.preventDefault(); dragOver(p.id); } }}
                  onDragEnd={() => { if (drag !== null) saveOrder(photos); setDrag(null); }}
                >
                  <a className="photo-tile" href={p.url} target="_blank" rel="noreferrer" draggable={false}>
                    <img src={p.thumb_url} alt={p.caption} loading="lazy" draggable={false} />
                    {i === 0 && <span className="cover-badge">MUQOVA</span>}
                  </a>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="grip" aria-hidden>⋮⋮</span>
                    <input className="input input-sm grow" defaultValue={p.caption} placeholder="Izoh qo‘shish" maxLength={300} onBlur={(e) => saveCaption(p, e.target.value)} />
                    {i > 0 && <button type="button" className="btn btn-ghost btn-sm btn-icon" title="Muqova qilish" onClick={() => saveOrder([p, ...photos.filter((x) => x.id !== p.id)])}><I.image size={15} /></button>}
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" title="O‘chirish" onClick={() => remove(p)}><I.trash size={15} /></button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
