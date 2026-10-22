export type Project = { id: string; name: string; color: string; createdAt?: string; parentId?: string | null; code?: string | null }
export type Label = { id: string; name: string; color: string }
export type Contact = { id: string; name: string; email: string; company: string; phone: string }
export type Conversation = {
  id: string
  projectId: string
  contactId: string
  threadId?: string
  // Mails in the thread, every folder included; set on live list windows.
  threadSize?: number
  sentAt?: string
  sender?: { name: string; email: string }
  participants?: Pick<Contact, 'name' | 'email'>[]
  subject: string
  preview: string
  body: string
  time: string
  status: 'open' | 'waiting' | 'closed'
  assignee: string | null
  assigneeId?: string | null
  unread: boolean
  labelIds?: string[]
  messageId?: string
  outgoing?: boolean
  imapReady?: boolean
  // Plain-text excerpt around a search match; rendered as text, never as HTML.
  snippet?: string
}

export type Mailbox = { projects: Project[]; contacts: Contact[]; conversations: Conversation[]; labels?: Label[] }

export type ProjectSettings = {
  revision: number
  projects: Project[]
  order: string[]
  sort: import('./projects.js').ProjectSort
  labels?: Label[]
}
export type Member = { id: string; name: string; email: string; provider?: 'demo' | 'keycloak'; role?: 'admin' | 'member'; active?: boolean; lastSeen?: string; managedAdmin?: boolean }
// A colleague with these mails open right now, and whether they are writing a reply.
export type Reader = { id: string; name: string; email?: string; ids: string[]; replying: boolean }
export type Activity = { id: string; conversationId: string; createdAt: string; actor: Pick<Member, 'id' | 'name'> | null; kind: 'updated' | 'reply'; data: { before?: ConversationState; after?: ConversationState; status?: 'sending' | 'sent' | 'uncertain'; restoredFromArchive?: string } }
export type ConversationState = Pick<Conversation, 'id' | 'unread' | 'status'> & { revision: number; projectId?: string; labelIds?: string[]; assigneeId?: string | null; assignee?: string | null }
export type ConversationPatch = Partial<Pick<Conversation, 'unread' | 'status' | 'projectId' | 'assigneeId'>> & { addLabelIds?: string[]; removeLabelIds?: string[] }
export type ConversationUpdate = ConversationPatch & { targets: { id: string; revision: number }[] }
// Live mailboxes are read in windows: the list filters, sorts and pages in PostgreSQL; `include` keeps the open thread loaded.
// `memberId` keeps conversations assigned to a colleague or that this colleague answered or changed.
export type MailboxQuery = { projectId?: string | null; status?: 'all' | 'unread' | 'open' | 'waiting' | 'closed'; labelId?: string | null; memberId?: string | null; query?: string
  threads?: boolean; order?: 'newest' | 'oldest' | 'relevance'; cursor?: string | null; limit?: number; include?: string[] }
export function isMailboxQuery(value: unknown): value is MailboxQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as MailboxQuery
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 100
  return Object.keys(item).every((key) => ['projectId', 'status', 'labelId', 'memberId', 'query', 'threads', 'order', 'cursor', 'limit', 'include'].includes(key)) &&
    (item.projectId == null || id(item.projectId)) && (item.labelId == null || id(item.labelId)) && (item.memberId == null || id(item.memberId)) &&
    (item.status === undefined || ['all', 'unread', 'open', 'waiting', 'closed'].includes(item.status)) &&
    (item.query === undefined || (typeof item.query === 'string' && item.query.length <= 200)) &&
    (item.threads === undefined || typeof item.threads === 'boolean') && (item.order === undefined || ['newest', 'oldest', 'relevance'].includes(item.order)) &&
    (item.cursor == null || (typeof item.cursor === 'string' && item.cursor.length <= 200)) &&
    (item.limit === undefined || (Number.isInteger(item.limit) && item.limit >= 1 && item.limit <= 1000)) &&
    (item.include === undefined || (Array.isArray(item.include) && item.include.length <= 50 && item.include.every(id)))
}
// `corrections` lists the spellings a search also matched (typos), so the browser can highlight them.
export type MailboxPage = { total: number; nextCursor: string | null; corrections?: string[] }
export type MailboxCounts = { messages: number; threads: number; labels: Record<string, number>; folders: Record<string, number> }

export type DemoMailbox = Mailbox & { preferences?: import('./preferences.js').Preferences | null; page?: MailboxPage; counts?: MailboxCounts; viewer?: import('./auth.js').Viewer; members?: Member[]; currentMemberId?: string; projectSettings: Omit<ProjectSettings, 'projects'>; conversationStates: ConversationState[]; connection?: { mode: 'imap'; email: string; lastSync: string | null; error: boolean; maxMessagesPerSync: number; trashId?: string | null }; deliveries?: { targetId: string; status: 'sending' | 'sent' | 'uncertain'; sentCopy: boolean }[] }

// Live view of the background synchronization; `stored` counts messages whose complete copy is in PostgreSQL.
export type SyncProgress = {
  state: 'idle' | 'listing' | 'inventory' | 'importing' | 'saving'
  startedAt: string | null
  folder: string | null
  folders: { done: number; total: number }
  batch: { done: number; total: number }
  stored: number
  total: number
  rate: number | null
  lastCycle: { finishedAt: string; seconds: number; imported: number; complete: boolean } | null
  // Moves when the mailbox changed: new mail from a cycle, or a change made in Postfold.
  changedAt: string | null
  error: string | null
}

export type MailLogEntry = { seq: number; at: string; level: 'info' | 'warn' | 'error'; message: string; values: (string | number)[] }
