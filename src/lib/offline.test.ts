import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OFFLINE_HOURS, isNoop, isOutbox, offlineDeadline, rebaseTargets, recordAccepted, type PendingChange } from './offline.ts'
import { patchState } from '../../shared/conversation-state.ts'
import { isPreferences, pickPreferences } from '../../shared/preferences.ts'

test('offline changes replay in order on their own revisions and stop at a colleague’s change', () => {
  const read: PendingChange = { id: 'c1', targets: [{ id: 'a', revision: 3 }, { id: 'b', revision: 7 }], patch: { unread: false } }
  const move: PendingChange = { id: 'c2', targets: [{ id: 'a', revision: 3 }], patch: { projectId: 'p2' } }
  const accepted = new Map<string, { from: number; to: number }>()
  assert.deepEqual(rebaseTargets(read, accepted), read.targets)
  recordAccepted(accepted, read, [{ id: 'a', revision: 4, unread: false, status: 'open' }, { id: 'b', revision: 8, unread: false, status: 'open' }])
  // Our own accepted change moved "a" to revision 4: the next queued change follows it.
  assert.deepEqual(rebaseTargets(move, accepted), [{ id: 'a', revision: 4 }])
  recordAccepted(accepted, move, [{ id: 'a', revision: 5, unread: false, status: 'open' }])
  assert.deepEqual(accepted.get('a'), { from: 3, to: 5 })
  // A change based on another revision (a colleague's) is sent unchanged, so the API refuses it.
  assert.deepEqual(rebaseTargets({ id: 'c3', targets: [{ id: 'a', revision: 9 }], patch: { status: 'closed' } }, accepted), [{ id: 'a', revision: 9 }])
  assert.ok(isOutbox([read, move]))
  assert.equal(isOutbox([{ id: 'x', targets: [{ id: 'a', revision: 'x' }], patch: {} }]), false)
})

test('re-opening a mail already read offline queues nothing', () => {
  const states = [{ id: 'a', revision: 1, unread: true, status: 'open' as const, labelIds: ['l2'] }]
  assert.equal(isNoop(states, [], ['a'], { unread: false }), false)
  const queued: PendingChange[] = [{ id: 'c1', targets: [{ id: 'a', revision: 1 }], patch: { unread: false, addLabelIds: ['l1'] } }]
  assert.equal(isNoop(states, queued, ['a'], { unread: false }), true)
  assert.equal(isNoop(states, queued, ['a'], { addLabelIds: ['l1'] }), true)
  assert.equal(isNoop(states, queued, ['a'], { removeLabelIds: ['l1'] }), false)
  assert.equal(isNoop(states, queued, ['missing'], { unread: false }), false)
  assert.deepEqual(patchState(states[0], { addLabelIds: ['l1'], removeLabelIds: ['l2'], assigneeId: 'm1' }).labelIds, ['l1'])
})

test('offline access never outlasts the sign-in session nor 8 h without the server', () => {
  const now = Date.parse('2026-10-19T09:00:00Z')
  assert.equal(offlineDeadline(undefined, now), now + OFFLINE_HOURS * 3_600_000)
  assert.equal(offlineDeadline(now + 3_600_000, now), now + 3_600_000)
  assert.equal(offlineDeadline(now + 24 * 3_600_000, now), now + OFFLINE_HOURS * 3_600_000)
})

test('preferences accept only known display choices', () => {
  assert.ok(isPreferences({ displayMode: 'threads', listOrder: 'oldest', openFolders: ['1', 'f_a'], autoRefresh: false }))
  assert.equal(isPreferences({ displayMode: 'grid' }), false)
  assert.equal(isPreferences({ notes: [] }), false)
  assert.equal(isPreferences({ openFolders: [''] }), false)
  assert.deepEqual(pickPreferences({ displayMode: 'threads', listOrder: undefined }), { displayMode: 'threads' })
})
