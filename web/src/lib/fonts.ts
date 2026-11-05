import localFont from "next/font/local";

// Self-hosted variable fonts (no third-party requests), Latin subset incl. Uzbek
// punctuation (ʻ ‘ ’) — see src/assets/fonts. Cyrillic for Inter is a separate
// @font-face with a unicode-range in globals.css (/public/fonts), so Latin pages
// never download it.
// UI face: preloaded, swaps in over a metric-matched fallback (no layout shift).
// Display face (headings, scores): not preloaded so it does not compete with CSS
// for the first paint; "optional" never causes a late repaint that would push LCP.
export const inter = localFont({
  src: "../assets/fonts/inter-latin-var.woff2",
  weight: "400 800",
  display: "swap",
  variable: "--font-inter",
  fallback: ["system-ui", "Segoe UI", "Roboto", "Arial", "sans-serif"],
});

export const archivo = localFont({
  src: "../assets/fonts/archivo-latin-var.woff2",
  weight: "500 900",
  display: "optional",
  preload: false,
  variable: "--font-archivo",
  fallback: ["Arial", "Helvetica", "sans-serif"],
});
