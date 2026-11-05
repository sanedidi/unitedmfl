import type { Metadata, Viewport } from "next";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import "./globals.css";

// Every page is rendered on the server per request (SSR) with fresh data from the API.
export const dynamic = "force-dynamic";

const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://unitedmfl.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: "United MFL — Media Football League", template: "%s · United MFL" },
  description: "United MFL — media futbol ligasi: matchlar, natijalar, turnir jadvali, jamoalar, o‘yinchilar va yangiliklar.",
  openGraph: { type: "website", siteName: "United MFL", locale: "uz_UZ" },
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = { themeColor: "#020304", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const ticketUrl = process.env.TICKETS_URL || "/matchlar";
  return (
    <html lang="uz">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700;800&family=Unbounded:wght@600;700;800;900&display=swap" rel="stylesheet" />
      </head>
      <body>
        <a href="#main" className="sr-only">Asosiy kontentga o‘tish</a>
        <Header ticketUrl={ticketUrl} />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
