import type { ReactElement } from 'react'
import type { NodeProps } from '@xyflow/react'
import { ReactFlowProvider } from '@xyflow/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { EmptyMediaPlaceholder } from './EmptyMediaPlaceholder'
import { GroupNode } from './GroupNode'
import { ImageNode } from './ImageNode'
import type { CanvasFlowNode, CanvasFlowNodeData } from './mapping'
import { SpecialNode } from './SpecialNode'
import { VideoNode } from './VideoNode'

function nodeProps(
  type: 'image' | 'video',
  data: CanvasFlowNodeData,
): NodeProps<CanvasFlowNode> {
  return {
    id: `${type}-test`,
    type,
    data,
    width: 622,
    height: 350,
    selected: false,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
    zIndex: 0,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  }
}

function markup(node: ReactElement) {
  return renderToStaticMarkup(<ReactFlowProvider>{node}</ReactFlowProvider>)
}

describe('media canvas nodes', () => {
  it('renders an image using fixture media data', () => {
    const html = markup(
      <ImageNode
        {...nodeProps('image', {
          name: '图片节点',
          mediaType: 'image',
          url: 'https://assets.example/image.png',
          alt: '参考图',
        })}
      />,
    )

    expect(html).toContain('src="https://assets.example/image.png"')
    expect(html).toContain('alt="参考图"')
    expect(html).toContain('data-node-kind="image"')
    expect(html).toContain('aria-label="重命名 图片节点"')
    expect(html).toContain('aria-label="下载图片 图片节点"')
    expect(html).toContain('download="图片节点.png"')
    expect(html).toContain('data-handleid="target"')
    expect(html).toContain('data-handleid="source"')
  })

  it('renders a dedicated empty state when media is missing', () => {
    const imageHtml = markup(
      <ImageNode
        {...nodeProps('image', {
          name: '空图片',
          mediaType: 'image',
          url: '',
        })}
      />,
    )
    const videoHtml = markup(<EmptyMediaPlaceholder kind="video" />)

    expect(imageHtml).toContain('data-testid="empty-image-placeholder"')
    expect(imageHtml).toContain('暂无图片')
    expect(videoHtml).toContain('data-testid="empty-video-placeholder"')
    expect(videoHtml).toContain('暂无视频')
  })

  it('renders a canvas-safe video control without autoplay', () => {
    const html = markup(
      <VideoNode
        {...nodeProps('video', {
          name: '视频节点',
          mediaType: 'video',
          url: 'https://assets.example/video.mp4',
          poster: 'https://assets.example/poster.jpg',
        })}
      />,
    )

    expect(html).toContain('src="https://assets.example/video.mp4"')
    expect(html).toContain('poster="https://assets.example/poster.jpg"')
    expect(html).toContain('preload="metadata"')
    expect(html).toContain('aria-label="播放视频"')
    expect(html).toContain('aria-label="下载视频 视频节点"')
    expect(html).toContain('download="视频节点.mp4"')
    expect(html).not.toContain('controls=""')
    expect(html).not.toContain('autoplay')
    expect(html).toContain('data-node-kind="video"')
  })

  it('opens the original-style image generator when the node is selected', () => {
    const html = markup(
      <ImageNode
        {...{
          ...nodeProps('image', {
            name: '图片节点',
            mediaType: 'image',
            url: 'https://assets.example/image.png',
          }),
          selected: true,
        }}
      />,
    )

    expect(html).toContain('data-node-editor="image"')
    expect(html).toContain('aria-label="图片生成描述"')
    expect(html).not.toContain('>编辑图片<')
    expect(html).not.toContain('>标记<')
    expect(html).toContain('canvas-node-handle__hit')
    expect(html).not.toContain('react-flow__resize-control')
  })

  it('keeps generation and image editing in one selected-node panel', () => {
    const html = markup(
      <ImageNode
        {...{
          ...nodeProps('image', {
            name: '可编辑图片',
            mediaType: 'image',
            url: 'https://assets.example/image.png',
            imagePanelMode: 'generate',
            imageEditorContent: <div data-testid="embedded-image-editor" />,
          }),
          selected: true,
        }}
      />,
    )

    expect(html).toContain('aria-label="图片操作模式"')
    expect(html).toContain('>生成<')
    expect(html).toContain('>编辑<')
    expect(html).not.toContain('canvas-media-actions')
  })

  it('opens video-specific controls when the video node is selected', () => {
    const html = markup(
      <VideoNode
        {...{
          ...nodeProps('video', {
            name: '视频节点',
            mediaType: 'video',
            url: '',
          }),
          selected: true,
        }}
      />,
    )

    expect(html).not.toContain('>特效<')
    expect(html).not.toContain('>角色库<')
    expect(html).not.toContain('>运镜<')
    expect(html).toContain('react-flow__resize-control')
  })

  it('keeps per-node editors and resize handles closed during multi-selection', () => {
    const imageHtml = markup(
      <ImageNode
        {...{
          ...nodeProps('image', {
            isSoleSelection: false,
            name: '多选图片',
            mediaType: 'image',
            url: 'https://assets.example/image.png',
          }),
          selected: true,
        }}
      />,
    )
    const videoHtml = markup(
      <VideoNode
        {...{
          ...nodeProps('video', {
            isSoleSelection: false,
            name: '多选视频',
            mediaType: 'video',
            url: 'https://assets.example/video.mp4',
          }),
          selected: true,
        }}
      />,
    )

    expect(imageHtml).not.toContain('data-node-editor="image"')
    expect(videoHtml).not.toContain('data-node-editor="video"')
    expect(videoHtml).not.toContain('react-flow__resize-control')
  })

  it('keeps persistent groups movable but not resizable', () => {
    const html = markup(
      <GroupNode
        {...({
          ...nodeProps('image', {
            name: '镜头分组',
            mediaType: 'group',
            url: '',
          }),
          id: 'group-test',
          type: 'group',
          selected: true,
        } as NodeProps<CanvasFlowNode>)}
      />,
    )

    expect(html).toContain('canvas-group-node')
    expect(html).not.toContain('react-flow__resize-control')
  })

  it.each([
    ['audio', '描述需要生成的音乐或声音'],
    ['script', '新建脚本内容'],
    ['director', '打开导演台'],
    ['video-clip', '空空如也，请连接视频节点后操作'],
  ] as const)('renders the dedicated %s node surface', (type, text) => {
    const html = markup(
      <SpecialNode
        {...({
          ...nodeProps('image', {
            name:
              type === 'director'
                ? '导演台'
                : type === 'video-clip'
                  ? '视频合成'
                  : type === 'audio'
                    ? '音频节点'
                    : '脚本节点',
            mediaType: type === 'director' || type === 'video-clip' ? 'group' : 'text',
            text: '',
            url: '',
          }),
          type,
          selected: true,
        } as NodeProps<CanvasFlowNode>)}
      />,
    )

    expect(html).toContain(`data-node-kind="${type}"`)
    expect(html).toContain(text)
  })
})
