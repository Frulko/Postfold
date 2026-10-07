export type Project = { id: string; name: string; color: string; createdAt?: string; parentId?: string | null; code?: string | null }
export type Label = { id: string; name: string; color: string }
export type Contact = { id: string; name: string; email: string; company: string; phone: string }
export type Conversation = {
  id: string
  projectId: string
  contactId: string
  threadId?: string
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
export type Activity = { id: string; conversationId: string; createdAt: string; actor: Pick<Member, 'id' | 'name'> | null; kind: 'updated' | 'reply'; data: { before?: ConversationState; after?: ConversationState; status?: 'sending' | 'sent' | 'uncertain' } }
export type ConversationState = Pick<Conversation, 'id' | 'unread' | 'status'> & { revision: number; projectId?: string; labelIds?: string[]; assigneeId?: string | null; assignee?: string | null }
export type ConversationPatch = Partial<Pick<Conversation, 'unread' | 'status' | 'projectId' | 'assigneeId'>> & { addLabelIds?: string[]; removeLabelIds?: string[] }
export type ConversationUpdate = ConversationPatch & { targets: { id: string; revision: number }[] }
export type DemoMailbox = Mailbox & { viewer?: import('./auth.js').Viewer; members?: Member[]; currentMemberId?: string; projectSettings: Omit<ProjectSettings, 'projects'>; conversationStates: ConversationState[]; connection?: { mode: 'imap'; email: string; lastSync: string | null; error: boolean; maxMessagesPerSync: number }; deliveries?: { targetId: string; status: 'sending' | 'sent' | 'uncertain'; sentCopy: boolean }[] }
