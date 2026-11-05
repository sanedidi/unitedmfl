import Link from "next/link";

export function LogoMark({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <circle cx="24" cy="24" r="24" fill="#fff" />
      <g fill="#1F2A6B">
        <path d="M13 13h8v4h-4v4h-4zM35 13h-8v4h4v4h4zM13 35h8v-4h-4v-4h-4zM35 35h-8v-4h4v-4h4z" />
      </g>
      <circle cx="24" cy="24" r="6.5" fill="none" stroke="#E5383B" strokeWidth="3.5" />
    </svg>
  );
}

export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="United MFL — bosh sahifa">
      <LogoMark />
      <span className="brand-text">
        <b>UNITED MFL</b>
        <small>MEDIA FOOTBALL LEAGUE</small>
      </span>
    </Link>
  );
}
