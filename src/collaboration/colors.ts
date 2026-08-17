export const COLLABORATOR_PALETTE = [
  '#0d99ff', // vibrant blue
  '#22c55e', // emerald green
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
  '#a855f7', // purple
] as const

export function getCollaboratorColor(memberIdOrName: string): string {
  if (!memberIdOrName) return COLLABORATOR_PALETTE[0]
  let hash = 0
  for (let i = 0; i < memberIdOrName.length; i++) {
    hash = ((hash * 31) + memberIdOrName.charCodeAt(i)) >>> 0
  }
  return COLLABORATOR_PALETTE[hash % COLLABORATOR_PALETTE.length]
}
