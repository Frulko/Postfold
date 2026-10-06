export type Project = { id: string; name: string; color: string; createdAt?: string; parentId?: string | null }
export type Label = { id: string; name: string; color: string }
export type Contact = { id: string; name: string; email: string; company: string; phone: string }
export type Conversation = {
  id: string
  projectId: string
  contactId: string
  threadId?: string
  sentAt?: string
  sender?: { name: string; email: string }
  subject: string
  preview: string
  body: string
  time: string
  status: 'open' | 'waiting' | 'closed'
  assignee: string | null
  unread: boolean
  labelIds?: string[]
}

export type Mailbox = { projects: Project[]; contacts: Contact[]; conversations: Conversation[]; labels?: Label[] }

export type ProjectSettings = {
  revision: number
  projects: Project[]
  order: string[]
  sort: import('./projects.js').ProjectSort
  labels?: Label[]
}
export type ConversationState = Pick<Conversation, 'id' | 'unread' | 'status'> & { revision: number; projectId?: string; labelIds?: string[] }
export type ConversationPatch = Partial<Pick<Conversation, 'unread' | 'status' | 'projectId'>> & { addLabelIds?: string[]; removeLabelIds?: string[] }
export type ConversationUpdate = ConversationPatch & { targets: { id: string; revision: number }[] }
export type DemoMailbox = Mailbox & { projectSettings: Omit<ProjectSettings, 'projects'>; conversationStates: ConversationState[] }
