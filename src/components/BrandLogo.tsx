import React from "react";

/**
 * BharatTube app logo — an original recreation of the brand mark:
 * a rounded dark tile with a glowing red→orange outlined play triangle and
 * an inner amber play arrow. Pure inline SVG so it stays crisp at any size,
 * works in light/dark, and needs no image asset.
 */
export function BrandLogo({
  size = 28,
  className = "",
  rounded,
  title = "BharatTube",
}: {
  /** Rendered width/height in px. */
  size?: number;
  className?: string;
  /** Corner radius override; defaults to a squircle proportion. */
  rounded?: number;
  title?: string;
}) {
  const r = rounded ?? Math.round(size * 0.24);
  const uid = React.useId().replace(/[:]/g, "");

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      role="img"
      aria-label={title}
      className={className}
    >
      <defs>
        {/* Dark tile gradient */}
        <linearGradient id={`tile-${uid}`} x1="18" y1="14" x2="86" y2="90" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2a2016" />
          <stop offset="0.45" stopColor="#1a1712" />
          <stop offset="1" stopColor="#0c0c0c" />
        </linearGradient>
        {/* Outer play triangle: orange top -> red bottom */}
        <linearGradient id={`play-${uid}`} x1="34" y1="20" x2="70" y2="82" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff8a1e" />
          <stop offset="0.35" stopColor="#ff5a1a" />
          <stop offset="1" stopColor="#e01f16" />
        </linearGradient>
        {/* Inner arrow: amber */}
        <linearGradient id={`arrow-${uid}`} x1="46" y1="38" x2="62" y2="62" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffc042" />
          <stop offset="1" stopColor="#ff8a1e" />
        </linearGradient>
        {/* Warm glow around the mark */}
        <radialGradient id={`glow-${uid}`} cx="42" cy="34" r="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff6a1a" stopOpacity="0.45" />
          <stop offset="1" stopColor="#ff6a1a" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Tile */}
      <rect x="6" y="6" width="88" height="88" rx={Math.round((r / size) * 88)} fill={`url(#tile-${uid})`} />
      {/* Top-left rim highlight */}
      <rect
        x="6.75"
        y="6.75"
        width="86.5"
        height="86.5"
        rx={Math.round((r / size) * 88)}
        fill="none"
        stroke={`url(#glow-${uid})`}
        strokeWidth="1.5"
      />

      {/* Outer rounded play triangle (chunky ring) */}
      <path
        d="M36 24
           C33 22.4 29.5 24.2 29.5 27.8
           V72.2
           C29.5 75.8 33 77.6 36 76
           L76 55.4
           C79.2 53.7 79.2 46.3 76 44.6
           Z"
        fill="none"
        stroke={`url(#play-${uid})`}
        strokeWidth="9.5"
        strokeLinejoin="round"
      />

      {/* Inner amber play arrow */}
      <path
        d="M47 40.5
           C45.6 39.7 44 40.7 44 42.3
           V57.7
           C44 59.3 45.6 60.3 47 59.5
           L61 51.8
           C62.5 51 62.5 49 61 48.2
           Z"
        fill={`url(#arrow-${uid})`}
        stroke="#c23a12"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
