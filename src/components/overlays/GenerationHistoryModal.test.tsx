// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  GenerationHistoryEntry,
  GenerationHistoryPage,
} from '../../contracts/generation'
import { GenerationHistoryModal } from './GenerationHistoryModal'

const makeEntry = (
  idCharacter: string,
  mediaType: GenerationHistoryEntry['mediaType'],
  completedAt: string,
): GenerationHistoryEntry => {
  const extension = mediaType === 'image' ? 'png' : mediaType === 'video' ? 'mp4' : 'mp3'
  const contentType = mediaType === 'image' ? 'image/png' : mediaType === 'video' ? 'video/mp4' : 'audio/mpeg'
  const assetId = `${idCharacter.repeat(8)}-${idCharacter.repeat(4)}-4${idCharacter.repeat(3)}-8${idCharacter.repeat(3)}-${idCharacter.repeat(12)}`
  return {
    id: idCharacter.repeat(64),
    projectId: 'project-one',
    jobId: `${idCharacter.repeat(8)}-${idCharacter.repeat(4)}-4${idCharacter.repeat(3)}-8${idCharacter.repeat(3)}-${idCharacter.repeat(12)}`,
    outputIndex: 0,
    mediaType,
    asset: {
      id: assetId,
      filename: `${mediaType}-${idCharacter}.${extension}`,
      contentType,
      size: 1024,
      url: `/api/assets/${assetId}`,
      createdAt: completedAt,
    },
    prompt: `${mediaType} prompt ${idCharacter}`,
    providerId: 'aistartlab',
    channel: 46,
    model: `${mediaType}-model`,
    settings: mediaType === 'video'
      ? { quality: '720P', aspectRatio: '16:9', duration: 6 }
      : { quality: '2K', aspectRatio: '9:16' },
    references: [],
    completedAt,
  }
}

const newestImage = makeEntry('a', 'image', '2026-07-17T09:00:00.000Z')
const olderImage = makeEntry('b', 'image', '2026-07-16T09:00:00.000Z')
const video = makeEntry('c', 'video', '2026-07-15T09:00:00.000Z')

