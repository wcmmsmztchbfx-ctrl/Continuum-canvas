import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, FlipHorizontal2, FlipVertical2, RotateCw, X } from 'lucide-react'
import { calculateImageEditorGeometry } from './imageEditorGeometry'

export interface ImageEditorModalProps {
  name: string
  url: string
  onCancel(): void
  onSave(blob: Blob): Promise<void>
}

export interface ImageEditorWorkspaceProps extends ImageEditorModalProps {
  onDirtyChange?(dirty: boolean): void
  embedded?: boolean
  registerSave?(save: () => void): () => void
}

const ratios = ['自由', '原图', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'] as const

export function ImageEditorWorkspace({ name, url, onCancel, onSave, onDirtyChange, embedded = true, registerSave }: ImageEditorWorkspaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const drawing = useRef(false)
  const [rotation, setRotation] = useState(0)
  const [flipX, setFlipX] = useState(1)
  const [flipY, setFlipY] = useState(1)
  const [ratio, setRatio] = useState<(typeof ratios)[number]>('自由')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [imageReady, setImageReady] = useState(0)
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])
  const save = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || saving) return
    setSaving(true)
    canvas.toBlob((blob) => {
      if (!blob) { setSaving(false); return }
      void onSave(blob).then(() => { setDirty(false) }).finally(() => setSaving(false))
    }, 'image/png')
  }, [onSave, saving])
  useEffect(() => registerSave?.(save), [registerSave, save])

  const redraw = useCallback(() => {
    const image = imageRef.current
    const canvas = canvasRef.current
    if (!image || !canvas) return
    const parsed = ratio.includes(':') ? ratio.split(':').map(Number) : undefined
    const geometry = calculateImageEditorGeometry({
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      targetRatio: parsed ? parsed[0]! / parsed[1]! : undefined,
      rotation,
    })
    canvas.width = geometry.canvas.width
    canvas.height = geometry.canvas.height
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate(rotation * Math.PI / 180)
    ctx.scale(flipX, flipY)
    ctx.drawImage(image,
      (image.naturalWidth - geometry.source.width) / 2,
      (image.naturalHeight - geometry.source.height) / 2,
      geometry.source.width,
      geometry.source.height,
      -geometry.draw.width / 2,
      -geometry.draw.height / 2,
      geometry.draw.width,
      geometry.draw.height,
    )
    ctx.restore()
  }, [flipX, flipY, ratio, rotation])

  useEffect(() => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => { imageRef.current = image; setImageReady((value) => value + 1) }
    image.src = url
  }, [url])
  useEffect(redraw, [imageReady, redraw])

  const pointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget
    const bounds = canvas.getBoundingClientRect()
    return { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height }
  }

  const editor = <section className="image-editor" data-embedded={embedded || undefined}>
      {!embedded ? <header><strong>编辑图片</strong><button aria-label="关闭" onClick={() => !dirty || confirm('放弃未保存的编辑？') ? onCancel() : undefined} type="button"><X /></button></header> : null}
      <div className="image-editor__toolbar">
        <select aria-label="裁剪比例" value={ratio} onChange={(event) => { setRatio(event.target.value as typeof ratio); setDirty(true) }}>{ratios.map((value) => <option key={value}>{value}</option>)}</select>
        <button onClick={() => { setRotation((value) => (value + 90) % 360); setDirty(true) }} type="button"><RotateCw />旋转</button>
        <button onClick={() => { setFlipX((value) => -value); setDirty(true) }} type="button"><FlipHorizontal2 />水平翻转</button>
        <button onClick={() => { setFlipY((value) => -value); setDirty(true) }} type="button"><FlipVertical2 />垂直翻转</button>
        <span>直接在画面上拖动进行画笔批注</span>
      </div>
      <div className="image-editor__stage"><canvas ref={canvasRef}
        onPointerDown={(event) => { drawing.current = true; event.currentTarget.setPointerCapture(event.pointerId); const p = pointer(event); const ctx = event.currentTarget.getContext('2d')!; ctx.beginPath(); ctx.moveTo(p.x, p.y) }}
        onPointerMove={(event) => { if (!drawing.current) return; const p = pointer(event); const ctx = event.currentTarget.getContext('2d')!; ctx.strokeStyle = '#ff4d4f'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineTo(p.x, p.y); ctx.stroke(); setDirty(true) }}
        onPointerUp={() => { drawing.current = false }} /></div>
      <footer><button onClick={onCancel} type="button">取消</button><button disabled={saving} onClick={save} type="button"><Check />{saving ? '保存中' : '保存新版本'}</button></footer>
    </section>
  return embedded ? editor : <div className="image-editor-backdrop" role="dialog" aria-modal="true" aria-label={`编辑 ${name}`}>{editor}</div>
}

export function ImageEditorModal(props: ImageEditorModalProps) {
  return <ImageEditorWorkspace {...props} embedded={false} />
}
