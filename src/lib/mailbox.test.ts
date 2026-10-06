import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterConversations, filterProjects, moveConversations, updateSelection, type Mailbox } from './mailbox.ts'
import { isProjectSettings, positionProject, prepareProject, sortProjects } from '../../shared/projects.ts'
import { applyConversationStates, isConversationUpdate, mergeConversationStates } from '../../shared/conversation-state.ts'

test('la recherche combine le projet et le contact sans dépendre des accents', () => {
  const mailbox: Mailbox = {
    projects: [{ id: '1842', name: 'Résidence Bellevue', color: 'green' }],
    contacts: [{ id: 'paul', name: 'Paul', email: 'paul@example.test', company: 'Atelier', phone: '' }],
    conversations: [{ id: 'plans', projectId: '1842', contactId: 'paul', subject: 'Plans',
      preview: '', body: '', time: '', status: 'open', assignee: null, unread: true }],
  }
  assert.equal(filterConversations(mailbox, '1842', 'residence').length, 1)
  assert.equal(filterConversations(mailbox, null, 'paul@example.test').length, 1)
  assert.equal(filterConversations(mailbox, '9999', 'Paul').length, 0)
  assert.equal(filterConversations(mailbox, null, 'inconnu').length, 0)
  assert.equal(filterProjects(mailbox.projects, 'RESIDENCE')[0]?.id, '1842')
  assert.equal(filterProjects(mailbox.projects, ' 1842 ')[0]?.id, '1842')
  assert.equal(filterProjects(mailbox.projects, 'inconnu').length, 0)
})

test('sélection par plage et déplacement du lot sans modifier les autres échanges', () => {
  const visible = ['a', 'b', 'c']
  const selected = updateSelection(['a'], visible, 'c', true, 'a', true)
  assert.deepEqual(selected, ['a', 'b', 'c'])
  assert.deepEqual(updateSelection(selected, visible, 'b', false, null, false), ['a', 'c'])
  assert.deepEqual(updateSelection(['a'], ['c'], 'c', true, 'a', true), ['a', 'c'])
  const mailbox: Mailbox = {
    projects: [{ id: 'source', name: 'Source', color: 'blue' }, { id: 'destination', name: 'Destination', color: 'green' }],
    contacts: [],
    conversations: visible.map((id) => ({ id, projectId: 'source', contactId: 'paul', subject: id,
      preview: '', body: '', time: '', status: 'open', assignee: null, unread: false })),
  }
  const moved = moveConversations(mailbox, ['a', 'c'], 'destination')
  assert.deepEqual(moved.conversations.map((item) => item.projectId), ['destination', 'source', 'destination'])
  assert.ok(mailbox.conversations.every((item) => item.projectId === 'source'))
  assert.throws(() => moveConversations(mailbox, ['a'], 'inconnu'))
  assert.throws(() => moveConversations(mailbox, ['inconnu'], 'destination'))
})

test('création, validation et tri des dossiers conservent les identifiants et l’ordre manuel', () => {
  const projects = [
    { id: '2', name: 'École', color: 'green', createdAt: '2026-01-01T00:00:00Z' },
    { id: '10', name: 'Atelier', color: 'orange', createdAt: '2026-06-01T00:00:00Z' },
  ]
  const folder = prepareProject({ id: ' 20 ', name: ' Maison ', color: '#aabbcc' }, projects, null)
  assert.equal(folder.name, 'Maison')
  assert.equal(folder.id, '20')
  assert.ok(folder.createdAt)
  assert.throws(() => prepareProject({ id: '2', name: 'Duplicate', color: 'blue' }, projects, null))
  assert.throws(() => prepareProject({ id: '../x', name: 'Nested/folder', color: 'blue' }, projects, null))
  assert.throws(() => prepareProject({ id: '3', name: 'École', color: 'blue' }, projects, '2'))
  assert.equal(prepareProject({ id: '2', name: 'École rénovée', color: 'purple' }, projects, '2').createdAt, projects[0].createdAt)
  const ids = (sort: Parameters<typeof sortProjects>[1]) => sortProjects(projects, sort, ['10', '2']).map((item) => item.id)
  assert.deepEqual(ids('manual'), ['10', '2'])
  assert.deepEqual(ids('name-asc'), ['10', '2'])
  assert.deepEqual(ids('name-desc'), ['2', '10'])
  assert.deepEqual(ids('recent'), ['10', '2'])
  assert.deepEqual(ids('oldest'), ['2', '10'])
  assert.deepEqual(ids('code'), ['2', '10'])
  assert.deepEqual(positionProject(projects, '10', 0).map((item) => item.id), ['10', '2'])
  assert.deepEqual(projects.map((item) => item.id), ['2', '10'])
  assert.throws(() => positionProject(projects, 'unknown', 0))
  assert.throws(() => positionProject(projects, '2', -1))
  assert.ok(isProjectSettings({ projects, order: ['2', '10'], sort: 'manual', revision: 0 }))
  assert.equal(isProjectSettings({ projects, order: ['2', '2'], sort: 'manual', revision: 0 }), false)
})

test('la relève conserve la dernière révision des états de lecture et de suivi', () => {
  const current = [{ id: 'a', unread: true, status: 'waiting' as const, revision: 2 }]
  const stale = [{ id: 'a', unread: false, status: 'open' as const, revision: 1 }]
  assert.deepEqual(mergeConversationStates(current, stale), current)
  const next = [{ id: 'a', unread: false, status: 'closed' as const, revision: 3 }]
  assert.deepEqual(mergeConversationStates(current, next), next)
  const conversation = { id: 'a', projectId: '2', contactId: 'p', subject: '', body: '', preview: '', time: '', status: 'open' as const, unread: true, assignee: null }
  assert.equal(applyConversationStates([conversation], next)[0].status, 'closed')
  assert.equal(conversation.unread, true)
  assert.ok(isConversationUpdate({ targets: [{ id: 'a', revision: 0 }], unread: false }))
  assert.equal(isConversationUpdate({ targets: [{ id: 'a', revision: 0 }] }), false)
  assert.equal(isConversationUpdate({ targets: [{ id: 'a', revision: 0 }], unread: 'false' }), false)
  assert.equal(isConversationUpdate({ targets: [{ id: 'a', revision: 0 }], status: 'invalid' }), false)
  assert.equal(isConversationUpdate({ targets: [{ id: 'a', revision: 0 }, { id: 'a', revision: 0 }], unread: true }), false)
})
