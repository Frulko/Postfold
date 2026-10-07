import { isAuthoringChange } from '../../shared/authoring'
import { createServerFn } from '@tanstack/react-start'
import type { Activity, ConversationState, DemoMailbox, ProjectSettings } from '../../shared/mailbox'
import { isProjectSettings } from '../../shared/projects'
import { isActivityIds, isConversationUpdate } from '../../shared/conversation-state'
import { getRequestHeader } from '@tanstack/react-start/server'
import { isReplyRequest } from '../../shared/mail-account'
import { authMode } from '../../shared/auth'
import { isArchiveId, isArchiveSearch, isArchiveRestore, type MailArchivePage } from '../../shared/mail-archive'

function apiPath(path: string) {
  return `${process.env.API_ORIGIN ?? 'http://127.0.0.1:4000'}${process.env.MAILBOX_MODE === 'imap' ? '/mailbox' : '/demo'}${path}`
}
function apiHeaders(): Record<string, string> {
  if (authMode() === 'keycloak') return { 'Content-Type': 'application/json', Cookie: getRequestHeader('cookie') ?? '', Origin: process.env.POSTFOLD_ORIGIN ?? '' }
  return { 'Content-Type': 'application/json', ...(process.env.MAILBOX_MODE === 'imap' ? { Authorization: getRequestHeader('authorization') ?? '' } : {}) }
}

// Adaptateur pour le rendu SSR : les données sont fournies par l’API NestJS.
export const getDemoMailbox = createServerFn({ method: 'GET' }).handler(async (): Promise<DemoMailbox> => {
  const response = await fetch(apiPath(process.env.MAILBOX_MODE === 'imap' ? '' : '/mailbox'), {
    headers: apiHeaders(), signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error('L’API de la boîte mail est indisponible.')
  return response.json()
})

export const updateConversationState = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!isConversationUpdate(input)) throw new Error('Sélection ou état de conversation invalide.')
    return input
  })

  .handler(async ({ data }): Promise<{ ok: boolean; states?: ConversationState[]; error?: string }> => {
    const response = await fetch(apiPath('/conversations/state'), {
      method: 'PATCH', headers: apiHeaders(), body: JSON.stringify(data), signal: AbortSignal.timeout(90_000),
    })
    if (response.ok) return { ok: true, states: await response.json() }
    if ([400, 409, 503].includes(response.status)) {
      const failure = await response.json()
      return { ok: false, error: failure.message, states: failure.states }
    }
    throw new Error('La modification des états est indisponible. Aucun changement local n’a été appliqué ; vérifiez à la relève.')
  })

export const getConversationActivity = createServerFn({ method: 'POST' })
  .validator((input: unknown) => { if (!isActivityIds(input)) throw new Error('Invalid activity selection.'); return input })
  .handler(async ({ data }): Promise<Activity[]> => {
    const response = await fetch(apiPath('/conversations/activity'), { method: 'POST', headers: apiHeaders(), body: JSON.stringify(data), signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error('Activity is unavailable.')
    return response.json()
  })

export const saveProjectSettings = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!isProjectSettings(input)) throw new Error('Réglages de dossiers invalides.')
    return input
  })
  .handler(async ({ data }): Promise<{ ok: boolean; settings?: ProjectSettings; error?: string }> => {
    const response = await fetch(apiPath('/projects'), {
      method: 'PUT', headers: apiHeaders(), body: JSON.stringify(data), signal: AbortSignal.timeout(90_000),
    })
    if (response.ok) return { ok: true, settings: await response.json() }
    if ([400, 409, 503].includes(response.status)) {
      const failure = await response.json()
      return { ok: false, error: failure.message, settings: failure.settings }
    }
    throw new Error('L’enregistrement partagé est indisponible. Votre saisie est conservée.')
  })

