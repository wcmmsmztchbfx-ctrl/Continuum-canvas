const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const COOKIE_PREFIX = 'canvas_collaboration_room_'

export function collaborationCookieName(roomId: string): string {
  if (!ROOM_ID.test(roomId)) throw new Error('Invalid collaboration room id')
  return `${COOKIE_PREFIX}${roomId}`
}

export function collaborationTokenFromCookieHeader(
  header: string | undefined,
  roomId: string,
): string {
  if (!header) return ''
  const expected = collaborationCookieName(roomId)
  for (const item of header.split(';')) {
    const separator = item.indexOf('=')
    if (separator > 0 && item.slice(0, separator).trim() === expected) {
      return item.slice(separator + 1).trim()
    }
  }
  return ''
}

export function collaborationRoomIdsFromCookieHeader(header: string | undefined): string[] {
  if (!header) return []
  const ids: string[] = []
  for (const item of header.split(';')) {
    const separator = item.indexOf('=')
    const name = separator > 0 ? item.slice(0, separator).trim() : ''
    if (!name.startsWith(COOKIE_PREFIX)) continue
    const roomId = name.slice(COOKIE_PREFIX.length)
    if (ROOM_ID.test(roomId)) ids.push(roomId)
  }
  return [...new Set(ids)]
}
