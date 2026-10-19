import type { Contact, Conversation, Mailbox, Project } from '../../shared/mailbox'
export type { Project, Contact, Conversation, Mailbox } from '../../shared/mailbox'
import { projectPath } from '../../shared/projects.ts'
import { fold } from '../../shared/search.ts'

const searchable = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr')

export function filterProjects(projects: Project[], query: string) {
  const needle = searchable(query.trim())
  return projects.filter((project) => searchable(projectPath(projects, project.id)).includes(needle))
}

// Match visible project codes, never generated IMAP folder IDs.
export function suggestProjects(projects: Project[], messages: Pick<Conversation, 'subject'>[]): Project[] {
  return projects.filter((project) => {
    const code = project.code === undefined ? project.parentId ? null : project.id : project.code
    if (!code) return false
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}._-])${escaped}(?=$|[^\\p{L}\\p{N}._-])`, 'iu')
    return messages.some((message) => pattern.test(message.subject))
  })
}

export function filterConversations(mailbox: Mailbox, projectId: string | null, query: string) {
  const needle = searchable(query.trim())
  return mailbox.conversations.filter((conversation) => {
    if (projectId && conversation.projectId !== projectId && !projectPath(mailbox.projects, conversation.projectId).startsWith(`${projectPath(mailbox.projects, projectId)} /`)) return false
    const contact = mailbox.contacts.find((item) => item.id === conversation.contactId)
    return searchable([conversation.subject, conversation.preview, contact?.name, contact?.email,
      contact?.company, conversation.sender?.name, conversation.sender?.email, ...(conversation.participants ?? []).flatMap((person) => [person.name, person.email]), conversation.projectId, projectPath(mailbox.projects, conversation.projectId)].join(' ')).includes(needle)
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
export const includesContact = (message: Conversation, contact: Contact) => message.contactId === contact.id ||
  message.participants?.some(person => person.email.toLowerCase() === contact.email.toLowerCase()) === true
export type MailOrder = 'newest' | 'oldest'
export const compareMessages = (a: Conversation, b: Conversation, order: MailOrder = 'newest') =>
  ((Date.parse(a.sentAt ?? '') || 0) - (Date.parse(b.sentAt ?? '') || 0)) * (order === 'oldest' ? 1 : -1)

export function threadContacts(mailbox: Mailbox, messages: Conversation[]) {
  const ids = new Set(messages.map((message) => message.contactId))
  const emails = new Set(messages.flatMap((message) => [message.sender?.email, ...(message.participants ?? []).map((person) => person.email)]).filter(Boolean).map((email) => email!.toLowerCase()))
  return mailbox.contacts.filter((person) => ids.has(person.id) || emails.has(person.email.toLowerCase()))
}

// `relevance` keeps the API's ranking: rows follow the order of their best message.
export function mailboxRows(messages: Conversation[], mode: 'messages' | 'threads', order: MailOrder | 'relevance' = 'newest') {
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
    return { ...first, time: latest.time, preview: latest.preview, snippet: items.find((item) => item.snippet)?.snippet, unread: items.some((item) => item.unread),
      labelIds: [...new Set(items.flatMap((item) => item.labelIds ?? []))], messageIds: ordered.map((item) => item.id), latestAt: latest.sentAt ?? '' }
  }).sort((a, b) => order === 'relevance' ? 0 : ((Date.parse(a.latestAt) || 0) - (Date.parse(b.latestAt) || 0)) * (order === 'oldest' ? 1 : -1))
}

const attribution = (line: string) => /^(on|le)\s.{0,250}(wrote|a\s+écrit)\s*:\s*$/i.test(line)
// Folds the first reply quote, Outlook separator or "-- " signature; forwarded messages stay visible.
export function splitQuoted(text: string): [string, string] {
  const lines = text.split('\n')
  const start = lines.findIndex((line, index) => lines.slice(0, index).some((before) => before.trim()) &&
    (/^(>|--$|_{5,}$)/.test(line.trim()) || attribution(line.trim()) || attribution(`${line.trim()} ${lines[index + 1]?.trim() ?? ''}`)))
  return start < 0 ? [text, ''] : [lines.slice(0, start).join('\n').trimEnd(), lines.slice(start).join('\n')]
}

const linkPattern = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'»]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/
export const linkParts = (text: string) => text.split(linkPattern).map((part, index) =>
  index % 2 ? { text: part, href: part.includes('://') ? part : `mailto:${part}` } : { text: part })

// Splits text into plain and highlighted parts for the searched words, ignoring case and accents.
export function highlightParts(text: string, terms: string[]): { text: string; mark?: boolean }[] {
  const folded = fold(text)
  if (!terms.length || folded.length !== text.length) return [{ text }]
  const marks = new Array<boolean>(text.length).fill(false)
  for (const term of terms) for (let index = folded.indexOf(term); term && index !== -1; index = folded.indexOf(term, index + term.length)) marks.fill(true, index, index + term.length)
  const parts: { text: string; mark?: boolean }[] = []
  for (let index = 0; index < text.length;) {
    let end = index
    while (end < text.length && marks[end] === marks[index]) end++
    parts.push(marks[index] ? { text: text.slice(index, end), mark: true } : { text: text.slice(index, end) })
    index = end
  }
  return parts
}
