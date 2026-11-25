import { CrudPage, CrudSection, type FieldSpec } from "@/components/Crud";
import { TeamCabinetCard } from "./TeamCabinets";
import { Badge, Crest } from "@/components/ui";
import { useRefs, invalidateRefs, activeSeason } from "@/lib/refs";
import { fmtDate, fmtDateTime, POSITIONS } from "@/lib/format";
import type { Player, Team } from "@/lib/types";
import { SITE_URL } from "@/components/Layout";
import { TeamExtras } from "@/components/TeamExtras";
import { TeamStickerCard } from "@/pages/Stickers";
import { PlayerPhotoCard, TeamKitSection } from "@/components/Kit";
import { groupTitle, TeamGroupCard } from "@/pages/Groups";
import { useMatchOptions } from "@/lib/matchOptions";
import { isUploadedVideo, VideoCoverCard, VideoSourceCard, youtubeId } from "@/components/VideoSource";


/* ---------- Teams ---------- */
export function TeamsPage() {
  const { groups } = useRefs();
  const fields: FieldSpec[] = [
    { name: "name", label: "Nomi", required: true },
    { name: "slug", label: "Slug (URL)", type: "slug", slugFrom: "name", required: true, hint: "lotin harflari, raqamlar va «-»" },
    { name: "short_name", label: "Qisqa nomi", hint: "emblemada (3 belgigacha)" },
    { name: "group_id", label: "Guruh", type: "number", nullable: true, hidden: true },
    { name: "is_active", label: "Faol", type: "bool", side: true },
    { name: "crest_url", label: "Emblema", type: "image", side: true },
    { name: "colors", label: "Ranglar", type: "colors", hint: "#E5383B, #FFFFFF" },
    { name: "leader", label: "Sardor / yetakchi" },
    { name: "instagram", label: "Instagram", type: "url" },
    { name: "telegram", label: "Telegram", type: "url" },
    { name: "kit_url", label: "Forma", hidden: true },
  ];
  return (
    <CrudSection<Team & Record<string, any>> base="/teams" cards={(c) => <TeamKitSection c={c} />} sideCards={(c) => <><TeamGroupCard c={c} />{c.item?.id ? <><TeamCabinetCard teamId={c.item.id} /><TeamStickerCard teamId={c.item.id} version={c.version} /></> : null}</>} onChanged={invalidateRefs} title="Jamoalar" resource="/admin/teams" singular="Jamoa" deleteText="Jamoa bilan birga uning barcha o‘yinchilari, media shaxslari va murabbiylari ham o‘chadi. Bu amalni qaytarib bo‘lmaydi." searchable fields={fields} defaults={{ is_active: true, group_id: null }}
      filters={[{ param: "group_id", label: "Guruh", options: groups.map((g) => ({ value: String(g.id), label: groupTitle(g) })) }]}
      columns={[
        { label: "Jamoa", render: (t) => <span className="row"><Crest team={t} /> <b>{t.name}</b></span> },
        { label: "Guruh", render: (t) => t.group_label ? <span>{t.group_label}{t.group_is_provisional && <span className="muted small"> · taxminiy</span>}</span> : <span className="muted">—</span> },
        { label: "Slug", render: (t) => <span className="muted">{t.slug}</span>, className: "hide-mobile" },
        { label: "Holat", render: (t) => t.is_active ? <Badge tone="ok">Faol</Badge> : <Badge>Arxiv</Badge> },
      ]}
      extra={(t) => <>
        <a className="btn btn-sm" style={{ marginTop: 20 }} href={`${SITE_URL}/jamoalar/${t.slug}`} target="_blank" rel="noreferrer">Saytda ko‘rish</a>
        <TeamExtras teamId={t.id} />
      </>}
    />
  );
}

