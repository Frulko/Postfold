import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ConversationPatch, ConversationState } from '../../shared/mailbox'
import { patchState } from '../../shared/conversation-state.ts'

const subscribe = (listener: () => void) => {
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener) }
}
// navigator.onLine only knows "no network at all"; a reachable network with a down server still fails per request.
export const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine, () => true)

// A conversation change made offline, with the revisions it was based on. Replaying it later keeps the
// optimistic-locking guarantee: if a colleague changed one of these conversations meanwhile, the API refuses it.
export type PendingChange = { id: string; targets: { id: string; revision: number }[]; patch: ConversationPatch }
export const OUTBOX_LIMIT = 500

export function isOutbox(value: unknown): value is PendingChange[] {
  return Array.isArray(value) && value.length <= OUTBOX_LIMIT && value.every((item) => item && typeof item.id === 'string' && item.patch && typeof item.patch === 'object' &&
    Array.isArray(item.targets) && item.targets.every((target: { id: unknown; revision: unknown }) => typeof target?.id === 'string' && Number.isSafeInteger(target.revision)))
}

// Changes queued on the same conversation share its last known revision: once our own earlier change is
// accepted, the next one is rebased on the revision the API returned instead of being refused as a conflict.
export function rebaseTargets(change: PendingChange, accepted: Map<string, { from: number; to: number }>) {
  return change.targets.map(({ id, revision }) => {
    const ours = accepted.get(id)
    return { id, revision: ours && ours.from === revision ? ours.to : revision }
  })
}

export function recordAccepted(accepted: Map<string, { from: number; to: number }>, change: PendingChange, states: ConversationState[]) {
  for (const target of change.targets) {
    const state = states.find((item) => item.id === target.id)
    if (state) accepted.set(target.id, { from: accepted.get(target.id)?.from ?? target.revision, to: state.revision })
  }
}

// True when the patch changes nothing once the changes already queued are applied (re-opening a read mail offline).
export function isNoop(states: ConversationState[], outbox: PendingChange[], ids: string[], patch: ConversationPatch) {
  return ids.every((id) => {
    const known = states.find((item) => item.id === id)
    if (!known) return false
    const expected = outbox.reduce((state, change) => change.targets.some((target) => target.id === id) ? patchState(state, change.patch) : state, known)
    const next = patchState(expected, patch)
    return next.unread === expected.unread && next.status === expected.status && next.projectId === expected.projectId &&
      (next.assigneeId ?? null) === (expected.assigneeId ?? null) && JSON.stringify(next.labelIds) === JSON.stringify([...expected.labelIds ?? []].sort())
  })
}

// Offline access ends with the sign-in session (8 h at most, see api/keycloak.ts) and never later than 8 h after the
// last answer from the server. Online access cannot last longer, so going offline never extends it. Intune's default
// offline grace period is 12 h; this stays stricter, matching the session.
export const OFFLINE_HOURS = 8
const deadlineKey = 'postfold:offline-deadline'
export const SESSION_CACHE = 'postfold-session', PAGE_CACHE = 'postfold-pages'
export const offlineDeadline = (sessionExpiresAt?: number, checkedAt = Date.now()) => Math.min(sessionExpiresAt ?? Infinity, checkedAt + OFFLINE_HOURS * 3_600_000)

// The service worker reads the same deadline before serving the cached page on an offline reload.
export function rememberDeadline(deadline: number) {
  try { localStorage.setItem(deadlineKey, String(deadline)) } catch { /* The service worker copy below still applies. */ }
  if (typeof caches !== 'undefined') void caches.open(SESSION_CACHE).then((cache) => cache.put('/__postfold/offline-deadline', new Response(String(deadline)))).catch(() => {})
}

// Removes the cached page holding mail. Signing out also forgets the deadline.
export function forgetOfflineCopy(signOut = false) {
  if (signOut) try { localStorage.removeItem(deadlineKey) } catch { /* Nothing stored. */ }
  if (typeof caches !== 'undefined') { void caches.delete(PAGE_CACHE); if (signOut) void caches.delete(SESSION_CACHE) }
}

export function useOfflineLock(online: boolean) {
  const [locked, setLocked] = useState(false)
  useEffect(() => {
    if (online) { setLocked(false); return }
    const check = () => {
      let deadline = 0
      try { deadline = Number(localStorage.getItem(deadlineKey) ?? 0) } catch { /* Unknown: the open tab stays usable, reloads are refused by the service worker. */ }
      if (deadline && Date.now() > deadline) { setLocked(true); forgetOfflineCopy() }
    }
    check()
    const timer = setInterval(check, 60_000)
    return () => clearInterval(timer)
  }, [online])
  return locked
}
