import { Component, Suspense, lazy, useMemo, useState, type ComponentType, type ReactNode } from 'react'
class PanelBoundary extends Component<{ children: ReactNode; retry(): void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed ? <div role="alert">工具加载失败 <button onClick={this.props.retry} type="button">重试加载</button></div> : this.props.children
  }
}
export function createDeferredPanel<P extends object>(label: string, loader: () => Promise<{ default: ComponentType<P> }>) {
  let loaded: ComponentType<P> | undefined
  let pending: Promise<{ default: ComponentType<P> }> | undefined
  const preload = () => pending ??= loader().then(module => { loaded = module.default; return module })
  function DeferredPanel(props: P) {
    const [attempt, setAttempt] = useState(0)
    const Lazy = useMemo(() => lazy(preload), [attempt])
    // Lock the initial path so lazy resolution cannot remount an edited panel.
    const [Ready] = useState(() => loaded)
    if (Ready) return <Ready {...props} />
    return <PanelBoundary key={attempt} retry={() => { pending = undefined; setAttempt(value => value + 1) }}>
      <Suspense fallback={<div role="status" aria-busy="true">正在加载{label}…</div>}><Lazy {...props} /></Suspense>
    </PanelBoundary>
  }
  return { Component: DeferredPanel, preload }
}
