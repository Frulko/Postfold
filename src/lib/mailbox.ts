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
    if (projectId && conversation.projectId !== projectId && (projectId === 'inbox' || !projectPath(mailbox.projects, conversation.projectId).startsWith(`${projectPath(mailbox.projects, projectId)} /`))) return false
    const contact = mailbox.contacts.find((item) => item.id === conversation.contactId)
    return searchable([conversation.subject, conversation.preview, contact?.name, contact?.email,
      contact?.company, conversation.sender?.name, conversation.sender?.email, ...(conversation.participants ?? []).flatMap((person) => [person.name, person.email]), conversation.projectId, projectPath(mailbox.projects, conversation.projectId)].join(' ')).includes(needle)
  })
}

// A person keeps the same colour everywhere: a hash (FNV-1a) of the name and email picks one of 8 OKLCH hues 45° apart, each at the
// strongest chroma sRGB holds for that hue. The closest pair stays about twice the just-noticeable difference and the text
// keeps 6.6:1 contrast or more. Entries: hue, then chroma of background (L 0.9), text (L 0.4) and border (L 0.82).
const avatarPalette = [[25, 0.043, 0.138, 0.085], [70, 0.064, 0.074, 0.09], [105, 0.07, 0.072, 0.09], [145, 0.07, 0.108, 0.09],
  [185, 0.07, 0.06, 0.09], [235, 0.047, 0.072, 0.089], [280, 0.04, 0.14, 0.077], [330, 0.07, 0.14, 0.09]]
const avatarSlot = (seed: string) => {
  let hash = 0x811c9dc5
  for (const char of seed.trim().toLowerCase()) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193)
  return (hash >>> 0) % avatarPalette.length
}
const avatarStyle = (slot: number) => {
  const [hue, background, text, border] = avatarPalette[slot]
  return { backgroundColor: `oklch(0.9 ${background} ${hue})`, color: `oklch(0.4 ${text} ${hue})`, borderColor: `oklch(0.82 ${border} ${hue})` }
}
export const avatarColor = (seed: string) => avatarStyle(avatarSlot(seed))
// The name counts too: colleagues answering from the shared address are different people.
export const avatarSeed = (person: { name?: string; email?: string }) => `${person.name ?? ''} ${person.email ?? ''}`

// People shown together never share a colour while one is free: in email order, a taken colour passes to the next free one.
export function avatarColors(seeds: string[]) {
  const taken = new Set<number>()
  const colors = new Map<string, ReturnType<typeof avatarStyle>>()
  for (const seed of [...new Set(seeds.map((item) => item.trim().toLowerCase()))].sort()) {
    let slot = avatarSlot(seed)
    for (let step = 0; taken.has(slot) && step < avatarPalette.length; step++) slot = (slot + 1) % avatarPalette.length
    taken.add(slot)
    colors.set(seed, avatarStyle(slot))
  }
  return (seed: string) => colors.get(seed.trim().toLowerCase()) ?? avatarColor(seed)
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
// One mail stored twice (same Message-ID, e.g. a Sent copy saved by both the mail server and Postfold) shows once; `keep` wins.
export function distinctMails(messages: Conversation[], keep?: string) {
  const mails = new Map<string, Conversation>()
  for (const message of messages) if (!mails.has(message.messageId ?? message.id) || message.id === keep) mails.set(message.messageId ?? message.id, message)
  return [...mails.values()]
}
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
  for (const message of distinctMails(messages)) {
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

const intlLocale = (locale: string) => locale === 'en' ? 'en-GB' : 'fr-FR'
// List and reader dates in the reader's language and time zone: today shows the time, yesterday "Hier 09:12",
// this week the weekday, older mail the day and month (and year when it differs). The time is always shown.
export function formatMailTime(sentAt: string | undefined, locale: string, now = new Date()) {
  const date = new Date(sentAt ?? '')
  if (Number.isNaN(date.getTime())) return null
  const lang = intlLocale(locale)
  const time = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(date)
  const midnight = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((midnight(now) - midnight(date)) / 86_400_000)
  if (days === 0) return time
  if (days === 1) { const word = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-1, 'day'); return `${word[0].toLocaleUpperCase(lang)}${word.slice(1)} ${time}` }
  const day = days > 1 && days < 7 ? { weekday: 'short' as const } : { day: 'numeric' as const, month: 'short' as const, ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}) }
  return `${new Intl.DateTimeFormat(lang, day).format(date)} ${time}`
}
export const fullMailTime = (sentAt: string | undefined, locale: string) => {
  const date = new Date(sentAt ?? '')
  return Number.isNaN(date.getTime()) ? undefined : new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'full', timeStyle: 'short' }).format(date)
}
