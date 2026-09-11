import { LoaderCircle } from 'lucide-react'

export function GenerationOverlay() {
  return (
    <div className="canvas-generation-overlay nopan" role="status">
      <LoaderCircle aria-hidden="true" size={28} strokeWidth={1.7} />
      <span>生成中</span>
      <div className="canvas-generation-overlay__track">
        <i />
      </div>
    </div>
  )
}
