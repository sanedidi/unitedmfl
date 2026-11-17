import type { Metadata } from "next";
import Link from "next/link";
import { api, safe } from "@/lib/api";
import { pageMeta } from "@/lib/seo";
import type { Partner, PartnersData } from "@/lib/types";
import { fmtVideoLength, PARTNER_CONTACT, PARTNER_KINDS, partnerGroups, partnerHost, partnerKindLabel } from "@/lib/partners";
import { PartnerLink, PartnerVideoButton } from "@/components/Partners";
import { ArrowRight, Play } from "@/components/Icons";
import { sized } from "@/lib/img";

type SP = Promise<{ tur?: string }>;

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const sp = await searchParams;
  return pageMeta({
    title: "Hamkorlar — United MFL homiylari va hamkorlari",
    description: "United MFL media futbol ligasini qo‘llab-quvvatlayotgan brendlar: bosh homiy, rasmiy va media hamkorlar. Hamkor bo‘lish bo‘yicha so‘rov qoldiring.",
    path: "/hamkorlar",
    noindex: !!sp.tur,
  });
}

/** «@united_mfl» from a t.me link set for the deployment (no guessed handles in code). */
function telegramHandle() {
  const url = process.env.SOCIAL_TELEGRAM || "";
  const m = url.match(/t\.me\/([A-Za-z0-9_]{4,})/);
  return m ? { url, handle: `@${m[1]}` } : null;
}

function Featured({ p }: { p: Partner }) {
  const meta = [p.url ? partnerHost(p.url) : "", p.video_url ? `▶ video${p.video_duration_sec ? ` ${fmtVideoLength(p.video_duration_sec)}` : ""}` : ""].filter(Boolean).join(" · ");
  return (
    <article className="pfeat">
      <PartnerLink p={p} className="pfeat-logo">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {p.logo_url ? <img {...sized(p.logo_url, 384)} alt={p.name} decoding="async" /> : <span className="pfeat-name">{p.name}</span>}
        {p.video_url && <i className="ptile-play" aria-hidden><Play size={20} /></i>}
      </PartnerLink>
      <div className="pfeat-info">
        <span className="badge badge-category">{partnerKindLabel(p.kind)}</span>
        <h3 className="h2">{p.name}</h3>
        {p.description && <p>{p.description}</p>}
        {meta && <span className="pfeat-meta">{meta}</span>}
        {(p.video_url || p.url) && (
          <div className="pfeat-actions">
            <PartnerVideoButton p={p} className="btn btn-primary">Videoni ko‘rish</PartnerVideoButton>
            {p.url && <a className={`btn ${p.video_url ? "btn-outline" : "btn-primary"}`} href={p.url} target="_blank" rel="noopener noreferrer sponsored">Saytga o‘tish</a>}
          </div>
        )}
      </div>
    </article>
  );
}

function Card({ p }: { p: Partner }) {
  return (
    <article className="pcard">
      <PartnerLink p={p} className="pcard-logo">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {p.logo_url ? <img {...sized(p.logo_url, 256)} alt={p.name} loading="lazy" decoding="async" /> : <span className="pcard-name">{p.name}</span>}
        {p.video_url && <i className="ptile-play" aria-hidden><Play size={14} /></i>}
      </PartnerLink>
      <div className="pcard-info">
        <b>{p.name}</b>
        <span>{p.description || partnerKindLabel(p.kind)}</span>
      </div>
      {p.url && (
        <a className="pcard-link" href={p.url} target="_blank" rel="noopener noreferrer sponsored">
          <span>{partnerHost(p.url)}</span><ArrowRight size={16} />
        </a>
      )}
    </article>
  );
}

const CtaCard = () => (
  <Link href={PARTNER_CONTACT} className="pcard-cta"><b>+ Sizning brendingiz</b><span>Hamkorlik formasiga o‘tadi</span></Link>
);

export default async function PartnersPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const data = await safe(api<PartnersData | null>("/partners"), null);
  const all = partnerGroups(data?.items || []);
  const tab = PARTNER_KINDS.find((k) => k.slug === sp.tur && all.some((g) => g.kind === k.kind));
  const groups = tab ? all.filter((g) => g.kind === tab.kind) : all;
  const cta = data?.settings.show_cta ?? true;
  const tg = telegramHandle();

  return (
    <>
      <header className="page-title with-tabs">
        <div className="container">
          <div className="overline">United MFL</div>
          <h1 className="h1">Hamkorlar</h1>
          <p className="lead">Ligani qo‘llab-quvvatlayotgan brendlar. Logotipga bosing — hamkor sayti yoki videosi ochiladi.</p>
          {all.length > 1 && (
            <nav className="tabs" aria-label="Hamkor turlari">
              <Link href="/hamkorlar" aria-current={!tab ? "page" : undefined}>Barchasi</Link>
              {all.map((g) => <Link key={g.kind} href={`/hamkorlar?tur=${g.slug}`} aria-current={tab?.kind === g.kind ? "page" : undefined}>{g.tab}</Link>)}
            </nav>
          )}
        </div>
      </header>
      <div className="container partners-page">
        {!groups.length && <div className="empty"><b>Hozircha hamkorlar yo‘q</b>Brendingiz birinchi bo‘lishi mumkin.</div>}
        {groups.map((g, i) => {
          const last = i === groups.length - 1;
          return (
            <section key={g.kind} className="partners-sec" aria-labelledby={`pg-${g.kind}`}>
              <div className="partners-sec-head"><h2 className="h2" id={`pg-${g.kind}`}>{g.group}</h2><span>{g.list.length} ta</span></div>
              {g.kind === "main" ? (
                <>
                  {g.list.map((p) => <Featured key={p.id} p={p} />)}
                  {last && cta && <div className="pcards"><CtaCard /></div>}
                </>
              ) : (
                <div className="pcards">
                  {g.list.map((p) => <Card key={p.id} p={p} />)}
                  {last && cta && <CtaCard />}
                </div>
              )}
            </section>
          );
        })}
        <section className="partners-join" aria-labelledby="pj-title">
          <div className="partners-join-text">
            <div className="overline">Hamkorlik</div>
            <h2 className="h2" id="pj-title">Brendingiz shu sahifada bo‘lsin</h2>
            <p>Saytda, ijtimoiy tarmoqlarda va o‘yin kunlarida brendingizni ko‘rsatamiz. So‘rov qoldiring — formatlar va shartlarni yuboramiz.</p>
          </div>
          <div className="partners-join-actions">
            <Link href={PARTNER_CONTACT} className="btn btn-primary">Hamkor bo‘lish</Link>
            {tg && <span>yoki Telegram: <a href={tg.url} target="_blank" rel="noopener noreferrer">{tg.handle}</a></span>}
          </div>
        </section>
      </div>
    </>
  );
}
