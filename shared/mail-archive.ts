import type { Conversation, ConversationState } from './mailbox.js'

export type ArchiveSearch = { query: string; missingOnly: boolean; cursor?: string }
export type ArchiveRestore = { id: string; folderId: string }
export type MailArchiveEntry = {
  id: string; messageId: string; subject: string; sender: Conversation['sender']; preview: string;
  sentAt: string; archivedAt: string; missingSince: string | null; lastPath: string; bytes: number;
  snapshot: ConversationState; restoreStatus: 'sending' | 'sent' | 'uncertain' | null;
}
export type MailArchivePage = {
  items: MailArchiveEntry[]; nextCursor: string | null;
  stats: { messages: number; bytes: number; missing: number; cachedWithoutSource: number };
}
export const isArchiveId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
export function isArchiveSearch(value: unknown): value is ArchiveSearch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as ArchiveSearch
  return typeof item.query === 'string' && item.query.length <= 200 && typeof item.missingOnly === 'boolean' && (item.cursor === undefined || isArchiveId(item.cursor))
}
export function isArchiveRestore(value: unknown): value is ArchiveRestore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as ArchiveRestore
  return isArchiveId(item.id) && typeof item.folderId === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(item.folderId)
}
