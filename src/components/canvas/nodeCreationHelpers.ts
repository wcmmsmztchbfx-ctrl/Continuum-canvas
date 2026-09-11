import type { CanvasNode, NodeSize, Point } from '../../model/project'
import type { ConnectedNodeKind } from './ConnectedNodeMenu'

export function getPointerPosition(event: MouseEvent | TouchEvent): Point | null {
  if ('clientX' in event) {
    return { x: event.clientX, y: event.clientY }
  }

  const touch = event.changedTouches[0]
  return touch ? { x: touch.clientX, y: touch.clientY } : null
}

export function connectedNodeSize(kind: ConnectedNodeKind): NodeSize {
  if (kind === 'image') return { width: 480, height: 320 }
  if (kind === 'video') return { width: 480, height: 270 }
  if (kind === 'director') return { width: 540, height: 700 }
  return { width: 350, height: 350 }
}

export function createConnectedNode(
  kind: ConnectedNodeKind | 'image' | 'video' | 'text',
  id: string,
  position: Point,
): CanvasNode {
  if (kind === 'image') {
    return {
      id,
      type: 'image',
      name: '图片节点',
      position,
      size: { width: 480, height: 320 },
      data: { url: '', alt: '待生成图片' },
    }
  }

  if (kind === 'video') {
    return {
      id,
      type: 'video',
      name: '视频节点',
      position,
      size: { width: 480, height: 270 },
      data: { url: '' },
    }
  }

  if (kind === 'director') {
    return {
      id,
      type: 'group',
      name: '导演台',
      position,
      size: { width: 540, height: 700 },
      data: { childIds: [], nodeKind: 'director', url: '' },
    }
  }

  const name = kind === 'audio' ? '音频节点' : kind === 'script' ? '脚本节点' : '文本节点'
  return {
    id,
    type: 'text',
    name,
    position,
    size: { width: 350, height: 350 },
    data: {
      text: kind === 'audio' ? '描述需要生成的音乐或声音' : '',
      nodeKind:
        kind === 'audio' ? 'audio' : kind === 'script' ? 'script' : 'text',
    },
  }
}

export function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const rightIds = new Set(right)
  return rightIds.size === right.length && left.every((id) => rightIds.has(id))
}
