import { useEffect, useMemo, useState } from "react";
import { Link, Route, Routes, useNavigate } from "react-router";
import { api, type Page } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { invalidateRefs, useRefs } from "@/lib/refs";
import type { Group, Team } from "@/lib/types";
import { CrudEditPage, type CardCtx, type FieldSpec } from "@/components/Crud";
import { PageHead } from "@/components/Layout";
import { Badge, Crest, Empty, ErrorBox, Field, Loading, Modal, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

const byOrd = (a: Team, b: Team) => (a.group_ord || 99) - (b.group_ord || 99) || a.name.localeCompare(b.name);
export const groupTitle = (g: Pick<Group, "name" | "code">) => (g.name && g.name !== `Guruh ${g.code}` ? `${g.name} · ${g.code}` : `Guruh ${g.code}`);

function StatusBadge({ g }: { g: Group }) {
  return g.confirmed ? <Badge tone="ok">Tasdiqlangan</Badge> : <Badge tone="warn">Taxminiy</Badge>;
}

/* ---------- list ---------- */
function GroupsList() {
  const navigate = useNavigate();
  const { seasons } = useRefs();
  const groups = useLoad(() => api.get<Page<Group>>("/admin/groups?limit=200"), []);
  const teams = useLoad(() => api.get<Page<Team>>("/admin/teams?limit=200"), []);
  const create = () => navigate("/groups/new");
  const error = groups.error || teams.error;
  const loading = (groups.loading && !groups.data) || (teams.loading && !teams.data);
  const members = useMemo(() => {
    const m = new Map<number, Team[]>();
    for (const t of teams.data?.items || []) if (t.group_id) m.set(t.group_id, [...(m.get(t.group_id) || []), t]);
    for (const l of m.values()) l.sort(byOrd);
    return m;
  }, [teams.data]);
  const ungrouped = (teams.data?.items || []).filter((t) => !t.group_id && t.is_active !== false);
  const seasonName = (id: number | null) => seasons.find((s) => s.id === id)?.name;

  return (
    <>
      <PageHead title="Guruhlar" sub="Turnir jadvali guruhlar bo‘yicha hisoblanadi. Jamoani guruhga shu yerda yoki jamoa sahifasida qo‘shing."
        actions={<button className="btn btn-primary" onClick={create}><I.plus size={16} /> Yangi guruh</button>} />
      {error ? <ErrorBox error={error} retry={() => { groups.reload(); teams.reload(); }} /> : loading ? <Loading /> : !groups.data?.items.length ? (
        <div className="card"><Empty title="Hali guruh yo‘q" text="Guruh yarating va unga jamoalarni qo‘shing — turnir jadvali avtomatik bo‘linadi." action={<button className="btn btn-primary" onClick={create}><I.plus size={16} /> Yangi guruh</button>} /></div>
      ) : (
        <div className="group-grid">
          {groups.data.items.map((g) => {
            const list = members.get(g.id) || [];
            return (
              <Link key={g.id} to={`/groups/${g.id}`} className="card group-card">
                <div className="group-card-head">
                  <span className="group-code">{g.code}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <b className="ellipsis" style={{ display: "block" }}>{g.name}</b>
                    <span className="muted small">{seasonName(g.season_id) || "Mavsumsiz"} · {list.length} jamoa</span>
                  </div>
                  <StatusBadge g={g} />
                </div>
                {list.length ? (
                  <ol className="group-teams">
                    {list.map((t, i) => <li key={t.id}><span className="muted tnum">{i + 1}</span><Crest team={t} size={24} /><span className="ellipsis">{t.name}</span></li>)}
                  </ol>
                ) : <div className="muted small group-empty">Jamoa qo‘shilmagan</div>}
              </Link>
            );
          })}
          <button type="button" className="group-card group-new" onClick={create}><I.plus size={20} /><span>Yangi guruh</span></button>
        </div>
      )}
      {!!ungrouped.length && groups.data?.items.length ? (
        <div className="note-box" style={{ marginTop: 24 }}>
          <b>Guruhsiz jamoalar: {ungrouped.length}</b>
          <div className="muted small" style={{ marginTop: 4 }}>{ungrouped.map((t) => t.name).join(", ")}</div>
        </div>
      ) : null}
    </>
  );
}

/* ---------- edit page: teams card ---------- */
function GroupTeamsCard({ c }: { c: CardCtx }) {
  const toast = useToast();
  const gid = c.item ? Number(c.item.id) : null;
  const teams = useLoad(() => api.get<Page<Team>>("/admin/teams?limit=200"), [c.version]);
  const groups = useLoad(() => api.get<Page<Group>>("/admin/groups?limit=200"), []);
  const [list, setList] = useState<Team[]>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (teams.data && gid) setList(teams.data.items.filter((t) => t.group_id === gid).sort(byOrd));
  }, [teams.data, gid]);

  if (!gid) {
    return (
      <div className="card">
        <div className="card-head"><h3>Jamoalar</h3></div>
        <div className="card-pad muted">Jamoalarni qo‘shish uchun avval guruhni saqlang.</div>
      </div>
    );
  }
  const others = (teams.data?.items || []).filter((t) => t.group_id !== gid).sort((a, b) => a.name.localeCompare(b.name));
  const groupCode = (id: number | null) => groups.data?.items.find((g) => g.id === id)?.code;

  async function commit(next: Team[]) {
    const prev = list;
    setList(next);
    setBusy(true);
    try {
      await api.put(`/admin/groups/${gid}/teams`, next.map((t) => t.id));
      invalidateRefs();
      teams.reload();
    } catch (e) {
      setList(prev);
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  function add() {
    const t = others.find((x) => String(x.id) === pick);
    if (!t) return;
    setPick("");
    commit([...list, t]);
    toast(t.group_id ? `${t.name} boshqa guruhdan ko‘chirildi` : `${t.name} qo‘shildi`);
  }
  const move = (i: number, d: number) => {
    const n = [...list];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    commit(n);
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Jamoalar <span className="muted small">· {list.length}</span></h3>
        {busy && <span className="muted small">Saqlanmoqda…</span>}
      </div>
      <div className="card-pad stack" style={{ gap: 16 }}>
        {teams.error ? <ErrorBox error={teams.error} retry={teams.reload} /> : !teams.data ? <Loading /> : (
          <>
            {list.length ? (
              <ol className="group-teams group-teams-edit">
                {list.map((t, i) => (
                  <li key={t.id}>
                    <span className="muted tnum">{i + 1}</span><Crest team={t} size={28} /><b className="ellipsis grow">{t.name}</b>
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Yuqoriga" disabled={busy || i === 0} onClick={() => move(i, -1)}><I.up size={16} /></button>
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Pastga" disabled={busy || i === list.length - 1} onClick={() => move(i, 1)}><I.down size={16} /></button>
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Guruhdan chiqarish" disabled={busy} onClick={() => commit(list.filter((x) => x.id !== t.id))}><I.x size={16} /></button>
                  </li>
                ))}
              </ol>
            ) : <div className="muted">Guruhda hali jamoa yo‘q.</div>}
            <div className="row" style={{ gap: 8 }}>
              <select className="select grow" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Jamoa">
                <option value="">Jamoa tanlang…</option>
                {others.map((t) => <option key={t.id} value={t.id}>{t.name}{t.group_id ? ` — hozir ${groupCode(t.group_id) || "boshqa"} guruhida` : ""}</option>)}
              </select>
              <button type="button" className="btn" disabled={!pick || busy} onClick={add}><I.plus size={16} /> Qo‘shish</button>
            </div>
            <div className="muted small">Tartib jadvalda teng ochkoda hech narsani o‘zgartirmaydi — faqat ro‘yxatlarda ko‘rsatish tartibi.</div>
          </>
        )}
      </div>
    </div>
  );
}

function GroupEdit() {
  const { seasons } = useRefs();
  const fields: FieldSpec[] = [
    { name: "name", label: "Nomi", required: true, placeholder: "Guruh A", hint: "saytda jadval sarlavhasi" },
    { name: "code", label: "Kod", required: true, placeholder: "A", hint: "1–4 belgi, mavsum ichida takrorlanmaydi" },
    { name: "season_id", label: "Mavsum", type: "select", numeric: true, nullable: true, options: seasons.map((s) => ({ value: String(s.id), label: s.name })), hint: "bo‘sh qolsa — faol mavsum" },
    { name: "ord", label: "Tartib", type: "number", nullable: true, hint: "saytdagi o‘rni (1, 2, 3…)" },
    { name: "confirmed", label: "Tarkib tasdiqlangan", type: "bool", side: true, hint: "o‘chiq bo‘lsa, saytda «taxminiy» belgisi chiqadi" },
  ];
  return (
    <CrudEditPage<Group & Record<string, any>> base="/groups" title="Guruhlar" resource="/admin/groups" singular="Guruh" fields={fields}
      columns={[]} defaults={{ confirmed: false }} onChanged={invalidateRefs} cards={(c) => <GroupTeamsCard c={c} />} />
  );
}

export function GroupsSection() {
  return (
    <Routes>
      <Route index element={<GroupsList />} />
      <Route path="new" element={<GroupEdit />} />
      <Route path=":id" element={<GroupEdit />} />
    </Routes>
  );
}

/* ---------- team form: group picker ---------- */
export function TeamGroupCard({ c }: { c: CardCtx }) {
  const toast = useToast();
  const groups = useLoad(() => api.get<Page<Group>>("/admin/groups?limit=200"), []);
  const [modal, setModal] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const value = c.values.group_id == null || c.values.group_id === "" ? "" : String(c.values.group_id);
  const current = groups.data?.items.find((g) => String(g.id) === value);

  function onSelect(v: string) {
    if (v === "__new") {
      setName(""); setCode(""); setErrs({}); setModal(true);
      return;
    }
    c.set("group_id", v === "" ? null : Number(v));
  }
  async function create() {
    setBusy(true);
    setErrs({});
    try {
      const g = await api.post<Group>("/admin/groups", { name: name.trim() || `Guruh ${code.trim().toUpperCase()}`, code });
      invalidateRefs();
      await groups.reload();
      c.set("group_id", g.id);
      setModal(false);
      toast(`«${g.name}» yaratildi — jamoani saqlashni unutmang`);
    } catch (e: any) {
      if (e?.fields) setErrs(e.fields);
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head"><h3>Guruh</h3>{current && <StatusBadge g={current} />}</div>
      <div className="card-pad stack" style={{ gap: 8 }}>
        <select className="select" value={value} onChange={(e) => onSelect(e.target.value)} aria-label="Guruh">
          <option value="">— Guruhsiz</option>
          {(groups.data?.items || []).map((g) => <option key={g.id} value={g.id}>{groupTitle(g)}</option>)}
          <option value="__new">＋ Yangi guruh yaratish…</option>
        </select>
        {current ? <Link className="small" to={`/groups/${current.id}`}>Guruhni ochish →</Link> : <span className="muted small">Jamoa turnir jadvalida guruhsiz ko‘rinadi.</span>}
      </div>
      {modal && (
        <Modal title="Yangi guruh" onClose={() => setModal(false)}
          footer={<>
            <button type="button" className="btn btn-ghost" onClick={() => setModal(false)}>Bekor qilish</button>
            <button type="button" className="btn btn-primary" disabled={busy || !code.trim()} onClick={create}>{busy ? "Yaratilmoqda…" : "Yaratish"}</button>
          </>}>
          <div className="form-grid">
            <Field label="Kod *" error={errs.code} hint="1–4 belgi, masalan A"><input className="input" value={code} maxLength={4} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus /></Field>
            <Field label="Nomi" error={errs.name} hint="bo‘sh qolsa — «Guruh A»"><input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={code ? `Guruh ${code}` : "Guruh A"} /></Field>
          </div>
          <div className="muted small" style={{ marginTop: 12 }}>Guruh faol mavsumga qo‘shiladi. Tarkibni keyin «Guruhlar» bo‘limida tasdiqlaysiz.</div>
        </Modal>
      )}
    </div>
  );
}
