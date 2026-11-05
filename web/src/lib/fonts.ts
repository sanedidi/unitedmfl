import localFont from "next/font/local";

// Self-hosted variable fonts (no third-party requests), subset to Latin + Uzbek
// punctuation (ʻ ‘ ’) — see src/assets/fonts.
// Body face: preloaded, swaps in over a metric-matched fallback (no layout shift).
// Display face: not preloaded (so it does not compete with CSS for the first paint)
// and "optional": used when already available (cached after the first page view),
// never causing a late repaint that would push LCP back on slow mobile networks.
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
  preload: false,
  variable: "--font-unbounded",
  fallback: ["Arial Black", "Arial", "sans-serif"],
});
