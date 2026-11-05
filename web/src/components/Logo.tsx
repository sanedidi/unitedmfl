import Link from "next/link";

/** League mark: four corner pieces around a ring (Figma: Logo/Mark). Uses currentColor. */
export function LogoMark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="currentColor" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <path d="M0 0H37V14.3A38 38 0 0 0 14.3 37H0Z" />
      <path d="M100 0H63V14.3A38 38 0 0 1 85.7 37H100Z" />
      <path d="M0 100H37V85.7A38 38 0 0 1 14.3 63H0Z" />
      <path d="M100 100H63V85.7A38 38 0 0 0 85.7 63H100Z" />
      <path fillRule="evenodd" d="M50 21.5a28.5 28.5 0 1 1 0 57 28.5 28.5 0 0 1 0-57Zm0 13a15.5 15.5 0 1 0 0 31 15.5 15.5 0 0 0 0-31Z" />
    </svg>
  );
}

/** Horizontal lockup «United ⧉ MFL»; `compact` drops «MFL» (mobile header). */
export function Logo({ compact = false, size = 26 }: { compact?: boolean; size?: number }) {
  const fs = Math.round(size * 0.86);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.3), fontFamily: "var(--font-ui)", fontWeight: 700, fontSize: fs, letterSpacing: "-0.03em", lineHeight: 1 }}>
      <span>United</span>
      <LogoMark size={size} />
      {!compact && <span>MFL</span>}
    </span>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="brand" aria-label="United MFL — bosh sahifa">
      <Logo compact={compact} />
    </Link>
  );
}
