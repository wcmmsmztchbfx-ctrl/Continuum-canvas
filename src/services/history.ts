export const HISTORY_LIMIT = 100

export const HISTORY_ACTION_LABELS = {
  'workspace.create': '创建工作区',
  'workspace.rename': '重命名工作区',
  'workspace.delete': '删除工作区',
  'project.create': '创建项目',
  'project.rename': '重命名项目',
  'project.clone': '克隆项目',
  'project.delete': '删除项目',
  'share.create': '创建分享链接',
  'project.publish': '发布项目',
  'member.invite': '邀请成员',
  'asset.upload': '上传素材',
  'selection.download': '下载选中内容',
} as const

export type HistoryAction = keyof typeof HISTORY_ACTION_LABELS

export interface HistoryRecord {
  id: string
  action: HistoryAction
  actionLabel: (typeof HISTORY_ACTION_LABELS)[HistoryAction]
  subject: string
  createdAt: string
}

export interface HistoryRecordInput {
  id: string
  subject: string
  createdAt: string
}

export function createHistoryRecord(
  action: HistoryAction,
  input: HistoryRecordInput,
): HistoryRecord {
  return {
    id: input.id,
    action,
    actionLabel: HISTORY_ACTION_LABELS[action],
    subject: input.subject,
    createdAt: input.createdAt,
  }
}

export function recordHistory(
  history: readonly HistoryRecord[],
  action: HistoryAction,
  input: HistoryRecordInput,
): HistoryRecord[] {
  return [...history, createHistoryRecord(action, input)].slice(-HISTORY_LIMIT)
}
