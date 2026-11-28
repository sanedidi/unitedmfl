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


import { tx } from "@/lib/i18n";
/* ---------- Teams ---------- */
export function TeamsPage() {
  const { groups } = useRefs();
  const fields: FieldSpec[] = [
    { name: "name", label: tx("Nomi"), required: true },
    { name: "slug", label: tx("Slug (URL)"), type: "slug", slugFrom: "name", required: true, hint: tx("lotin harflari, raqamlar va «-»") },
    { name: "short_name", label: tx("Qisqa nomi"), hint: tx("emblemada (3 belgigacha)") },
    { name: "group_id", label: tx("Guruh"), type: "number", nullable: true, hidden: true },
    { name: "is_active", label: tx("Faol"), type: "bool", side: true },
    { name: "crest_url", label: tx("Emblema"), type: "image", side: true },
    { name: "colors", label: tx("Ranglar"), type: "colors", hint: "#E5383B, #FFFFFF" },
    { name: "leader", label: tx("Sardor / yetakchi") },
    { name: "instagram", label: "Instagram", type: "url" },
    { name: "telegram", label: "Telegram", type: "url" },
    { name: "kit_url", label: tx("Forma"), hidden: true },
  ];
  return (
    <CrudSection<Team & Record<string, any>> base="/teams" cards={(c) => <TeamKitSection c={c} />} sideCards={(c) => <><TeamGroupCard c={c} />{c.item?.id ? <><TeamCabinetCard teamId={c.item.id} /><TeamStickerCard teamId={c.item.id} version={c.version} /></> : null}</>} onChanged={invalidateRefs} title={tx("Jamoalar")} resource="/admin/teams" singular={tx("Jamoa")} deleteText={tx("Jamoa bilan birga uning barcha o‘yinchilari, media shaxslari va murabbiylari ham o‘chadi. Bu amalni qaytarib bo‘lmaydi.")} searchable fields={fields} defaults={{ is_active: true, group_id: null }}
      filters={[{ param: "group_id", label: tx("Guruh"), options: groups.map((g) => ({ value: String(g.id), label: groupTitle(g) })) }]}
      columns={[
        { label: tx("Jamoa"), render: (t) => <span className="row"><Crest team={t} /> <b>{t.name}</b></span> },
        { label: tx("Guruh"), render: (t) => t.group_label ? <span>{t.group_label}{t.group_is_provisional && <span className="muted small">{" "}{tx("· taxminiy")}</span>}</span> : <span className="muted">—</span> },
        { label: tx("Slug"), render: (t) => <span className="muted">{t.slug}</span>, className: "hide-mobile" },
        { label: tx("Holat"), render: (t) => t.is_active ? <Badge tone="ok">{tx("Faol")}</Badge> : <Badge>{tx("Arxiv")}</Badge> },
      ]}
      extra={(t) => <>
        <a className="btn btn-sm" style={{ marginTop: 20 }} href={`${SITE_URL}/jamoalar/${t.slug}`} target="_blank" rel="noreferrer">{tx("Saytda ko‘rish")}</a>
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
    { name: "full_name", label: tx("F.I.Sh."), required: true, full: true },
    { name: "team_id", label: tx("Jamoa"), type: "select", nullable: true, numeric: true, options: teamOpts },
    { name: "number", label: tx("Raqam"), type: "jersey", nullable: true, placeholder: tx("10 yoki Z10"),
      requiredIf: (v) => !!byId.get(Number(v.team_id))?.kit_has_number,
      hintFor: (v) => byId.get(Number(v.team_id))?.kit_has_number ? tx("Jamoa formasida raqam bor — AI rasmda shu raqamni chizadi. Harf ham yozish mumkin: Z10") : tx("Raqam yoki harf bilan: 10, Z10 (4 ta belgigacha)") },
    { name: "position", label: tx("Amplua"), type: "select", nullable: true, options: posOpts },
    { name: "jersey_name", label: tx("Futbolkada yozilishi"), placeholder: tx("FAMILIYA") },
    { name: "kit_size", label: tx("Forma o‘lchami"), type: "select", nullable: true, options: ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"].map((x) => ({ value: x, label: x })) },
    { name: "birth_date", label: tx("Tug‘ilgan sana"), type: "date", nullable: true },
    { name: "workplace", label: tx("Ish joyi / faoliyati") },
    { name: "is_active", label: tx("Faol"), type: "bool", side: true },
    { name: "is_media", label: tx("Media shaxs"), type: "bool", side: true, hint: tx("bloger yoki boshqa media shaxs") },
    { name: "photo_url", label: tx("Rasm"), hidden: true },
    { name: "instagram", label: "Instagram", type: "url" },
  ];
  return (
    <CrudSection<Player & Record<string, any>> base="/players" sideCards={(c) => <PlayerPhotoCard c={c} />} titleField="full_name" title={tx("O‘yinchilar")} resource="/admin/players" singular={tx("O‘yinchi")} searchable fields={fields} defaults={{ is_active: true }} reloadKey={teams.length}
      filters={[{ param: "team_id", label: tx("Jamoa"), options: teamOpts }, { param: "position", label: tx("Amplua"), options: posOpts }]}
      columns={[
        { label: "№", render: (p) => <b className="tnum">{p.number ?? "—"}</b> },
        { label: tx("O‘yinchi"), render: (p) => <b>{p.full_name}</b> },
        { label: tx("Jamoa"), render: (p) => { const t = p.team_id ? byId.get(p.team_id) : null; return t ? <span className="row"><Crest team={t} size={22} /> {t.name}</span> : <span className="muted">—</span>; } },
        { label: tx("Amplua"), render: (p) => POSITIONS[p.position] || <span className="muted">—</span>, className: "hide-mobile" },
        { label: tx("Holat"), render: (p) => p.is_active ? <Badge tone="ok">{tx("Faol")}</Badge> : <Badge>{tx("Nofaol")}</Badge>, className: "hide-mobile" },
      ]}
    />
  );
}

/* ---------- Seasons & stages ---------- */
const STAGE_KINDS = [
  { value: "group", label: tx("Guruh bosqichi") }, { value: "round_of_16", label: tx("1/8 final") }, { value: "quarter", label: tx("Chorak final") },
  { value: "semi", label: tx("Yarim final") }, { value: "final", label: tx("Final") }, { value: "other", label: tx("Boshqa") },
];
const STAGE_STATUS = [{ value: "scheduled", label: tx("Rejalashtirilgan") }, { value: "active", label: tx("Davom etmoqda") }, { value: "finished", label: tx("Yakunlangan") }];

export function SeasonsPage() {
  const { seasons } = useRefs();
  const seasonOpts = seasons.map((s) => ({ value: String(s.id), label: s.name }));
  return (
    <div className="stack" style={{ gap: 32 }}>
      <CrudPage edit="drawer" onChanged={invalidateRefs} title={tx("Mavsumlar")} resource="/admin/seasons" singular={tx("Mavsum")} defaults={{ is_active: false }}
        fields={[
          { name: "name", label: tx("Nomi"), required: true },
          { name: "slug", label: tx("Slug"), type: "slug", slugFrom: "name", required: true },
          { name: "teams_planned", label: tx("Jamoalar soni"), type: "number", nullable: true },
          { name: "matches_planned", label: tx("Matchlar soni"), type: "number", nullable: true },
          { name: "is_active", label: tx("Faol mavsum (saytda ko‘rsatiladi)"), type: "bool", full: true },
        ]}
        columns={[
          { label: tx("Mavsum"), render: (s) => <b>{s.name}</b> },
          { label: tx("Jamoalar"), render: (s) => s.teams_planned ?? "—" },
          { label: tx("Matchlar"), render: (s) => s.matches_planned ?? "—" },
          { label: tx("Holat"), render: (s) => s.is_active ? <Badge tone="ok">{tx("Faol")}</Badge> : <Badge>{tx("Arxiv")}</Badge> },
        ]}
      />
      <CrudPage edit="drawer" onChanged={invalidateRefs} title={tx("Bosqichlar")} resource="/admin/stages" singular={tx("Bosqich")} limit={100} reloadKey={seasons.length}
        defaults={{ season_id: String(activeSeason(seasons)?.id || ""), kind: "group", status: "scheduled", ord: "1" }}
        filters={[{ param: "season_id", label: tx("Mavsum"), options: seasonOpts }]}
        fields={[
          { name: "season_id", label: tx("Mavsum"), type: "select", numeric: true, options: seasonOpts, required: true },
          { name: "name", label: tx("Nomi"), required: true },
          { name: "kind", label: tx("Turi"), type: "select", options: STAGE_KINDS },
          { name: "status", label: tx("Holat"), type: "select", options: STAGE_STATUS },
          { name: "ord", label: tx("Tartib"), type: "number" },
          { name: "note", label: tx("Izoh"), type: "textarea" },
        ]}
        columns={[
          { label: "#", render: (s) => s.ord },
          { label: tx("Bosqich"), render: (s) => <b>{s.name}</b> },
          { label: tx("Turi"), render: (s) => STAGE_KINDS.find((k) => k.value === s.kind)?.label || s.kind },
          { label: tx("Holat"), render: (s) => <Badge tone={s.status === "active" ? "live" : s.status === "finished" ? "" : "info"}>{STAGE_STATUS.find((k) => k.value === s.status)?.label}</Badge> },
          { label: tx("Izoh"), render: (s) => <span className="muted small ellipsis" style={{ maxWidth: 320, display: "inline-block" }}>{s.note}</span>, className: "hide-mobile" },
        ]}
      />
    </div>
  );
}

/* ---------- News ---------- */
const NEWS_STATUS = [{ value: "draft", label: tx("Qoralama") }, { value: "published", label: tx("Nashr etilgan") }, { value: "scheduled", label: tx("Rejalashtirilgan") }];
export function NewsPage() {
  const matchOpts = useMatchOptions();
  return (
    <CrudSection base="/news" title={tx("Yangiliklar")} resource="/admin/news" singular={tx("Yangilik")} searchable defaults={{ status: "draft", category: "LIGA" }}
      filters={[{ param: "status", label: tx("Holat"), options: NEWS_STATUS }]}
      fields={[
        { name: "title", label: tx("Sarlavha"), required: true, full: true },
        { name: "slug", label: tx("Slug (URL)"), type: "slug", slugFrom: "title", required: true, full: true },
        { name: "category", label: tx("Rukn"), placeholder: tx("LIGA, ANONS, NATIJA…") },
        { name: "status", label: tx("Holat"), type: "select", options: NEWS_STATUS, side: true },
        { name: "published_at", label: tx("Nashr vaqti (Toshkent)"), type: "datetime", hint: tx("Nashr/rejalashtirish uchun majburiy"), side: true },
        { name: "on_home", label: tx("Bosh sahifada ko‘rsatish"), type: "bool", side: true },
        { name: "excerpt", label: tx("Qisqa matn (lid)"), type: "textarea" },
        { name: "body", label: tx("Matn"), type: "markdown" },
        { name: "cover_url", label: tx("Muqova"), type: "image", side: true },
        { name: "tags", label: tx("Teglar"), type: "tags", hint: tx("vergul bilan") },
        { name: "match_id", label: tx("Bog‘langan match"), type: "select", numeric: true, nullable: true, placeholder: tx("Match bilan bog‘lanmagan"), options: matchOpts },
        { name: "seo_description", label: tx("SEO tavsif (160 belgi)"), type: "textarea" },
      ]}
      columns={[
        { label: tx("Sarlavha"), render: (n) => <div><b>{n.title}</b><div className="muted small">{n.category}</div></div> },
        { label: tx("Holat"), render: (n) => <Badge tone={n.status === "published" ? "ok" : n.status === "scheduled" ? "info" : ""}>{NEWS_STATUS.find((s) => s.value === n.status)?.label}</Badge> },
        { label: tx("Sana"), render: (n) => <span className="nowrap">{n.published_at ? fmtDateTime(n.published_at) : "—"}</span>, className: "hide-mobile" },
        { label: tx("Ko‘rishlar"), render: (n) => n.views, className: "hide-mobile" },
      ]}
      extra={(n) => n.status !== "draft" ? <a className="btn btn-sm" style={{ marginTop: 20 }} href={`${SITE_URL}/yangiliklar/${n.slug}`} target="_blank" rel="noreferrer">{tx("Saytda ko‘rish")}</a> : null}
    />
  );
}

/* ---------- Videos ---------- */
const VIDEO_KIND = [{ value: "highlight", label: tx("Sharh") }, { value: "interview", label: tx("Intervyu") }, { value: "announcement", label: tx("Anons") }, { value: "full", label: tx("To‘liq o‘yin") }];
export function VideosPage() {
  const matchOpts = useMatchOptions();
  return (
    <CrudSection base="/videos" title={tx("Videolar")} resource="/admin/videos" singular={tx("Video")} defaults={{ kind: "highlight", status: "draft", source: "file" }}
      filters={[{ param: "status", label: tx("Holat"), options: [{ value: "draft", label: tx("Qoralama") }, { value: "published", label: tx("Nashr etilgan") }] }]}
      cards={(c) => <VideoSourceCard c={c} />}
      sideCardsAfter={(c) => <VideoCoverCard c={c} />}
      saveBlocked={(v) => (v.__uploading ? tx("Video yuklanmoqda — tugashini kuting") : undefined)}
      fields={[
        { name: "title", label: tx("Sarlavha"), required: true, full: true },
        { name: "source", label: tx("Manba"), hidden: true },
        { name: "url", label: tx("Video"), hidden: true },
        { name: "kind", label: tx("Turi"), type: "select", options: VIDEO_KIND },
        { name: "match_id", label: tx("Match"), type: "select", numeric: true, nullable: true, placeholder: tx("Match bilan bog‘lanmagan"), options: matchOpts },
        { name: "duration_sec", label: tx("Davomiyligi (soniya)"), type: "number", nullable: true, hint: tx("Fayl yuklanganda avtomatik to‘ladi") },
        { name: "status", label: tx("Holat"), type: "select", options: [{ value: "draft", label: tx("Qoralama") }, { value: "published", label: tx("Nashr etilgan") }], side: true },
        { name: "published_at", label: tx("Nashr vaqti"), type: "datetime", side: true },
        { name: "thumbnail_url", label: tx("Muqova"), hidden: true },
      ]}
      columns={[
        { label: tx("Video"), render: (v) => <div><b>{v.title}</b><div className="muted small">{v.source === "file" || isUploadedVideo(v.url) ? tx("Fayl") : youtubeId(v.url) ? "YouTube" : tx("Havola")}</div></div> },
        { label: tx("Turi"), render: (v) => VIDEO_KIND.find((k) => k.value === v.kind)?.label },
        { label: tx("Holat"), render: (v) => v.status === "published" ? <Badge tone="ok">{tx("Nashr etilgan")}</Badge> : <Badge>{tx("Qoralama")}</Badge> },
        { label: tx("Sana"), render: (v) => fmtDate(v.published_at), className: "hide-mobile" },
      ]}
    />
  );
}

/* ---------- Requests ---------- */
const REQ_STATUS = [{ value: "new", label: tx("Yangi") }, { value: "in_progress", label: tx("Jarayonda") }, { value: "closed", label: tx("Yopilgan") }];
const TOPIC: Record<string, string> = { partnership: tx("Hamkorlik"), sponsorship: tx("Homiylik"), team: tx("Jamoa"), tickets: tx("Chiptalar"), other: tx("Boshqa") };
export function RequestsPage() {
  return (
    <CrudSection base="/requests" titleField="name" title={tx("Murojaatlar")} sub={tx("Saytdagi aloqa formasi orqali kelgan so‘rovlar")} resource="/admin/requests" singular={tx("Murojaat")} searchable canCreate={false}
      filters={[{ param: "status", label: tx("Holat"), options: REQ_STATUS }, { param: "topic", label: tx("Mavzu"), options: Object.entries(TOPIC).map(([value, label]) => ({ value, label })) }]}
      fields={[
        { name: "status", label: tx("Holat"), type: "select", options: REQ_STATUS, side: true },
        { name: "internal_note", label: tx("Ichki izoh"), type: "textarea", side: true },
      ]}
      columns={[
        { label: tx("Sana"), render: (r) => <span className="nowrap">{fmtDateTime(r.created_at)}</span> },
        { label: tx("Ism"), render: (r) => <b>{r.name}</b> },
        { label: tx("Telefon"), render: (r) => <a href={`tel:${r.phone.replace(/[^\d+]/g, "")}`} onClick={(e) => e.stopPropagation()}>{r.phone}</a> },
        { label: tx("Mavzu"), render: (r) => TOPIC[r.topic] || r.topic, className: "hide-mobile" },
        { label: tx("Holat"), render: (r) => <Badge tone={r.status === "new" ? "live" : r.status === "in_progress" ? "info" : ""}>{REQ_STATUS.find((s) => s.value === r.status)?.label}</Badge> },
      ]}
      extra={(r) => (
        <div className="stack" style={{ marginTop: 24, gap: 8 }}>
          <hr className="sep" />
          <div><span className="muted small">{tx("Ism")}</span><div className="b">{r.name}</div></div>
          <div><span className="muted small">{tx("Telefon")}</span><div className="b">{r.phone}</div></div>
          <div><span className="muted small">{tx("Mavzu")}</span><div>{TOPIC[r.topic] || r.topic}</div></div>
          <div><span className="muted small">{tx("Xabar")}</span><div style={{ whiteSpace: "pre-wrap" }}>{r.message || "—"}</div></div>
        </div>
      )}
    />
  );
}

