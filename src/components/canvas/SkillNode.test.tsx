// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SkillNode } from './SkillNode'

afterEach(cleanup)

describe('SkillNode Component', () => {
  it('renders compact card with name-skill, snippet and character/line stats', () => {
    render(
      <ReactFlowProvider>
        <SkillNode
          {...({
            id: 'skill-node-1',
            selected: false,
            isConnectable: true,
            data: {
              name: '镜头拆解',
              text: '# 电影级镜头拆解规范\n\n1. 特写镜头：聚焦主体眼神\n2. 全景镜头：展示环境空间\n3. 运镜轨迹：平滑摇镜推拉',
            },
          } as never)}
        />
      </ReactFlowProvider>,
    )

    expect(screen.getByText('镜头拆解-skill')).toBeInTheDocument()
    expect(screen.getByText('Skill')).toBeInTheDocument()
    expect(screen.getByText(/电影级镜头拆解规范/)).toBeInTheDocument()
    expect(screen.getByText(/5 行/)).toBeInTheDocument()
  })

  it('opens and closes full markdown modal on view button click', () => {
    render(
      <ReactFlowProvider>
        <SkillNode
          {...({
            id: 'skill-node-1',
            selected: false,
            isConnectable: true,
            data: {
              name: '高级运镜-skill',
              text: '# 运镜指南\n\n- Dolly In\n- Orbit shot',
            },
          } as never)}
        />
      </ReactFlowProvider>,
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const viewBtn = screen.getByRole('button', { name: /查看完整信息/ })
    fireEvent.click(viewBtn)

    const dialog = screen.getByRole('dialog', { name: /高级运镜-skill 详情/ })
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText(/Dolly In/)).toBeInTheDocument()

    const closeBtn = screen.getByTitle('关闭')
    fireEvent.click(closeBtn)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
