// Minimal stroke-based glyphs (2026-10-03, user request: "more spartan,
// more abstract" — emoji render platform-dependently and clash with the
// app's flat style; same reasoning as StateIcon.jsx's MDI paths). All are
// 24×24, stroke: currentColor, no fill — they inherit the surrounding
// text color and weight.
const GLYPHS = {
  sun: (
    <>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12h2.5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
    </>
  ),
  // cloud base shared by several weather glyphs
  cloud: (
    <path d="M6.5 18.5a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 16.6 9.6 3.6 3.6 0 0 1 17.8 16.7c-.4 1-.9 1.8-1.8 1.8H6.5z" />
  ),
  partly: (
    <>
      <circle cx="8.5" cy="8" r="3" />
      <path d="M8.5 2.5V4M2.5 8h1.5M4.3 3.8l1 1" />
      <path d="M9.5 19.5a3.6 3.6 0 0 1-.5-7.15 4.9 4.9 0 0 1 9.6-.8 3.2 3.2 0 0 1 1 6.35c-.3.9-.8 1.6-1.6 1.6H9.5z" />
    </>
  ),
  rain: (
    <>
      <path d="M6.5 15.5a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 16.6 6.6a3.6 3.6 0 0 1 1.2 7.1c-.4 1-.9 1.8-1.8 1.8H6.5z" />
      <path d="M8 18l-1 3M12.5 18l-1 3M17 18l-1 3" />
    </>
  ),
  fog: (
    <path d="M4 8h16M6 12h12M4 16h16M7 20h10" />
  ),
  snow: (
    <>
      <path d="M6.5 15.5a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 16.6 6.6a3.6 3.6 0 0 1 1.2 7.1c-.4 1-.9 1.8-1.8 1.8H6.5z" />
      <path d="M8 18.5v.5M12.5 18.5v.5M17 18.5v.5" />
    </>
  ),
  thunder: (
    <>
      <path d="M6.5 15.5a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 16.6 6.6a3.6 3.6 0 0 1 1.2 7.1c-.4 1-.9 1.8-1.8 1.8h-4" />
      <path d="M12 14l-2.5 4h2l-1 3.5 4-5h-2.5l2-2.5" />
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
