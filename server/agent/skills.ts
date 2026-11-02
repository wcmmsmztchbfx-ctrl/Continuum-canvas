import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { AgentSkillInfo } from '../../src/contracts/agent.ts'
import { describeCanvasCommand, listCanvasCommands } from './commands.ts'
import { AgentError } from './types.ts'

export interface SkillDocument { info: AgentSkillInfo; content: string }
export interface SkillPackage { version: '2'; digest: string; resources: Record<string, SkillDocument> }

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
  async snapshotV2(): Promise<SkillPackage> {
    const root = new URL('../../skills/canvas-agent-v2/', import.meta.url)
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8')) as { resources: { skill: string; path: string }[] }
    const resources: Record<string, SkillDocument> = {}
    for (const entry of manifest.resources) {
      if (!definitions.some(s => s.id === entry.skill) || !/^(?:SKILL\.md|(?:commands|workflows|examples|recovery)\/[a-z-]+\.md)$/.test(entry.path)) throw new Error('Invalid Skill resource manifest')
      const key = `${entry.skill}/${entry.path}`
      if (resources[key]) throw new Error('Duplicate Skill resource')
      let content = await readFile(new URL(key, root), 'utf8')
      if (entry.path.startsWith('commands/')) {
        const group = entry.path.slice('commands/'.length, -3)
        for (const command of listCanvasCommands().filter(c => c.group === group)) {
          const { validate: _validate, ...contract } = describeCanvasCommand(command.name)
          content += `\n\n## ${command.name}\n\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n`
        }
      }
      resources[key] = { info: { ...definitions.find(s => s.id === entry.skill)!, version: '2' }, content }
    }
    return { version: '2', digest: createHash('sha256').update(JSON.stringify(resources)).digest('hex'), resources }
  }
  readResource(bundle: SkillPackage, id: string, resource = 'SKILL.md'): SkillDocument {
    const document = bundle.resources[`${id}/${resource}`]
    if (!document) throw new AgentError(400, 'skill_resource_missing', '资源未列入本任务固定的 Skill 清单。')
    return structuredClone(document)
  }
}
