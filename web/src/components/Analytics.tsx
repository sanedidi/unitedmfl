"use client";
import Script from "next/script";
import { useReportWebVitals } from "next/web-vitals";

const GA = process.env.NEXT_PUBLIC_GA_ID;

declare global {
  interface Window { gtag?: (...a: unknown[]) => void; dataLayer?: unknown[] }
}

/** Optional GA4 (only when NEXT_PUBLIC_GA_ID is set) + real-user Core Web Vitals sent as GA events. */
export function Analytics() {
  useReportWebVitals((m) => {
    if (!GA || !window.gtag) return;
    window.gtag("event", m.name, {
      value: Math.round(m.name === "CLS" ? m.value * 1000 : m.value),
      metric_id: m.id,
      metric_value: m.value,
      metric_rating: (m as { rating?: string }).rating,
      non_interaction: true,
    });
  });
  if (!GA) return null;
  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA}`} strategy="afterInteractive" />
      <Script id="ga4" strategy="afterInteractive">
        {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}window.gtag=gtag;gtag('js',new Date());gtag('config','${GA}',{anonymize_ip:true});`}
      </Script>
    </>
  );
}
