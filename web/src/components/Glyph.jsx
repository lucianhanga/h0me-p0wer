// Minimal stroke-based glyphs (2026-10-03, user request: "more spartan,
// more abstract" — emoji render platform-dependently and clash with the
// app's flat style; same reasoning as StateIcon.jsx's MDI paths). All are
// 24×24, stroke: currentColor, no fill — they inherit the surrounding
// text color and weight. Weather glyphs redrawn 2026-10-03 (user: the
// bare-lines fog read as a hamburger menu, not weather) — every condition
// now carries a recognizable cloud/sun silhouette.
// Cloud silhouette path with a vertical offset (shared by several weather
// glyphs).
const cloudPath = (dy = 0) =>
  `M7 ${18 + dy}` +
  `C4.5 ${18 + dy} 3 ${16.3 + dy} 3 ${14.2 + dy}` +
  `C3 ${12.3 + dy} 4.4 ${10.8 + dy} 6.2 ${10.5 + dy}` +
  `C6.6 ${7.9 + dy} 8.7 ${6 + dy} 11.4 ${6 + dy}` +
  `C14.3 ${6 + dy} 16.6 ${8.1 + dy} 17 ${10.9 + dy}` +
  `C19.1 ${11.2 + dy} 20.7 ${12.9 + dy} 20.7 ${15 + dy}` +
  `C20.7 ${17.3 + dy} 18.8 ${18 + dy} 17.5 ${18 + dy}H7Z`;
const GLYPHS = {
  sun: (
    <>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12h2.5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
    </>
  ),
  cloud: <path d={cloudPath()} />,
  partly: (
    <>
      <circle cx="8.5" cy="7.5" r="3" />
      <path d="M8.5 2v1.5M2.5 7.5H4M4.3 3.3l1.1 1.1M12.7 3.3l-1.1 1.1" />
      <g transform="translate(2.2 4) scale(0.85)">
        <path d={cloudPath()} />
      </g>
    </>
  ),
  rain: (
    <>
      <path d={cloudPath(-2.5)} />
      <path d="M8 18.5l-1 3M12.5 18.5l-1 3M17 18.5l-1 3" />
    </>
  ),
  fog: (
    <>
      <path d={cloudPath(-3.5)} />
      <path d="M5.5 17.5h13M7.5 20.5h9" />
    </>
  ),
  snow: (
    <>
      <path d={cloudPath(-2.5)} />
      <circle cx="8" cy="19.5" r="0.4" fill="currentColor" />
      <circle cx="12.5" cy="21" r="0.4" fill="currentColor" />
      <circle cx="17" cy="19.5" r="0.4" fill="currentColor" />
    </>
  ),
  thunder: (
    <>
      <path d={cloudPath(-2.5)} />
      <path d="M12.5 15l-2.2 3.6h1.9l-1 3.2 3.8-4.5h-2.3l1.9-2.3" />
    </>
  ),
  home: (
    <path d="M4 11l8-7 8 7M6.5 9.5V20h11V9.5" />
  ),
  grid: (
    <>
      <path d="M12 3v18M8 21h8M9 3h6" />
      <path d="M7 8l5-3 5 3M7 8h10M7 8l2.5 5M17 8l-2.5 5M9.5 13h5M9.5 13L7 21M14.5 13L17 21" />
    </>
  ),
  battery: (
    <>
      <rect x="4" y="8" width="15" height="10" rx="2" />
      <path d="M22 11.5v3M7.5 11.5v3M11 11.5v3M14.5 11.5v3" />
    </>
  ),
  moon: (
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
  ),
};

// WMO weathercode → glyph (same mapping the day-brief prompt documents).
export function weatherGlyphName(code) {
  if (code == null) return "partly";
  if (code >= 95) return "thunder";
  if (code >= 71) return "snow";
  if (code >= 51) return "rain";
  if (code >= 45) return "fog";
  if (code >= 2) return "partly";
  return "sun";
}

export default function Glyph({ name, size = 18, className }) {
  const body = GLYPHS[name];
  if (!body) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {body}
    </svg>
  );
}
