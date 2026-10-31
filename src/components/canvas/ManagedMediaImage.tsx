import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import { useMediaResource } from './useMediaResource'
import type { MediaVariant } from './canvasMediaDemand'
/** Offscreen sidebar thumbnails share resource admission with canvas images. */
export function ManagedMediaImage({ src, variant = 128, onLoad, onError, ...props }: ImgHTMLAttributes<HTMLImageElement> & { variant?: MediaVariant }) {
  const ref = useRef<HTMLImageElement>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '200px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const media = useMediaResource({ url: src ?? '' }, variant, visible ? 'visible' : 'none')
  return <img {...props} key={media.bindingKey} ref={ref} src={media.displayUrl} onLoad={event => { media.onLoad(); onLoad?.(event) }} onError={event => { media.onError(); onError?.(event) }} />
}
