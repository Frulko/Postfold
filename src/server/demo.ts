import { createServerFn } from '@tanstack/react-start'
import type { ConversationState, DemoMailbox, ProjectSettings } from '../../shared/mailbox'
import { isProjectSettings } from '../../shared/projects'
import { isConversationUpdate } from '../../shared/conversation-state'

// Adaptateur pour le rendu SSR : les données sont fournies par l’API NestJS.
export const getDemoMailbox = createServerFn({ method: 'GET' }).handler(async (): Promise<DemoMailbox> => {
  const response = await fetch(`${process.env.API_ORIGIN ?? 'http://127.0.0.1:4000'}/demo/mailbox`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error('L’API de démonstration est indisponible.')
  return response.json()
})

export const updateConversationState = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!isConversationUpdate(input)) throw new Error('Sélection ou état de conversation invalide.')
    return input
  })
  .handler(async ({ data }): Promise<{ ok: boolean; states?: ConversationState[]; error?: string }> => {
    const response = await fetch(`${process.env.API_ORIGIN ?? 'http://127.0.0.1:4000'}/demo/conversations/state`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(5000),
    })
    if (response.ok) return { ok: true, states: await response.json() }
    if (response.status === 400 || response.status === 409) {
      const failure = await response.json()
      return { ok: false, error: failure.message, states: failure.states }
    }
    throw new Error('La modification des états est indisponible. Aucun changement local n’a été appliqué ; vérifiez à la relève.')
  })

export const saveProjectSettings = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!isProjectSettings(input)) throw new Error('Réglages de dossiers invalides.')
    return input
  })
  .handler(async ({ data }): Promise<{ ok: boolean; settings?: ProjectSettings; error?: string }> => {
    const response = await fetch(`${process.env.API_ORIGIN ?? 'http://127.0.0.1:4000'}/demo/projects`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(5000),
    })
    if (response.ok) return { ok: true, settings: await response.json() }
    if (response.status === 400 || response.status === 409) {
      const failure = await response.json()
      return { ok: false, error: failure.message, settings: failure.settings }
    }
    throw new Error('L’enregistrement partagé est indisponible. Votre saisie est conservée.')
  })