export const syncMailbox = createServerFn({ method: 'POST' }).handler(async (): Promise<DemoMailbox> => {
  if (process.env.MAILBOX_MODE !== 'imap') return getDemoMailbox()
  const response = await fetch(apiPath('/sync'), { method: 'POST', headers: apiHeaders(), signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error('Mailbox synchronization failed; cached messages were preserved.')
  return response.json()
})

export const sendReply = createServerFn({ method: 'POST' })
  .validator((input: unknown) => { if (!isReplyRequest(input)) throw new Error('Invalid reply.'); return input })
  .handler(async ({ data }): Promise<{ ok: boolean; sentCopy?: boolean; error?: string }> => {
    if (process.env.MAILBOX_MODE !== 'imap') return { ok: false, error: 'No mailbox connected.' }
    try {
      const response = await fetch(apiPath('/reply'), { method: 'POST', headers: apiHeaders(), body: JSON.stringify(data), signal: AbortSignal.timeout(120_000) })
      if (response.ok) return { ok: true, sentCopy: (await response.json()).sentCopy }
      if ([400, 409, 503].includes(response.status)) return { ok: false, error: (await response.json()).message }
    } catch { /* Preserve the draft and the request ID when delivery cannot be confirmed. */ }
    return { ok: false, error: 'Delivery could not be confirmed. Do not resend; inspect Sent and the mail server. Your draft is preserved.' }
  })

export const getAuthoring = createServerFn({ method: 'GET' }).handler(async (): Promise<import('../../shared/authoring').AuthoringSettings> => {
  const response = await fetch(`${process.env.API_ORIGIN ?? 'http://127.0.0.1:4000'}/authoring`, { headers: apiHeaders(), signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('Authoring settings unavailable.')
  return response.json()
})

export const saveAuthoring = createServerFn({ method: 'POST' }).validator((input: unknown) => { if (!isAuthoringChange(input)) throw new Error('Invalid authoring settings.'); return input })
  .handler(async ({ data }): Promise<{ ok: boolean; settings?: import('../../shared/authoring').AuthoringSettings; error?: string }> => {
    const response = await fetch(`${process.env.API_ORIGIN ?? 'http://127.0.0.1:4000'}/authoring`, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(data), signal: AbortSignal.timeout(15_000) })
    if (response.ok) return { ok: true, settings: await response.json() }
    return { ok: false, error: (await response.json()).message ?? 'Settings could not be saved.' }
  })

export const getMailArchives = createServerFn({ method: 'POST' })
  .validator((input: unknown) => { if (!isArchiveSearch(input)) throw new Error('Invalid archive search.'); return input })
  .handler(async ({ data }): Promise<MailArchivePage> => {
    if (process.env.MAILBOX_MODE !== 'imap') return { items: [], nextCursor: null, stats: { messages: 0, bytes: 0, missing: 0, cachedWithoutSource: 0 } }
    const response = await fetch(apiPath('/archives/search'), { method: 'POST', headers: apiHeaders(), body: JSON.stringify(data), signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error('Mail archives unavailable.')
    return response.json()
  })

export const downloadMailArchive = createServerFn({ method: 'POST' })
  .validator((input: unknown) => { if (!isArchiveId(input)) throw new Error('Invalid archive ID.'); return input })
  .handler(async ({ data }): Promise<{ content: string }> => {
    if (process.env.MAILBOX_MODE !== 'imap') throw new Error('No mailbox connected.')
    const response = await fetch(apiPath(`/archives/${data}/source`), { headers: apiHeaders(), signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error('Archived message could not be downloaded.')
    return { content: Buffer.from(await response.arrayBuffer()).toString('base64') }
  })

export const restoreMailArchive = createServerFn({ method: 'POST' })
  .validator((input: unknown) => { if (!isArchiveRestore(input)) throw new Error('Invalid archive restoration.'); return input })
  .handler(async ({ data }): Promise<{ ok: boolean; id?: string; synchronized?: boolean; error?: string }> => {
    if (process.env.MAILBOX_MODE !== 'imap') return { ok: false, error: 'No mailbox connected.' }
    try {
      const response = await fetch(apiPath('/archives/restore'), { method: 'POST', headers: apiHeaders(), body: JSON.stringify(data), signal: AbortSignal.timeout(120_000) })
      if (response.ok) return { ok: true, ...await response.json() }
      if ([400,404,409,503].includes(response.status)) return { ok: false, error: (await response.json()).message }
    } catch { /* Never automatically retry an IMAP APPEND after a timeout. */ }
    return { ok: false, error: 'Restoration could not be confirmed. The archive is safe; inspect IMAP before retrying.' }
  })
