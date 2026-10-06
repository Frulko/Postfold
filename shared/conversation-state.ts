import type { Conversation, ConversationState, ConversationUpdate } from './mailbox.js'

export const conversationStatuses = { open: 'À traiter', waiting: 'En attente', closed: 'Terminé' }

export function isConversationUpdate(value: unknown): value is ConversationUpdate {
  if (!value || typeof value !== 'object') return false
  const input = value as ConversationUpdate
  const ids = (value: unknown) => Array.isArray(value) && value.length <= 100 && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100) && new Set(value).size === value.length
  return Object.keys(input).every((key) => ['targets', 'unread', 'status', 'projectId', 'addLabelIds', 'removeLabelIds'].includes(key)) &&
    Array.isArray(input.targets) && input.targets.length > 0 && input.targets.length <= 500 &&
    input.targets.every((target) => target && typeof target.id === 'string' && target.id.length > 0 && target.id.length <= 100 && Number.isSafeInteger(target.revision) && target.revision >= 0) &&
    new Set(input.targets.map((target) => target.id)).size === input.targets.length &&
    (input.unread !== undefined || input.status !== undefined || input.projectId !== undefined || input.addLabelIds !== undefined || input.removeLabelIds !== undefined) &&
    (input.projectId === undefined || (typeof input.projectId === 'string' && input.projectId.length > 0 && input.projectId.length <= 100)) &&
    (input.addLabelIds === undefined || ids(input.addLabelIds)) && (input.removeLabelIds === undefined || ids(input.removeLabelIds)) &&
    (input.unread === undefined || typeof input.unread === 'boolean') &&
    (input.status === undefined || (typeof input.status === 'string' && Object.hasOwn(conversationStatuses, input.status)))
}

export function mergeConversationStates(current: ConversationState[], incoming: ConversationState[]) {
  const result = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) {
    if (item.revision >= (result.get(item.id)?.revision ?? -1)) result.set(item.id, item)
  }
  return [...result.values()]
}

export function applyConversationStates(conversations: Conversation[], states: ConversationState[]) {
  const byId = new Map(states.map((state) => [state.id, state]))
  return conversations.map((item) => {
    const state = byId.get(item.id)
    return state ? { ...item, unread: state.unread, status: state.status, projectId: state.projectId ?? item.projectId, labelIds: state.labelIds ?? item.labelIds ?? [] } : item
  })
}
