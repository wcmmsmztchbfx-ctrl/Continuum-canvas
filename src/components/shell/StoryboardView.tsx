import { FileText, Image, Plus, Video } from 'lucide-react'

export interface StoryboardNodeSummary {
  id: string
  name: string
  type: string
}

export interface StoryboardViewProps {
  nodes: ReadonlyArray<StoryboardNodeSummary>
  onSelectNode?: (nodeId: string) => void
  open: boolean
}

const sections = [
  { type: 'text', label: '文本', icon: FileText },
  { type: 'image', label: '图片', icon: Image },
  { type: 'video', label: '视频', icon: Video },
] as const

export function StoryboardView({ nodes, onSelectNode, open }: StoryboardViewProps) {
  if (!open) return null
  return (
    <section aria-label="故事板视图" className="storyboard-view">
      <header><div><strong>故事板</strong><span>{nodes.length} 个节点</span></div><button type="button"><Plus aria-hidden="true" />添加参考</button></header>
      <div className="storyboard-view__sections">
        {sections.map(({ type, label, icon: Icon }) => {
          const items = nodes.filter((node) => node.type === type)
          return (
            <section key={type}>
              <h2><Icon aria-hidden="true" />{label}<span>{items.length}</span></h2>
              <div className="storyboard-view__list">
                {items.length === 0 ? <p>暂无{label}节点</p> : items.map((node, index) => (
                  <button key={node.id} onClick={() => onSelectNode?.(node.id)} type="button"><span>{String(index + 1).padStart(2, '0')}</span><strong>{node.name}</strong></button>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </section>
  )
}
