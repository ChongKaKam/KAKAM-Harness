export function ExtensionIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2.5 15.5 6 12 9.5 8.5 6 12 2.5Z" />
      <path d="M5.5 9 9 12.5 5.5 16 2 12.5 5.5 9Z" />
      <path d="M18.5 9 22 12.5 18.5 16 15 12.5 18.5 9Z" />
      <path d="M12 15.5 15.5 19 12 22.5 8.5 19 12 15.5Z" />
    </svg>
  );
}
