import { useId } from "react";

// MobileSci brand mark: the 九天 logo from assets/workbench/brand.svg,
// inlined as an svg so wordmark lockups can keep sizing it via [&_svg] rules.
export function BrandMark() {
  const id = useId().replace(/:/g, "");
  const leftLegId = `${id}-leftLeg`;
  const topCapId = `${id}-topCap`;
  const rightRibbonId = `${id}-rightRibbon`;
  return (
    <svg viewBox="0 0 40 40" fill="none" aria-hidden="true" className="h-full w-full">
      <defs>
        <linearGradient id={leftLegId} x1="4.8" y1="10.6" x2="4.8" y2="33" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00A3FF" />
          <stop offset="1" stopColor="#00C6FF" />
        </linearGradient>
        <linearGradient id={topCapId} x1="2" y1="9" x2="30.4" y2="6" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00C8FF" />
          <stop offset="0.55" stopColor="#00B2FF" />
          <stop offset="1" stopColor="#009EFF" />
        </linearGradient>
        <linearGradient id={rightRibbonId} x1="19.5" y1="26" x2="36" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00BCD3" />
          <stop offset="0.32" stopColor="#00D3A1" />
          <stop offset="0.7" stopColor="#48D45C" />
          <stop offset="1" stopColor="#73D238" />
        </linearGradient>
      </defs>
      <path d="M2 10.4L7.6 13.5V33L2 29.8V10.4Z" fill={`url(#${leftLegId})`} />
      <path d="M2 10.6L20 0.2L30.4 6.1V7.1L20 13.1L12.2 8.7L7.6 13.8L2 10.6Z" fill={`url(#${topCapId})`} />
      <path d="M13 16.9L20.2 21V39.8L13 35.8V16.9Z" fill="#00B4FF" />
      <path d="M20 21L26.8 17.1V27.8L32.6 24.4V8.8L34.4 7.4L38 9.5V29.4L20 39.8V21Z" fill={`url(#${rightRibbonId})`} />
    </svg>
  );
}

// MobileSci wordmark: logo mark + name, sized by the parent's font-size.
// Single source for the brand lockup (home and onboarding).
export function Wordmark() {
  return (
    <span className="wordmark inline-flex items-center gap-[0.4em] text-text [&_svg]:w-[1em] [&_svg]:h-[1em] [&_svg]:shrink-0">
      <BrandMark />
      MobileSci
    </span>
  );
}
