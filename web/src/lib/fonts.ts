import localFont from "next/font/local";

// Self-hosted variable fonts (no third-party requests), subset to Latin + Uzbek
// punctuation (ʻ ‘ ’) — see src/assets/fonts. Preloaded via the Link header.
// Body text swaps in over a metric-matched fallback (no layout shift);
// the display face uses "optional": it is shown when it arrives within the
// first ~100 ms (always on repeat visits) and never causes a late repaint that
// would push LCP back on slow mobile networks.
export const onest = localFont({
  src: "../assets/fonts/onest-latin-var.woff2",
  weight: "400 800",
  display: "swap",
  variable: "--font-onest",
  fallback: ["system-ui", "Segoe UI", "Roboto", "Arial", "sans-serif"],
});

export const unbounded = localFont({
  src: "../assets/fonts/unbounded-latin-var.woff2",
  weight: "600 900",
  display: "optional",
  variable: "--font-unbounded",
  fallback: ["Arial Black", "Arial", "sans-serif"],
});
