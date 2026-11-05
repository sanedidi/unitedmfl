import type { Metadata, Viewport } from "next";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { JsonLd } from "@/components/JsonLd";
import nextDynamic from "next/dynamic";
import { archivo, inter } from "@/lib/fonts";
import { DEFAULT_OG, ORG_ID, SITE_NAME, SITE_URL } from "@/lib/seo";
import "./globals.css";

// Pages are server-rendered per request (fresh scores); API data itself is cached
// in the Next.js data cache and purged on every admin change (see lib/api.ts).
export const dynamic = "force-dynamic";

// GA4 + Web Vitals reporting ships only when a measurement id is configured.
const GA_ID = process.env.NEXT_PUBLIC_GA_ID;
const Analytics = GA_ID ? nextDynamic(() => import("@/components/Analytics").then((m) => m.Analytics)) : () => null;

const DESCRIPTION = "United MFL — media futbol ligasi: matchlar taqvimi va natijalari, jonli hisob, turnir jadvali, jamoalar, o‘yinchilar va yangiliklar.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "United MFL — Media Football League", template: "%s | United MFL" },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  icons: { icon: [{ url: "/favicon.svg", type: "image/svg+xml" }, { url: "/icon.png", type: "image/png", sizes: "512x512" }], apple: "/apple-touch-icon.png" },
  openGraph: { type: "website", siteName: SITE_NAME, locale: "uz_UZ", images: [{ url: DEFAULT_OG, width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image" },
  formatDetection: { telephone: false },
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
    yandex: process.env.YANDEX_VERIFICATION || undefined,
    other: process.env.BING_SITE_VERIFICATION ? { "msvalidate.01": process.env.BING_SITE_VERIFICATION } : undefined,
  },
};

export const viewport: Viewport = { themeColor: "#15181C", width: "device-width", initialScale: 1, colorScheme: "light" };

const siteLd = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "SportsOrganization", "@id": ORG_ID, name: SITE_NAME, alternateName: "United Media Football League", url: SITE_URL, logo: `${SITE_URL}/icon.png`, sport: "Football" },
    { "@type": "WebSite", "@id": `${SITE_URL}/#website`, url: SITE_URL, name: SITE_NAME, inLanguage: "uz", publisher: { "@id": ORG_ID } },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const ticketUrl = process.env.TICKETS_URL || "/matchlar";
  return (
    <html lang="uz" className={`${inter.variable} ${archivo.variable}`}>
      <body>
        <a href="#main" className="sr-only">Asosiy kontentga o‘tish</a>
        <Header ticketUrl={ticketUrl} />
        <main id="main">{children}</main>
        <Footer />
        <JsonLd data={siteLd} />
        <Analytics />
      </body>
    </html>
  );
}
