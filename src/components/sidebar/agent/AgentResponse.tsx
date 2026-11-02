import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

interface Props { text: string; animate?: boolean; onProgress?: () => void }
export function AgentResponse({ text, animate = false, onProgress }: Props) {
  const segments = useMemo(() => typeof Intl.Segmenter === 'function' ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment) : Array.from(text), [text])
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  const [frame, setFrame] = useState({ text, count: animate && !reduced ? 0 : segments.length })
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const progress = useRef(onProgress); progress.current = onProgress
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return
    const change = () => setReduced(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    if (!animate || reduced) { setFrame({ text, count: segments.length }); return }
    let count = 0
    setFrame({ text, count })
    // Short answers advance one grapheme at a time. Long replies catch up in
    // bounded time instead of making a complete answer take minutes to read.
    const step = Math.max(1, Math.ceil(segments.length / 400))
    timer.current = setInterval(() => {
      count = Math.min(segments.length, count + step); setFrame({ text, count })
      if (count === segments.length) { clearInterval(timer.current); timer.current = undefined }
    }, 20)
    return () => { clearInterval(timer.current); timer.current = undefined }
  }, [text, animate, reduced, segments])
  const count = !animate || reduced ? segments.length : frame.text === text ? frame.count : 0
  useLayoutEffect(() => { progress.current?.() }, [count, text])
  const typing = count < segments.length
  if (!animate || reduced) return <p className="agent-runtime-response">{text}</p>
  return <p className="agent-runtime-response" data-typing={typing ? 'true' : 'false'}>
    <span className="agent-response-accessible">{text}</span>
    <span aria-hidden="true" data-agent-visible-text="">{segments.slice(0, count).join('')}</span>
    {typing && <><span className="agent-response-cursor" aria-hidden="true" /><button type="button" className="agent-response-show-all" onClick={() => { clearInterval(timer.current); timer.current = undefined; setFrame({ text, count: segments.length }) }}>显示全文</button></>}
  </p>
}
