import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import ApplicationRoot from './Root.tsx'
import { installAnimationFrameResizeObserver } from './resizeObserverScheduler'

installAnimationFrameResizeObserver()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApplicationRoot />
  </StrictMode>,
)
