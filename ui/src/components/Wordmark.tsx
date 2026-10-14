export function BrandMark() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="24" fill="#006eb8" />
      <path
        d="M27 73V28L50 54L73 28V73"
        fill="none"
        stroke="#fff"
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
