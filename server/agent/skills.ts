import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { AgentSkillInfo } from '../../src/contracts/agent.ts'

const definitions: AgentSkillInfo[] = [
  { id: 'canvas-base', name: '画布基础操作', description: '安全读写节点、连线、布局、澄清和结果验证', version: '1' },
  { id: 'image-generation', name: '图片生成', description: '复用现有图片生成配置与素材，控制付费次数', version: '1' },
  { id: 'image-reference', name: '图片引用分析', description: '使用已明确引用的真实预览，区分分析与生成参考', version: '1' },
  { id: 'layout', name: '画布排版', description: '只调整授权节点，保留用户编辑', version: '1' },
  { id: 'video-generation', name: '视频生成', description: '使用现有视频模型、参数与任务恢复能力', version: '1' },
]
export class AgentSkills {
  list() { return structuredClone(definitions) }
  async read(id: string) {
    const info = definitions.find(s => s.id === id)
    if (!info) throw new Error('Unknown Skill')
    const content = await readFile(fileURLToPath(new URL(`../../skills/canvas-agent/${id}/SKILL.md`, import.meta.url)), 'utf8')
    return { info, content }
  }
}
