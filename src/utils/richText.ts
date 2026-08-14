export function sanitizeTextHtml(html: string): string {
  if (!html) return ''
  if (!/<[a-z][\s\S]*>/i.test(html)) return html

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const body = doc.body

    // Flatten deeply nested spans (e.g. from repetitive drag operations)
    let changed = true
    let safetyCounter = 0
    while (changed && safetyCounter < 50) {
      safetyCounter++
      changed = false
      const spans = body.querySelectorAll('span')
      for (const span of Array.from(spans)) {
        if (span.children.length === 1 && span.firstElementChild?.tagName === 'SPAN') {
          const inner = span.firstElementChild as HTMLElement
          const parentStyle = span.getAttribute('style') || ''
          const innerStyle = inner.getAttribute('style') || ''
          span.setAttribute('style', `${parentStyle}; ${innerStyle}`)
          span.innerHTML = inner.innerHTML
          changed = true
        }
      }
    }

    // Clean up temporary attributes
    body.querySelectorAll('[data-active-span]').forEach((el) => {
      el.removeAttribute('data-active-span')
    })

    return body.innerHTML
  } catch {
    return html
  }
}

export function applyStyleToRange(
  container: HTMLElement,
  style: Partial<{ fontSize: number; fontWeight: number; color: string; letterSpacing: number; lineHeight: number }>,
): string {
  let activeSpan = container.querySelector<HTMLElement>('[data-active-span="true"]')

  if (!activeSpan) {
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      if (container.contains(range.commonAncestorContainer)) {
        const parentSpan = range.commonAncestorContainer.parentElement?.closest('span')
        if (parentSpan && container.contains(parentSpan) && parentSpan.textContent === range.toString()) {
          activeSpan = parentSpan
          activeSpan.setAttribute('data-active-span', 'true')
        } else {
          const span = document.createElement('span')
          span.setAttribute('data-active-span', 'true')
          try {
            const extracted = range.extractContents()
            span.appendChild(extracted)
            range.insertNode(span)
            activeSpan = span
            const newRange = document.createRange()
            newRange.selectNodeContents(span)
            selection.removeAllRanges()
            selection.addRange(newRange)
          } catch {}
        }
      }
    }
  }

  if (activeSpan) {
    if (style.fontSize !== undefined) activeSpan.style.fontSize = `${style.fontSize}px`
    if (style.fontWeight !== undefined) activeSpan.style.fontWeight = String(style.fontWeight)
    if (style.color !== undefined) activeSpan.style.color = style.color
    if (style.letterSpacing !== undefined) activeSpan.style.letterSpacing = `${style.letterSpacing}px`
    if (style.lineHeight !== undefined) activeSpan.style.lineHeight = String(style.lineHeight)
  }

  return sanitizeTextHtml(container.innerHTML)
}
