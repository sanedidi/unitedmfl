import Link from "next/link";

/** Official league badge (round «United Media Football League» emblem). */
export function LogoMark({ size = 40, title }: { size?: number; title?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/logo.svg" width={size} height={size} alt={title || ""} className="logo-badge" style={{ width: size, height: size }} />;
}

/** Badge + name. `compact` keeps only «United MFL» (mobile header). */
export function Logo({ compact = false, size = 44 }: { compact?: boolean; size?: number }) {
  return (
    <span className="logo-lockup">
      <LogoMark size={size} />
      <span className="logo-text">
        <b>United MFL</b>
        {!compact && <small>Media Football League</small>}
      </span>
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
