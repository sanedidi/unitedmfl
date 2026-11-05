/** League mark (Figma: Logo/Mark): four corner pieces around a ring. Uses currentColor. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="currentColor" aria-hidden>
      <path d="M0 0H37V14.3A38 38 0 0 0 14.3 37H0Z" />
      <path d="M100 0H63V14.3A38 38 0 0 1 85.7 37H100Z" />
      <path d="M0 100H37V85.7A38 38 0 0 1 14.3 63H0Z" />
      <path d="M100 100H63V85.7A38 38 0 0 0 85.7 63H100Z" />
      <path fillRule="evenodd" d="M50 21.5a28.5 28.5 0 1 1 0 57 28.5 28.5 0 0 1 0-57Zm0 13a15.5 15.5 0 1 0 0 31 15.5 15.5 0 0 0 0-31Z" />
    </svg>
  );
}

/** Lockup «United ⧉ MFL»; `compact` drops «MFL». */
export function Logo({ size = 20, compact = false, className = "logo" }: { size?: number; compact?: boolean; className?: string }) {
  return (
    <span className={className} aria-label="United MFL">
      <span>United</span>
      <LogoMark size={size} />
      {!compact && <span>MFL</span>}
    </span>
  );
}
