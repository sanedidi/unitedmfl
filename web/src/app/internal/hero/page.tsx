import Link from "next/link";
import { api, safe } from "@/lib/api";
import { fmtPlainDate } from "@/lib/format";
import { pageMeta } from "@/lib/seo";
import { HERO_LAYOUTS, type Banner, type HeroLayout } from "@/lib/types";
import { HeroCarousel } from "@/components/HeroCarousel";
import { TEST_PHOTOS, testPhoto, type TestPhoto } from "@/lib/hero-test-photos";

// Internal comparison page for the hero layouts: every layout on a dark,
// a near-white and a busy photo, on the real banner photo, without a photo
// and with a three-line title. Not linked anywhere, not indexed.

export const metadata = pageMeta({ title: "Hero — ko‘rinishlar", description: "Hero-banner ko‘rinishlarini solishtirish", path: "/internal/hero", noindex: true });
export const dynamic = "force-dynamic";

const INFO: Record<HeroLayout, { name: string; text: string }> = {
  shade: { name: "Shade Left", text: "Chapda va pastda to‘q gradient, matn chapda pastda. Standart." },
  panel: { name: "Bottom Panel", text: "Matn pastdagi yaxlit grafit panelda, foto panel ustida ko‘rinadi." },
  glass: { name: "Glass Card", text: "Xira (blur) yarim shaffof grafit karta." },
  split: { name: "Split Diagonal", text: "Chapda qiya grafit tekislik, laym qirra — intro-stingerdagidek." },
  poster: { name: "Center Poster", text: "Matn markazda, radial qoraytirish. Final va maxsus voqealar uchun." },
};

const DEMO: Banner = {
  id: -1, title: "Final: chiptalar sotuvda", badge: "FINAL", badge_type: "accent", event_date: "2026-07-04", event_time: "20:00",
  venue: "Jar stadioni", cta_label: "Chipta olish", cta_url: "#", image_desktop: "", image_mobile: "", ord: 1,
};
const LONG = "Final: United MFL 2026 chempioni Jar stadionida aniqlanadi — chiptalar allaqachon sotuvda";
const SLIDES: Banner[] = [
  { ...DEMO, id: -2, title: "Yarim final: A1 — Blacstone", badge: "YARIM FINAL", event_date: "2026-06-19", event_time: "18:30", ord: 2 },
  { ...DEMO, id: -3, title: "Xudi MFL — rasmiy merch", badge: "MERCH", event_date: null, event_time: "", venue: "", cta_label: "Do‘kon", ord: 3 },
];

export default async function HeroLayouts({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  const { v } = await searchParams;
  const only = HERO_LAYOUTS.find((l) => l === v);
  const banners = await safe(api<Banner[]>("/banners", { revalidate: 0 }), []);
  const real = banners.find((b) => b.image_desktop || b.image_mobile);

  const all = [DEMO, ...SLIDES, ...banners];
  const dates = Object.fromEntries(all.map((b) => [b.id, fmtPlainDate(b.event_date)]));
  const withPhoto = (p: TestPhoto): Banner => {
    const t = testPhoto(p);
    return { ...DEMO, image_desktop: t.desktop, image_mobile: t.mobile };
  };
  const cases: { key: string; label: string; banners: Banner[] }[] = [
    ...TEST_PHOTOS.map((p) => ({ key: p.id, label: p.label, banners: [withPhoto(p.id), ...SLIDES] })),
    ...(real ? [{ key: "real", label: `Haqiqiy banner — «${real.title}»`, banners: [real, ...SLIDES] }] : []),
    { key: "none", label: "Fotosiz — grafit fon, laym nur", banners: [DEMO, ...SLIDES] },
    { key: "long", label: "Uzun sarlavha (3 qator), bitta slayd, yorug‘ foto", banners: [{ ...withPhoto("light"), title: LONG }] },
  ];

  return (
    <>
      <section className="section" style={{ paddingBottom: 24 }}>
        <div className="container stack">
          <div className="overline">Ichki sahifa · indekslanmaydi</div>
          <h1 className="h1">Hero-banner: 5 ko‘rinish</h1>
          <p className="lead">
            Har bir ko‘rinish uchta og‘ir fotoda (qorong‘i, juda yorug‘, ola-chalpoq), haqiqiy banner fotosida, fotosiz va uzun sarlavha bilan.
            Planshet va telefon ko‘rinishini ko‘rish uchun brauzer oynasini toraytiring. Bannerga ko‘rinish admin-panelda tanlanadi:
            «Hero-bannerlar» → banner → «Matn joylashuvi».
          </p>
          <nav className="chips" aria-label="Ko‘rinishlar">
            <Link className={`chip${!only ? " on" : ""}`} href="/internal/hero">Hammasi</Link>
            {HERO_LAYOUTS.map((l) => <Link key={l} className={`chip${only === l ? " on" : ""}`} href={`/internal/hero?v=${l}`}>{INFO[l].name}</Link>)}
          </nav>
        </div>
      </section>

      {(only ? [only] : HERO_LAYOUTS).map((l, n) => (
        <section key={l} id={l} style={{ borderTop: "1px solid var(--border)" }}>
          <div className="container" style={{ padding: "32px var(--gutter) 16px" }}>
            <div className="overline">{String(n + 1).padStart(2, "0")} · layout=&quot;{l}&quot;</div>
            <h2 className="h2">{INFO[l].name}</h2>
            <p className="secondary" style={{ margin: "8px 0 0" }}>{INFO[l].text}</p>
          </div>
          {cases.map((c) => (
            <div key={c.key} data-case={c.key} style={{ marginBottom: 24 }}>
              <div className="container" style={{ paddingBottom: 8 }}><span className="overline">{c.label}</span></div>
              <HeroCarousel banners={c.banners} dates={dates} season="United MFL 2026" layout={l} label={`${INFO[l].name} — ${c.label}`} />
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
