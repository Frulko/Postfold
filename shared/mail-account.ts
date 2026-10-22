import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type MailAttachment } from './authoring.js'
export type MailEndpoint = { host: string; port: number; security: 'tls' | 'starttls'; user: string; password: string }
export type MailAccount = { email: string; name: string; imap: MailEndpoint; smtp: MailEndpoint; sentPath: string; saveSent: boolean }
export type ReplyRequest = { id: string; revision: number; text: string; html?: string; attachments?: MailAttachment[]; requestId: string }
export type NewMailRequest = { to: string[]; subject: string; text: string; html?: string; attachments?: MailAttachment[]; requestId: string }
export const MAX_RECIPIENTS = 20

export function isMailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[^\s<>@,;:\x00-\x1f]+@[^\s<>@,;:\x00-\x1f]+\.[^\s<>@,;:\x00-\x1f]+$/.test(value)
}

export function isMailAccount(value: unknown): value is MailAccount {
  if (!value || typeof value !== 'object') return false
  const item = value as MailAccount
  const endpoint = (v: MailEndpoint) => v && typeof v.host === 'string' && v.host.length <= 253 && /^[a-z0-9.-]+$/i.test(v.host) &&
    Number.isInteger(v.port) && v.port > 0 && v.port <= 65535 && ['tls', 'starttls'].includes(v.security) &&
    typeof v.user === 'string' && v.user.length > 0 && v.user.length <= 254 && !/[\x00-\x1f]/.test(v.user) &&
    typeof v.password === 'string' && v.password.length > 0 && v.password.length <= 4096
  return isMailAddress(item.email) && typeof item.name === 'string' && item.name.length <= 100 && !/[\x00-\x1f]/.test(item.name) &&
    !!endpoint(item.imap) && !!endpoint(item.smtp) && typeof item.sentPath === 'string' && item.sentPath.length > 0 && item.sentPath.length <= 500 &&
    !/[\x00-\x1f]/.test(item.sentPath) && typeof item.saveSent === 'boolean'
}

export function isReplyRequest(value: unknown): value is ReplyRequest {
  if (!value || typeof value !== 'object') return false
  const item = value as ReplyRequest
  return Object.keys(item).every((key) => ['id', 'revision', 'text', 'html', 'attachments', 'requestId'].includes(key)) &&
    typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 100 && Number.isSafeInteger(item.revision) && item.revision >= 0 && isMailBody(item)
}

export function isNewMailRequest(value: unknown): value is NewMailRequest {
  if (!value || typeof value !== 'object') return false
  const item = value as NewMailRequest
  return Object.keys(item).every((key) => ['to', 'subject', 'text', 'html', 'attachments', 'requestId'].includes(key)) &&
    Array.isArray(item.to) && item.to.length > 0 && item.to.length <= MAX_RECIPIENTS && item.to.every(isMailAddress) && new Set(item.to.map((email) => email.toLowerCase())).size === item.to.length &&
    typeof item.subject === 'string' && item.subject.trim().length > 0 && item.subject.length <= 300 && !/[\x00-\x1f]/.test(item.subject) && isMailBody(item)
}

// A reply and a new mail share the same body, attachment and request ID limits.
function isMailBody(item: Pick<ReplyRequest, 'text' | 'html' | 'attachments' | 'requestId'>) {
  return typeof item.text === 'string' && item.text.trim().length > 0 && item.text.length <= 100_000 &&
    (item.html === undefined || (typeof item.html === 'string' && item.html.length <= 200_000)) &&
    (item.attachments === undefined || (Array.isArray(item.attachments) && item.attachments.length <= MAX_ATTACHMENTS && item.attachments.every(a => a && Object.keys(a).every(k => ['filename', 'contentType', 'content'].includes(k)) && typeof a.filename === 'string' && a.filename.length > 0 && a.filename.length <= 200 && !/[\\/\x00-\x1f]/.test(a.filename) && typeof a.contentType === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(a.contentType) && typeof a.content === 'string' && a.content.length > 0 && a.content.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(a.content)) && item.attachments.reduce((total, a) => total + a.content.length / 4 * 3 - (a.content.endsWith('==') ? 2 : a.content.endsWith('=') ? 1 : 0), 0) <= MAX_ATTACHMENT_BYTES)) &&
    typeof item.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.requestId)
}

// Passwords never leave the API; an empty password in an update keeps the stored one.
export type MailAccountSettings = Omit<MailAccount, 'imap' | 'smtp'> & { imap: Omit<MailEndpoint, 'password'>; smtp: Omit<MailEndpoint, 'password'> }
export type MailAccountUpdate = MailAccount & { reset?: boolean }
export function isMailAccountUpdate(value: unknown): value is MailAccountUpdate {
  if (!value || typeof value !== 'object') return false
  const item = value as MailAccountUpdate
  // Placeholder credentials only satisfy the shape check; the API validates the merged account again.
  const withPasswords = (endpoint: MailEndpoint) => endpoint && typeof endpoint === 'object' && typeof endpoint.password === 'string' && endpoint.password.length <= 4096 ? { ...endpoint, password: 'x' } : endpoint
  return (item.reset === undefined || typeof item.reset === 'boolean') && isMailAccount({ ...item, imap: withPasswords(item.imap), smtp: withPasswords(item.smtp) })
}
