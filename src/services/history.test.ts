import { describe, expect, it } from 'vitest'

import { HISTORY_ACTION_LABELS, recordHistory } from './history'

describe('history records', () => {
  it('adds a Chinese action label to each record', () => {
    const history = recordHistory([], 'project.create', {
      id: 'history-1',
      subject: '画布 1',
      createdAt: '2026-07-15T00:00:00.000Z',
    })

    expect(history).toEqual([
      {
        id: 'history-1',
        action: 'project.create',
        actionLabel: '创建项目',
        subject: '画布 1',
        createdAt: '2026-07-15T00:00:00.000Z',
      },
    ])
    expect(HISTORY_ACTION_LABELS['selection.download']).toBe('下载选中内容')
  })

  it('keeps only the latest 100 records without mutating the input', () => {
    let history = [] as ReturnType<typeof recordHistory>

    for (let index = 0; index < 105; index += 1) {
      const previous = history
      history = recordHistory(history, 'project.rename', {
        id: `history-${index}`,
        subject: `项目 ${index}`,
        createdAt: new Date(index).toISOString(),
      })
      expect(history).not.toBe(previous)
    }

    expect(history).toHaveLength(100)
    expect(history[0]?.id).toBe('history-5')
    expect(history.at(-1)?.id).toBe('history-104')
  })
})
