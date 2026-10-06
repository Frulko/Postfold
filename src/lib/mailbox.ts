import type { Mailbox, Project } from '../../shared/mailbox'
export type { Project, Contact, Conversation, Mailbox } from '../../shared/mailbox'

const searchable = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr')

export function filterProjects(projects: Project[], query: string) {
  const needle = searchable(query.trim())
  return projects.filter((project) => searchable(`${project.id} ${project.name}`).includes(needle))
}

export function filterConversations(mailbox: Mailbox, projectId: string | null, query: string) {
  const needle = searchable(query.trim())
  return mailbox.conversations.filter((conversation) => {
    if (projectId && conversation.projectId !== projectId) return false
    const contact = mailbox.contacts.find((item) => item.id === conversation.contactId)
    const project = mailbox.projects.find((item) => item.id === conversation.projectId)
    return searchable([conversation.subject, conversation.preview, contact?.name, contact?.email,
      contact?.company, project?.id, project?.name].join(' ')).includes(needle)
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
