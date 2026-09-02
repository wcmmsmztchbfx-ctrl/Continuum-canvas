interface LibTvLogoProps {
  size?: number
  className?: string
  strokeWidth?: number
}

export function LibTvLogo({ size = 20, className = '', strokeWidth = 1.75 }: LibTvLogoProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M7 3.5H17.5L14 8.5H19.5L12 21.5L13 15H6.5L9.5 9.5H4L7 3.5Z" />
    </svg>
  )
}
