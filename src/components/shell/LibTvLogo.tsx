interface LibTvLogoProps {
  size?: number
  className?: string
  variant?: 'color' | 'outline'
}

export function LibTvLogo({ size = 24, className = '', variant = 'color' }: LibTvLogoProps) {
  if (variant === 'outline') {
    return (
      <svg
        aria-hidden="true"
        className={`continuum-logo ${className}`.trim()}
        fill="none"
        focusable="false"
        height={size}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.35}
        viewBox="0 0 24 24"
        width={size}
      >
        <path d="M8.1 18.3H4.5A1.5 1.5 0 0 1 3 16.8V4.5A1.5 1.5 0 0 1 4.5 3h13.8l-4.8 4.8H7.8v5.7L3 18.3" />
        <path d="M15.9 5.7h3.6A1.5 1.5 0 0 1 21 7.2v12.3a1.5 1.5 0 0 1-1.5 1.5H5.7l4.8-4.8h5.7v-5.7L21 5.7" />
      </svg>
    )
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className={`continuum-logo ${className}`.trim()}
      draggable={false}
      height={size}
      src="/continuum-logo.svg?v=canvas-blue-wide-v1"
      width={size}
    />
  )
}
