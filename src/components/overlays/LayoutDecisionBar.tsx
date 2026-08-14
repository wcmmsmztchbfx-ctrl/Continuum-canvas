interface LayoutDecisionBarProps {
  onKeep: () => void
  onRestore: () => void
  open: boolean
}

export function LayoutDecisionBar({
  onKeep,
  onRestore,
  open,
}: LayoutDecisionBarProps) {
  if (!open) return null

  return (
    <div
      aria-label="自动布局确认"
      className="overlay-surface layout-decision-bar"
      role="status"
    >
      <span>是否保留此次整理结果？</span>
      <button onClick={onRestore} type="button">还原</button>
      <button className="layout-decision-bar__keep" onClick={onKeep} type="button">
        保留
      </button>
    </div>
  )
}

export type { LayoutDecisionBarProps }
