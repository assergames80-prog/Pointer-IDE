export default function Logo({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="Pointer">
      <defs>
        <linearGradient id="pointer-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6aa8ff" />
          <stop offset="1" stopColor="#7c5cff" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#pointer-g)" />
      <path
        d="M21 15 L46 33.5 L35 35.6 L41.5 48.6 L35.8 51.4 L29.3 38.3 L21 45.5 Z"
        fill="#fff"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