function createClient(pages: GenerationHistoryPage[] = [{ entries: [newestImage, olderImage] }]) {
  return {
    listGenerationHistory: vi.fn().mockImplementation(async () => pages.shift() ?? { entries: [] }),
    deleteGenerationHistoryEntry: vi.fn().mockResolvedValue(undefined),
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('GenerationHistoryModal', () => {
  it('loads project-scoped history, groups by date, switches media tabs, and sorts locally', async () => {
    const client = createClient([
      { entries: [olderImage, newestImage] },
      { entries: [video] },
    ])
    render(
      <GenerationHistoryModal
        client={client}
        onClose={vi.fn()}
        onNotify={vi.fn()}
        onUse={vi.fn()}
        open
        projectId="project-one"
      />,
    )

    expect(await screen.findByRole('dialog', { name: '生成历史' })).toBeVisible()
    expect(await screen.findByText('2026年7月17日')).toBeVisible()
    expect(screen.getByText('2026年7月16日')).toBeVisible()
    const cards = screen.getAllByTestId('generation-history-entry')
    expect(within(cards[0]!).getByText(newestImage.prompt)).toBeVisible()

    await userEvent.setup().click(screen.getByRole('button', { name: '时间升序' }))
    expect(within(screen.getAllByTestId('generation-history-entry')[0]!).getByText(olderImage.prompt)).toBeVisible()

    await userEvent.setup().click(screen.getByRole('tab', { name: '视频' }))
    await waitFor(() => expect(client.listGenerationHistory).toHaveBeenLastCalledWith(
      { projectId: 'project-one', mediaType: 'video', limit: 48 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
    expect(await screen.findByText(video.prompt)).toBeVisible()
  })

  it('supports preview, use, local download, delete, and batch selection without deleting assets', async () => {
    const client = createClient()
    const onUse = vi.fn()
    const onNotify = vi.fn()
    render(
      <GenerationHistoryModal
        client={client}
        onClose={vi.fn()}
        onNotify={onNotify}
        onUse={onUse}
        open
        projectId="project-one"
      />,
    )
    await screen.findByText(newestImage.prompt)

    const newestCard = screen.getAllByTestId('generation-history-entry')[0]!
    await userEvent.setup().click(within(newestCard).getByRole('button', { name: '查看' }))
    expect(screen.getByRole('dialog', { name: '查看生成结果' })).toBeVisible()
    await userEvent.setup().click(screen.getByRole('button', { name: '关闭预览' }))

    await userEvent.setup().click(within(newestCard).getByRole('button', { name: '使用' }))
    expect(onUse).toHaveBeenCalledWith(newestImage)
    expect(within(newestCard).getByRole('link', { name: '下载' })).toHaveAttribute('href', newestImage.asset.url)
    expect(within(newestCard).getByRole('link', { name: '下载' })).toHaveAttribute('download', newestImage.asset.filename)

    await userEvent.setup().click(screen.getByRole('button', { name: '批量选择' }))
    await userEvent.setup().click(within(newestCard).getByRole('checkbox', { name: `选择 ${newestImage.asset.filename}` }))
    expect(screen.getByText('已选 1 项')).toBeVisible()

    await userEvent.setup().click(within(newestCard).getByRole('button', { name: '删除记录' }))
    await waitFor(() => expect(client.deleteGenerationHistoryEntry).toHaveBeenCalledWith(
      'project-one',
      newestImage.id,
    ))
    expect(screen.queryByText(newestImage.prompt)).not.toBeInTheDocument()
    expect(onNotify).toHaveBeenCalledWith('已从历史记录中移除', 'success')
  })

  it('loads more pages, exposes empty and retry states, and resizes thumbnails', async () => {
    const pagedClient = createClient([
      { entries: [newestImage], nextCursor: 'next-page' },
      { entries: [olderImage] },
    ])
    const view = render(
      <GenerationHistoryModal
        client={pagedClient}
        onClose={vi.fn()}
        onUse={vi.fn()}
        open
        projectId="project-one"
      />,
    )
    await screen.findByText(newestImage.prompt)
    await userEvent.setup().click(screen.getByRole('button', { name: '放大缩略图' }))
    expect(screen.getByRole('dialog', { name: '生成历史' })).toHaveStyle({ '--generation-history-tile-size': '168px' })
    await userEvent.setup().click(screen.getByRole('button', { name: '加载更多' }))
    expect(await screen.findByText(olderImage.prompt)).toBeVisible()
    expect(pagedClient.listGenerationHistory).toHaveBeenLastCalledWith(
      { projectId: 'project-one', mediaType: 'image', cursor: 'next-page', limit: 48 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    const failingClient = createClient([{ entries: [] }])
    failingClient.listGenerationHistory.mockRejectedValueOnce(new Error('offline'))
    view.rerender(
      <GenerationHistoryModal
        client={failingClient}
        onClose={vi.fn()}
        onUse={vi.fn()}
        open
        projectId="project-two"
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('历史记录加载失败')
    await userEvent.setup().click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('暂无图片生成记录')).toBeVisible()
  })

  it('discards an older load-more response after the project changes', async () => {
    let resolveOlder!: (page: GenerationHistoryPage) => void
    const olderPage = new Promise<GenerationHistoryPage>((resolve) => {
      resolveOlder = resolve
    })
    const client = createClient()
    client.listGenerationHistory = vi.fn()
      .mockResolvedValueOnce({ entries: [newestImage], nextCursor: 'older' })
      .mockReturnValueOnce(olderPage)
      .mockResolvedValueOnce({ entries: [] })
    const view = render(
      <GenerationHistoryModal
        client={client}
        onClose={vi.fn()}
        onUse={vi.fn()}
        open
        projectId="project-one"
      />,
    )
    await screen.findByText(newestImage.prompt)
    await userEvent.setup().click(screen.getByRole('button', { name: '加载更多' }))

    view.rerender(
      <GenerationHistoryModal
        client={client}
        onClose={vi.fn()}
        onUse={vi.fn()}
        open
        projectId="project-two"
      />,
    )
    expect(await screen.findByText('暂无图片生成记录')).toBeVisible()
    resolveOlder({ entries: [olderImage] })
    await Promise.resolve()

    expect(screen.queryByText(olderImage.prompt)).not.toBeInTheDocument()
  })

  it('traps focus, closes preview before the modal, restores focus, and closes from the backdrop', async () => {
    const onClose = vi.fn()
    const trigger = document.createElement('button')
    trigger.textContent = 'open history'
    document.body.append(trigger)
    trigger.focus()
    const view = render(
      <GenerationHistoryModal
        client={createClient()}
        onClose={onClose}
        onUse={vi.fn()}
        open
        projectId="project-one"
      />,
    )
    await screen.findByText(newestImage.prompt)
    expect(screen.getByRole('button', { name: '关闭生成历史' })).toHaveFocus()

    const previewTrigger = screen.getAllByRole('button', { name: '查看' })[0]!
    await userEvent.setup().click(previewTrigger)
    expect(screen.getByRole('button', { name: '关闭预览' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '查看生成结果' })).not.toBeInTheDocument()
    expect(previewTrigger).toHaveFocus()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    view.rerender(
      <GenerationHistoryModal
        client={createClient()}
        onClose={onClose}
        onUse={vi.fn()}
        open={false}
        projectId="project-one"
      />,
    )
    expect(trigger).toHaveFocus()

    view.rerender(
      <GenerationHistoryModal
        client={createClient()}
        onClose={onClose}
        onUse={vi.fn()}
        open
        projectId="project-one"
      />,
    )
    const backdrop = await screen.findByTestId('generation-history-backdrop')
    fireEvent.mouseDown(backdrop)
    expect(onClose).toHaveBeenCalledTimes(2)
    trigger.remove()
  })
})
