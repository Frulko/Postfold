import { BadRequestException } from '@nestjs/common'
import type { Reader } from '../shared/mailbox.js'

// Who is online and which mail each has open, refreshed by each client every 3 s and forgotten after 10 s without news.
// ponytail: polling, near real time for a team; push over SSE if 3 s feels slow. In-process map, enough for one API
// instance; with several instances move it to PostgreSQL or Redis.
const TTL = 10_000
const seen = new Map<string, Reader & { at: number }>()

export function reportPresence(viewer: { id: string; name: string; email?: string } | undefined, input: unknown): Reader[] {
  // Without a personal identity (shared basic-auth access) nobody can be told apart: presence stays off.
  if (!viewer) return []
  const item = input as { ids?: unknown; replying?: unknown }
  if (!item || typeof item !== 'object' || !Array.isArray(item.ids) || item.ids.length > 200 || !item.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200) || typeof item.replying !== 'boolean') throw new BadRequestException('Invalid presence.')
  const now = Date.now()
  for (const [id, reader] of seen) if (now - reader.at > TTL) seen.delete(id)
  // A colleague with no mail open stays listed as online.
  seen.set(viewer.id, { id: viewer.id, name: viewer.name, ...(viewer.email ? { email: viewer.email } : {}), ids: item.ids, replying: item.replying, at: now })
  return [...seen.values()].filter((reader) => reader.id !== viewer.id).map(({ at: _, ...reader }) => reader)
}
