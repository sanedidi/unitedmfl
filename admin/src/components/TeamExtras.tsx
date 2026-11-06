import { useRef, useState } from "react";
import { api, uploadImage, type Page } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import type { Player } from "@/lib/types";
import { I } from "./Icons";
import { Badge, useConfirm, useToast } from "./ui";

export type Staff = { id: number; team_id: number; full_name: string; role: string; photo_url: string; show_on_site: boolean; ord: number };

export const STAFF_ROLE: Record<string, string> = {
  head_coach: "Bosh murabbiy", assistant: "Murabbiy yordamchisi", gk_coach: "Darvozabonlar murabbiyi",
  fitness: "Fitnes murabbiy", doctor: "Shifokor", manager: "Jamoa menejeri", other: "Boshqa",
};

/** Team drawer extras: coaching staff (shown on the match lineup page) and bulk player photos. */
export function TeamExtras({ teamId }: { teamId: number }) {
  return (
    <div className="stack" style={{ marginTop: 24, gap: 24 }}>
      <StaffEditor teamId={teamId} />
      <PhotoBulk teamId={teamId} />
    </div>
  );
}

function StaffEditor({ teamId }: { teamId: number }) {
  const toast = useToast();
  const confirm = useConfirm();
  const list = useLoad(() => api.get<Page<Staff>>(`/admin/team-staff?team_id=${teamId}&limit=100`).then((p) => p.items), [teamId]);
  const [name, setName] = useState("");
  const [role, setRole] = useState("head_coach");
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : "Xato", "error");

  async function add() {
    if (!name.trim()) return;
    try {
      await api.post("/admin/team-staff", { team_id: teamId, full_name: name.trim(), role, show_on_site: true, ord: (list.data?.length || 0) + 1 });
      setName("");
      list.reload();
    } catch (e) { fail(e); }
  }
  async function patch(s: Staff, body: Partial<Staff>) {
    try {
      await api.patch(`/admin/team-staff/${s.id}`, body);
      list.reload();
    } catch (e) { fail(e); }
  }
  async function del(s: Staff) {
    if (!(await confirm({ title: "O‘chirish?", text: s.full_name, ok: "O‘chirish", danger: true }))) return;
    try { await api.del(`/admin/team-staff/${s.id}`); list.reload(); } catch (e) { fail(e); }
  }

  return (
    <section className="stack" style={{ gap: 10 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>Murabbiylar shtabi</h3>
        <div className="small muted">Bosh murabbiy va yordamchi tarkib muharririda tanlanadi va saytda tarkib ostida chiqadi.</div>
      </div>
      {(list.data || []).map((s) => (
        <div key={s.id} className="staff-row">
          <StaffPhoto s={s} onChange={(url) => patch(s, { photo_url: url })} />
          <div className="grow" style={{ minWidth: 0 }}>
            <input className="input input-sm" defaultValue={s.full_name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== s.full_name && patch(s, { full_name: e.target.value.trim() })} />
            <div className="row" style={{ marginTop: 6, gap: 8 }}>
              <select className="input input-sm" value={s.role} onChange={(e) => patch(s, { role: e.target.value })} style={{ width: "auto" }}>
                {Object.entries(STAFF_ROLE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={s.show_on_site} onChange={(e) => patch(s, { show_on_site: e.target.checked })} /> Saytda</label>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm btn-icon" aria-label="O‘chirish" onClick={() => del(s)}><I.trash size={16} /></button>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <input className="input input-sm grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="F.I.Sh." onKeyDown={(e) => e.key === "Enter" && add()} />
        <select className="input input-sm" value={role} onChange={(e) => setRole(e.target.value)} style={{ width: "auto" }}>
          {Object.entries(STAFF_ROLE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button className="btn btn-sm" onClick={add} disabled={!name.trim()}><I.plus size={15} /> Qo‘shish</button>
      </div>
    </section>
  );
}

function StaffPhoto({ s, onChange }: { s: Staff; onChange: (url: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <button type="button" className="staff-photo" style={s.photo_url ? { backgroundImage: `url("${s.photo_url}")` } : undefined} onClick={() => ref.current?.click()} disabled={busy} aria-label="Rasm yuklash">
      {!s.photo_url && <I.camera size={16} />}
      <input ref={ref} type="file" accept="image/*" hidden onChange={async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        setBusy(true);
        try { onChange(await uploadImage(f)); } catch (err) { toast(err instanceof Error ? err.message : "Xato", "error"); } finally { setBusy(false); e.target.value = ""; }
      }} />
    </button>
  );
}

type Match = { file: File; player: Player | null; url: string };

/** "10.jpg", "10_Karimov.png", "karimov-aziz.jpg" → player by number first, then by surname. */
export function matchPhoto(fileName: string, players: Player[]): Player | null {
  const base = fileName.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  const num = base.match(/^\s*(\d{1,3})(?!\d)/);
  if (num) {
    const p = players.find((x) => x.number === Number(num[1]));
    if (p) return p;
  }
  const words = base.split(/[^\p{L}]+/u).filter((w) => w.length > 2);
  return players.find((p) => {
    const n = p.full_name.toLowerCase().split(/\s+/);
    return words.some((w) => n.includes(w));
  }) || null;
}

function PhotoBulk({ teamId }: { teamId: number }) {
  const toast = useToast();
  const players = useLoad(() => api.get<Page<Player>>(`/admin/players?team_id=${teamId}&limit=200`).then((p) => p.items), [teamId]);
  const ref = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Match[]>([]);
  const [busy, setBusy] = useState(false);
  const list = players.data || [];
  const withPhoto = list.filter((p) => p.photo_url).length;

  function pick(files: FileList | null) {
    if (!files) return;
    setRows([...files].map((f) => ({ file: f, player: matchPhoto(f.name, list), url: URL.createObjectURL(f) })));
  }
  async function upload() {
    setBusy(true);
    let ok = 0;
    for (const r of rows) {
      if (!r.player) continue;
      try {
        const url = await uploadImage(r.file);
        await api.patch(`/admin/players/${r.player.id}`, { photo_url: url });
        ok++;
      } catch (e) {
        toast(`${r.file.name}: ${e instanceof Error ? e.message : "xato"}`, "error");
      }
    }
    setBusy(false);
    setRows([]);
    players.reload();
    if (ok) toast(`${ok} ta rasm saqlandi`);
  }

  return (
    <section className="stack" style={{ gap: 10 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>O‘yinchilar rasmlari</h3>
        <div className="small muted">Rasmga ega: {withPhoto} / {list.length}. Fayl nomi raqam yoki familiya bilan boshlansin: <code>10.jpg</code>, <code>10_Karimov.png</code>.</div>
      </div>
      <input ref={ref} type="file" accept="image/*" multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
      {rows.length === 0 ? (
        <button className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => ref.current?.click()} disabled={!list.length}><I.upload size={15} /> Rasmlarni tanlash</button>
      ) : (
        <>
          <div className="photo-match">
            {rows.map((r, i) => (
              <div key={i} className="row" style={{ gap: 10 }}>
                <span className="staff-photo" style={{ backgroundImage: `url("${r.url}")` }} />
                <span className="grow ellipsis small">{r.file.name}</span>
                <select className="input input-sm" style={{ width: 170 }} value={r.player?.id ?? ""} onChange={(e) => {
                  const p = list.find((x) => x.id === Number(e.target.value)) || null;
                  setRows((rs) => rs.map((x, j) => (j === i ? { ...x, player: p } : x)));
                }}>
                  <option value="">— o‘tkazib yuborish —</option>
                  {list.map((p) => <option key={p.id} value={p.id}>{p.number ?? "—"} · {p.full_name}</option>)}
                </select>
                {r.player ? (r.player.photo_url ? <Badge tone="warn">almashadi</Badge> : <Badge tone="ok">yangi</Badge>) : <Badge>—</Badge>}
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={() => setRows([])} disabled={busy}>Bekor</button>
            <button className="btn btn-sm btn-primary" onClick={upload} disabled={busy || !rows.some((r) => r.player)}>
              {busy ? "Yuklanmoqda…" : `Saqlash (${rows.filter((r) => r.player).length})`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
