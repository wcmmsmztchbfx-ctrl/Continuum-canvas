export function createCanvasDiagnostics(enabled: boolean) {
  let counters: Record<string, number> = {}
  return {
    increment(name: string, amount = 1): void {
      if (enabled) counters[name] = (counters[name] ?? 0) + amount
    },
    snapshot(): Readonly<Record<string, number>> { return { ...counters } },
    reset(): void { counters = {} },
  }
}
export const canvasDiagnostics = createCanvasDiagnostics(import.meta.env?.VITE_CANVAS_DIAGNOSTICS === '1')
if (typeof window !== 'undefined' && import.meta.env?.VITE_CANVAS_DIAGNOSTICS === '1') {
  ;(window as unknown as { __canvasDiagnostics: typeof canvasDiagnostics }).__canvasDiagnostics = canvasDiagnostics
}
