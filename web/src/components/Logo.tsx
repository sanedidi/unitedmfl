import Link from "next/link";

import { useT } from "@/lib/i18n";
/** Official league badge (round «United Media Football League» emblem). */
export function LogoMark({ size = 40, title }: { size?: number; title?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/logo.svg" width={size} height={size} alt={title || ""} className="logo-badge" style={{ width: size, height: size }} />;
}

/** Badge + name. `compact` keeps only «United MFL» (mobile header). */
export function Logo({ compact = false, size = 44 }: { compact?: boolean; size?: number }) {
  const tx = useT();
  return (
    <span className="logo-lockup">
      <LogoMark size={size} />
      <span className="logo-text">
        <b>{tx("United MFL")}</b>
        {!compact && <small>{tx("Media Football League")}</small>}
      </span>
    </span>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  const tx = useT();
  return (
    <Link href="/" className="brand" aria-label={tx("United MFL — bosh sahifa")}>
      <Logo compact={compact} />
    </Link>
  );
}
