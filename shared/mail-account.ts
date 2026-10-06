export type MailEndpoint = { host: string; port: number; security: 'tls' | 'starttls'; user: string; password: string }
export type MailAccount = { email: string; name: string; imap: MailEndpoint; smtp: MailEndpoint; sentPath: string; saveSent: boolean }
export type ReplyRequest = { id: string; revision: number; text: string; requestId: string }

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
  return Object.keys(item).every((key) => ['id', 'revision', 'text', 'requestId'].includes(key)) &&
    typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 100 && Number.isSafeInteger(item.revision) && item.revision >= 0 &&
    typeof item.text === 'string' && item.text.trim().length > 0 && item.text.length <= 100_000 &&
    typeof item.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.requestId)
}
