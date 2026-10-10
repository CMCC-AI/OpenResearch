export function BrandMark() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="24" fill="#006eb8" />
      <path
        d="M72 29H42c-20 0-20 21 0 21h16c20 0 20 21 0 21H28"
        fill="none"
        stroke="#fff"
        strokeWidth="11"
        strokeLinecap="round"
      />
    </svg>
  );
}

// SONA wordmark: logo mark + name, sized by the parent's font-size.
// Single source for the brand lockup (home and onboarding).
export function Wordmark() {
  return (
    <span className="wordmark inline-flex items-center gap-[0.4em] text-text [&_svg]:w-[1em] [&_svg]:h-[1em] [&_svg]:shrink-0">
      <BrandMark />
      SONA
    </span>
  );
}
