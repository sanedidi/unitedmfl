/**
 * The league badge as separate, animatable layers (same geometry as /logo.svg):
 * white disc, outer and inner red rings, two side arcs, red centre ring and the
 * navy lettering/elements (one contour, loaded from /brand/emblem-lettering.svg).
 * Purely decorative: every place that uses it is aria-hidden.
 */
export function Emblem({ className = "" }: { className?: string }) {
  return (
    <svg className={`emblem ${className}`} viewBox="0 0 1000 1000" aria-hidden="true" focusable="false">
      <circle className="em-disc" cx="500" cy="500" r="498.06" fill="#fff" />
      <g fill="none" stroke="#ED2F31" strokeWidth="5.35">
        {/* rings start at 12 o'clock and draw clockwise */}
        <circle className="em-ring em-ring-outer" cx="500" cy="500" r="495.39" pathLength={1} transform="rotate(-90 500 500)" />
        <circle className="em-ring em-ring-inner" cx="500" cy="500" r="334.34" pathLength={1} transform="rotate(-90 500 500)" />
        <path className="em-arc" d="M220.24 316.93L85.48 228.75" />
        <path className="em-arc" d="M779.76 316.93L914.52 228.75" />
      </g>
      <circle className="em-centre" cx="500" cy="500" r="105.25" fill="none" stroke="#ED2F31" strokeWidth="63.51" />
      <g className="em-lettering">
        <image href="/brand/emblem-lettering.svg" width="1000" height="1000" />
      </g>
    </svg>
  );
}
