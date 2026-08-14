import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import ApplicationRoot from './Root.tsx'
import { GenerationApprovalProvider } from './components/providers/GenerationApprovalContext'
import { ProviderCatalogProvider } from './components/providers/ProviderCatalogContext'
import { installAnimationFrameResizeObserver } from './resizeObserverScheduler'

installAnimationFrameResizeObserver()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProviderCatalogProvider>
      <GenerationApprovalProvider>
        <ApplicationRoot />
      </GenerationApprovalProvider>
    </ProviderCatalogProvider>
  </StrictMode>,
)
