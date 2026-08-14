interface LibTvLogoProps {
  size?: number
  className?: string
}

export function LibTvLogo({ size = 18, className = '' }: LibTvLogoProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M13 2.5L4.5 13.5H11.5L9.5 21.5L19.5 10.5H12.5L14.5 2.5Z" />
    </svg>
  )
}
