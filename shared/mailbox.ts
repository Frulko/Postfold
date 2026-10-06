export type Project = { id: string; name: string; color: string; createdAt?: string }
export type Contact = { id: string; name: string; email: string; company: string; phone: string }
export type Conversation = {
  id: string
  projectId: string
  contactId: string
  subject: string
  preview: string
  body: string
  time: string
  status: 'open' | 'waiting' | 'closed'
  assignee: string | null
  unread: boolean
}

export type Mailbox = { projects: Project[]; contacts: Contact[]; conversations: Conversation[] }

export type ProjectSettings = {
  revision: number
  projects: Project[]
  order: string[]
  sort: import('./projects.js').ProjectSort
}
export type ConversationState = Pick<Conversation, 'id' | 'unread' | 'status'> & { revision: number }
export type ConversationPatch = Partial<Pick<Conversation, 'unread' | 'status'>>
export type ConversationUpdate = ConversationPatch & { targets: { id: string; revision: number }[] }
export type DemoMailbox = Mailbox & { projectSettings: Omit<ProjectSettings, 'projects'>; conversationStates: ConversationState[] }
