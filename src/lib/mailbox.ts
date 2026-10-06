import type { Conversation, Mailbox, Project } from '../../shared/mailbox'
export type { Project, Contact, Conversation, Mailbox } from '../../shared/mailbox'
import { projectPath } from '../../shared/projects.ts'

const searchable = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr')

export function filterProjects(projects: Project[], query: string) {
  const needle = searchable(query.trim())
  return projects.filter((project) => searchable(projectPath(projects, project.id)).includes(needle))
}

export function filterConversations(mailbox: Mailbox, projectId: string | null, query: string) {
  const needle = searchable(query.trim())
  return mailbox.conversations.filter((conversation) => {
    if (projectId && conversation.projectId !== projectId && !projectPath(mailbox.projects, conversation.projectId).startsWith(`${projectPath(mailbox.projects, projectId)} /`)) return false
    const contact = mailbox.contacts.find((item) => item.id === conversation.contactId)
    return searchable([conversation.subject, conversation.preview, contact?.name, contact?.email,
      contact?.company, conversation.sender?.name, conversation.sender?.email, conversation.projectId, projectPath(mailbox.projects, conversation.projectId)].join(' ')).includes(needle)
  })
}

export function updateSelection(current: string[], visible: string[], id: string, checked: boolean, anchor: string | null, range: boolean) {
  if (!visible.includes(id)) return current
  const start = anchor ? visible.indexOf(anchor) : -1
  const end = visible.indexOf(id)
  const affected = range && start !== -1 ? visible.slice(Math.min(start, end), Math.max(start, end) + 1) : [id]
  return checked ? [...new Set([...current, ...affected])] : current.filter((item) => !affected.includes(item))
}

export function moveConversations(mailbox: Mailbox, ids: string[], projectId: string): Mailbox {
  if (!mailbox.projects.some((project) => project.id === projectId) ||
    ids.some((id) => !mailbox.conversations.some((item) => item.id === id))) {
    throw new Error('Le projet ou une conversation n’existe plus.')
  }
  return { ...mailbox, conversations: mailbox.conversations.map((item) =>
    ids.includes(item.id) ? { ...item, projectId } : item) }
}

export const threadKey = (message: Conversation) => message.threadId ?? message.id
export function mailboxRows(messages: Conversation[], mode: 'messages' | 'threads') {
  const groups = new Map<string, Conversation[]>()
  for (const message of messages) {
    const key = mode === 'threads' ? threadKey(message) : message.id
    const group = groups.get(key) ?? []
    group.push(message)
    groups.set(key, group)
  }
  return [...groups.entries()].map(([key, items]) => {
    const ordered = [...items].sort((a, b) => (Date.parse(a.sentAt ?? '') || 0) - (Date.parse(b.sentAt ?? '') || 0))
    const first = ordered.find((item) => item.id === key) ?? ordered[0]
    const latest = ordered.at(-1)!
    return { ...first, time: latest.time, preview: latest.preview, unread: items.some((item) => item.unread),
      labelIds: [...new Set(items.flatMap((item) => item.labelIds ?? []))], messageIds: ordered.map((item) => item.id), latestAt: latest.sentAt ?? '' }
  }).sort((a, b) => (Date.parse(b.latestAt) || 0) - (Date.parse(a.latestAt) || 0))
}
