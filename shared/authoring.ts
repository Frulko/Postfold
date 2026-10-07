import type { Member } from './mailbox.js'

export type EmailTemplate = { id: string; name: string; html: string; text: string; scope: 'personal' | 'team'; ownerId: string }
export type EmailSignature = { id: string; name: string; html: string; text: string }
export type AuthoringSettings = { revision: number; templates: EmailTemplate[]; signatures: EmailSignature[]; assignments: Record<string, string>; members: Member[]; currentMemberId: string; canAdmin: boolean }
export type AuthoringChange = { revision: number } & (
  { action: 'template'; item: Pick<EmailTemplate, 'id' | 'name' | 'html' | 'scope'> } |
  { action: 'signature'; item: Pick<EmailSignature, 'id' | 'name' | 'html'> } |
  { action: 'delete-template' | 'delete-signature'; id: string } |
  { action: 'member'; id: string; role: 'admin' | 'member'; active: boolean; signatureId: string | null }
)
export type RichDraft = { text: string; html: string; signatureId?: string | null; signatureHtml?: string; signatureText?: string }
export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export type MailAttachment = { filename: string; contentType: string; content: string }
export function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!) }
export function richDraft(value: string | RichDraft | undefined): RichDraft { return typeof value === 'string' ? { text: value, html: `<p>${escapeHtml(value).replace(/\n/g, '<br>')}</p>` } : value ?? { text: '', html: '' } }
export function isRichDraft(value: unknown): value is RichDraft { return !!value && typeof value === 'object' && typeof (value as RichDraft).text === 'string' && typeof (value as RichDraft).html === 'string' && ['signatureId', 'signatureHtml', 'signatureText'].every(key => !(key in value) || (key === 'signatureId' && (value as RichDraft).signatureId === null) || typeof (value as Record<string, unknown>)[key] === 'string') }
export function isAuthoringChange(value: unknown): value is AuthoringChange {
  if (!value || typeof value !== 'object') return false
  const v = value as AuthoringChange
  if (!Number.isSafeInteger(v.revision) || v.revision < 0) return false
  const id = (value: unknown) => typeof value === 'string' && /^[\w-]{1,100}$/.test(value)
  if (v.action === 'delete-template' || v.action === 'delete-signature') return Object.keys(v).every(k => ['revision', 'action', 'id'].includes(k)) && id(v.id)
  if (v.action === 'member') return Object.keys(v).every(k => ['revision', 'action', 'id', 'role', 'active', 'signatureId'].includes(k)) && typeof v.id === 'string' && v.id.length <= 150 && ['admin', 'member'].includes(v.role) && typeof v.active === 'boolean' && (v.signatureId === null || id(v.signatureId))
  if (v.action !== 'template' && v.action !== 'signature') return false
  const item = v.item
  return Object.keys(v).every(k => ['revision', 'action', 'item'].includes(k)) && !!item && Object.keys(item).every(k => ['id', 'name', 'html', ...(v.action === 'template' ? ['scope'] : [])].includes(k)) && id(item.id) && typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= 100 && typeof item.html === 'string' && item.html.length <= 100_000 && (v.action !== 'template' || ['personal', 'team'].includes(v.item.scope))
}