/* ---------- Players ---------- */
export function PlayersPage() {
  const { teams } = useRefs();
  const teamOpts = teams.map((t) => ({ value: String(t.id), label: t.name }));
  const byId = new Map(teams.map((t) => [t.id, t]));
  const posOpts = Object.entries(POSITIONS).map(([value, label]) => ({ value, label }));
  const fields: FieldSpec[] = [
    { name: "full_name", label: "F.I.Sh.", required: true, full: true },
    { name: "team_id", label: "Jamoa", type: "select", nullable: true, numeric: true, options: teamOpts },
    { name: "number", label: "Raqam", type: "jersey", nullable: true, placeholder: "10 yoki Z10",
      requiredIf: (v) => !!byId.get(Number(v.team_id))?.kit_has_number,
      hintFor: (v) => byId.get(Number(v.team_id))?.kit_has_number ? "Jamoa formasida raqam bor — AI rasmda shu raqamni chizadi. Harf ham yozish mumkin: Z10" : "Raqam yoki harf bilan: 10, Z10 (4 ta belgigacha)" },
    { name: "position", label: "Amplua", type: "select", nullable: true, options: posOpts },
    { name: "jersey_name", label: "Futbolkada yozilishi", placeholder: "FAMILIYA" },
    { name: "kit_size", label: "Forma o‘lchami", type: "select", nullable: true, options: ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"].map((x) => ({ value: x, label: x })) },
    { name: "birth_date", label: "Tug‘ilgan sana", type: "date", nullable: true },
    { name: "workplace", label: "Ish joyi / faoliyati" },
    { name: "is_active", label: "Faol", type: "bool", side: true },
    { name: "is_media", label: "Media shaxs", type: "bool", side: true, hint: "bloger yoki boshqa media shaxs" },
    { name: "photo_url", label: "Rasm", hidden: true },
    { name: "instagram", label: "Instagram", type: "url" },
  ];
  return (
    <CrudSection<Player & Record<string, any>> base="/players" sideCards={(c) => <PlayerPhotoCard c={c} />} titleField="full_name" title="O‘yinchilar" resource="/admin/players" singular="O‘yinchi" searchable fields={fields} defaults={{ is_active: true }} reloadKey={teams.length}
      filters={[{ param: "team_id", label: "Jamoa", options: teamOpts }, { param: "position", label: "Amplua", options: posOpts }]}
      columns={[
        { label: "№", render: (p) => <b className="tnum">{p.number ?? "—"}</b> },
        { label: "O‘yinchi", render: (p) => <b>{p.full_name}</b> },
        { label: "Jamoa", render: (p) => { const t = p.team_id ? byId.get(p.team_id) : null; return t ? <span className="row"><Crest team={t} size={22} /> {t.name}</span> : <span className="muted">—</span>; } },
        { label: "Amplua", render: (p) => POSITIONS[p.position] || <span className="muted">—</span>, className: "hide-mobile" },
        { label: "Holat", render: (p) => p.is_active ? <Badge tone="ok">Faol</Badge> : <Badge>Nofaol</Badge>, className: "hide-mobile" },
      ]}
    />
  );
}

/* ---------- Seasons & stages ---------- */
const STAGE_KINDS = [
  { value: "group", label: "Guruh bosqichi" }, { value: "round_of_16", label: "1/8 final" }, { value: "quarter", label: "Chorak final" },
  { value: "semi", label: "Yarim final" }, { value: "final", label: "Final" }, { value: "other", label: "Boshqa" },
];
const STAGE_STATUS = [{ value: "scheduled", label: "Rejalashtirilgan" }, { value: "active", label: "Davom etmoqda" }, { value: "finished", label: "Yakunlangan" }];

export function SeasonsPage() {
  const { seasons } = useRefs();
  const seasonOpts = seasons.map((s) => ({ value: String(s.id), label: s.name }));
  return (
    <div className="stack" style={{ gap: 32 }}>
      <CrudPage edit="drawer" onChanged={invalidateRefs} title="Mavsumlar" resource="/admin/seasons" singular="Mavsum" defaults={{ is_active: false }}
        fields={[
          { name: "name", label: "Nomi", required: true },
          { name: "slug", label: "Slug", type: "slug", slugFrom: "name", required: true },
          { name: "teams_planned", label: "Jamoalar soni", type: "number", nullable: true },
          { name: "matches_planned", label: "Matchlar soni", type: "number", nullable: true },
          { name: "is_active", label: "Faol mavsum (saytda ko‘rsatiladi)", type: "bool", full: true },
        ]}
        columns={[
          { label: "Mavsum", render: (s) => <b>{s.name}</b> },
          { label: "Jamoalar", render: (s) => s.teams_planned ?? "—" },
          { label: "Matchlar", render: (s) => s.matches_planned ?? "—" },
          { label: "Holat", render: (s) => s.is_active ? <Badge tone="ok">Faol</Badge> : <Badge>Arxiv</Badge> },
        ]}
      />
      <CrudPage edit="drawer" onChanged={invalidateRefs} title="Bosqichlar" resource="/admin/stages" singular="Bosqich" limit={100} reloadKey={seasons.length}
        defaults={{ season_id: String(activeSeason(seasons)?.id || ""), kind: "group", status: "scheduled", ord: "1" }}
        filters={[{ param: "season_id", label: "Mavsum", options: seasonOpts }]}
        fields={[
          { name: "season_id", label: "Mavsum", type: "select", numeric: true, options: seasonOpts, required: true },
          { name: "name", label: "Nomi", required: true },
          { name: "kind", label: "Turi", type: "select", options: STAGE_KINDS },
          { name: "status", label: "Holat", type: "select", options: STAGE_STATUS },
          { name: "ord", label: "Tartib", type: "number" },
          { name: "note", label: "Izoh", type: "textarea" },
        ]}
        columns={[
          { label: "#", render: (s) => s.ord },
          { label: "Bosqich", render: (s) => <b>{s.name}</b> },
          { label: "Turi", render: (s) => STAGE_KINDS.find((k) => k.value === s.kind)?.label || s.kind },
          { label: "Holat", render: (s) => <Badge tone={s.status === "active" ? "live" : s.status === "finished" ? "" : "info"}>{STAGE_STATUS.find((k) => k.value === s.status)?.label}</Badge> },
          { label: "Izoh", render: (s) => <span className="muted small ellipsis" style={{ maxWidth: 320, display: "inline-block" }}>{s.note}</span>, className: "hide-mobile" },
        ]}
      />
    </div>
  );
}

/* ---------- News ---------- */
const NEWS_STATUS = [{ value: "draft", label: "Qoralama" }, { value: "published", label: "Nashr etilgan" }, { value: "scheduled", label: "Rejalashtirilgan" }];
export function NewsPage() {
  const matchOpts = useMatchOptions();
  return (
    <CrudSection base="/news" title="Yangiliklar" resource="/admin/news" singular="Yangilik" searchable defaults={{ status: "draft", category: "LIGA" }}
      filters={[{ param: "status", label: "Holat", options: NEWS_STATUS }]}
      fields={[
        { name: "title", label: "Sarlavha", required: true, full: true },
        { name: "slug", label: "Slug (URL)", type: "slug", slugFrom: "title", required: true, full: true },
        { name: "category", label: "Rukn", placeholder: "LIGA, ANONS, NATIJA…" },
        { name: "status", label: "Holat", type: "select", options: NEWS_STATUS, side: true },
        { name: "published_at", label: "Nashr vaqti (Toshkent)", type: "datetime", hint: "Nashr/rejalashtirish uchun majburiy", side: true },
        { name: "on_home", label: "Bosh sahifada ko‘rsatish", type: "bool", side: true },
        { name: "excerpt", label: "Qisqa matn (lid)", type: "textarea" },
        { name: "body", label: "Matn", type: "markdown" },
        { name: "cover_url", label: "Muqova", type: "image", side: true },
        { name: "tags", label: "Teglar", type: "tags", hint: "vergul bilan" },
        { name: "match_id", label: "Bog‘langan match", type: "select", numeric: true, nullable: true, placeholder: "Match bilan bog‘lanmagan", options: matchOpts },
        { name: "seo_description", label: "SEO tavsif (160 belgi)", type: "textarea" },
      ]}
      columns={[
        { label: "Sarlavha", render: (n) => <div><b>{n.title}</b><div className="muted small">{n.category}</div></div> },
        { label: "Holat", render: (n) => <Badge tone={n.status === "published" ? "ok" : n.status === "scheduled" ? "info" : ""}>{NEWS_STATUS.find((s) => s.value === n.status)?.label}</Badge> },
        { label: "Sana", render: (n) => <span className="nowrap">{n.published_at ? fmtDateTime(n.published_at) : "—"}</span>, className: "hide-mobile" },
        { label: "Ko‘rishlar", render: (n) => n.views, className: "hide-mobile" },
      ]}
      extra={(n) => n.status !== "draft" ? <a className="btn btn-sm" style={{ marginTop: 20 }} href={`${SITE_URL}/yangiliklar/${n.slug}`} target="_blank" rel="noreferrer">Saytda ko‘rish</a> : null}
    />
  );
}

/* ---------- Videos ---------- */
const VIDEO_KIND = [{ value: "highlight", label: "Sharh" }, { value: "interview", label: "Intervyu" }, { value: "announcement", label: "Anons" }, { value: "full", label: "To‘liq o‘yin" }];
export function VideosPage() {
  const matchOpts = useMatchOptions();
  return (
    <CrudSection base="/videos" title="Videolar" resource="/admin/videos" singular="Video" defaults={{ kind: "highlight", status: "draft", source: "file" }}
      filters={[{ param: "status", label: "Holat", options: [{ value: "draft", label: "Qoralama" }, { value: "published", label: "Nashr etilgan" }] }]}
      cards={(c) => <VideoSourceCard c={c} />}
      sideCardsAfter={(c) => <VideoCoverCard c={c} />}
      saveBlocked={(v) => (v.__uploading ? "Video yuklanmoqda — tugashini kuting" : undefined)}
      fields={[
        { name: "title", label: "Sarlavha", required: true, full: true },
        { name: "source", label: "Manba", hidden: true },
        { name: "url", label: "Video", hidden: true },
        { name: "kind", label: "Turi", type: "select", options: VIDEO_KIND },
        { name: "match_id", label: "Match", type: "select", numeric: true, nullable: true, placeholder: "Match bilan bog‘lanmagan", options: matchOpts },
        { name: "duration_sec", label: "Davomiyligi (soniya)", type: "number", nullable: true, hint: "Fayl yuklanganda avtomatik to‘ladi" },
        { name: "status", label: "Holat", type: "select", options: [{ value: "draft", label: "Qoralama" }, { value: "published", label: "Nashr etilgan" }], side: true },
        { name: "published_at", label: "Nashr vaqti", type: "datetime", side: true },
        { name: "thumbnail_url", label: "Muqova", hidden: true },
      ]}
      columns={[
        { label: "Video", render: (v) => <div><b>{v.title}</b><div className="muted small">{v.source === "file" || isUploadedVideo(v.url) ? "Fayl" : youtubeId(v.url) ? "YouTube" : "Havola"}</div></div> },
        { label: "Turi", render: (v) => VIDEO_KIND.find((k) => k.value === v.kind)?.label },
        { label: "Holat", render: (v) => v.status === "published" ? <Badge tone="ok">Nashr etilgan</Badge> : <Badge>Qoralama</Badge> },
        { label: "Sana", render: (v) => fmtDate(v.published_at), className: "hide-mobile" },
      ]}
    />
  );
}

/* ---------- Requests ---------- */
const REQ_STATUS = [{ value: "new", label: "Yangi" }, { value: "in_progress", label: "Jarayonda" }, { value: "closed", label: "Yopilgan" }];
const TOPIC: Record<string, string> = { partnership: "Hamkorlik", sponsorship: "Homiylik", team: "Jamoa", tickets: "Chiptalar", other: "Boshqa" };
export function RequestsPage() {
  return (
    <CrudSection base="/requests" titleField="name" title="Murojaatlar" sub="Saytdagi aloqa formasi orqali kelgan so‘rovlar" resource="/admin/requests" singular="Murojaat" searchable canCreate={false}
      filters={[{ param: "status", label: "Holat", options: REQ_STATUS }, { param: "topic", label: "Mavzu", options: Object.entries(TOPIC).map(([value, label]) => ({ value, label })) }]}
      fields={[
        { name: "status", label: "Holat", type: "select", options: REQ_STATUS, side: true },
        { name: "internal_note", label: "Ichki izoh", type: "textarea", side: true },
      ]}
      columns={[
        { label: "Sana", render: (r) => <span className="nowrap">{fmtDateTime(r.created_at)}</span> },
        { label: "Ism", render: (r) => <b>{r.name}</b> },
        { label: "Telefon", render: (r) => <a href={`tel:${r.phone.replace(/[^\d+]/g, "")}`} onClick={(e) => e.stopPropagation()}>{r.phone}</a> },
        { label: "Mavzu", render: (r) => TOPIC[r.topic] || r.topic, className: "hide-mobile" },
        { label: "Holat", render: (r) => <Badge tone={r.status === "new" ? "live" : r.status === "in_progress" ? "info" : ""}>{REQ_STATUS.find((s) => s.value === r.status)?.label}</Badge> },
      ]}
      extra={(r) => (
        <div className="stack" style={{ marginTop: 24, gap: 8 }}>
          <hr className="sep" />
          <div><span className="muted small">Ism</span><div className="b">{r.name}</div></div>
          <div><span className="muted small">Telefon</span><div className="b">{r.phone}</div></div>
          <div><span className="muted small">Mavzu</span><div>{TOPIC[r.topic] || r.topic}</div></div>
          <div><span className="muted small">Xabar</span><div style={{ whiteSpace: "pre-wrap" }}>{r.message || "—"}</div></div>
        </div>
      )}
    />
  );
}

