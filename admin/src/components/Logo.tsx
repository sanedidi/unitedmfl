/** Official league badge (round «United Media Football League» emblem). */
export function LogoMark({ size = 32, mono = false }: { size?: number; mono?: boolean }) {
  return <img src={mono ? "/logo-mark.svg" : "/logo.svg"} width={size} height={size} alt="" className="logo-badge" style={{ width: size, height: mono ? "auto" : size }} />;
}

/** Badge + «United MFL»; `compact` hides the name. */
export function Logo({ size = 32, compact = false, className = "logo" }: { size?: number; compact?: boolean; className?: string }) {
  return (
    <span className={className} aria-label="United MFL">
      <LogoMark size={size} />
      {!compact && <span>United MFL</span>}
    </span>
  );
}
