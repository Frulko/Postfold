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
  mailbox.conversations[0].sender = { name: 'Julie', email: 'support@example.test' }
  assert.equal(filterConversations(mailbox, null, 'support@example.test').length, 1)
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

test('nested folders reject cycles and duplicate siblings and expose descendant conversations', async () => {
  const { isLabels, isProjectHierarchy, projectPath, projectTree } = await import('../../shared/projects.ts')
  const projects = [{ id: '1', name: 'Project', color: 'blue' }, { id: 'plans', name: 'Plans', color: 'green', parentId: '1' }, { id: 'archive', name: 'Archive', color: 'slate', parentId: 'plans' }]
  assert.ok(isProjectHierarchy(projects))
  assert.equal(prepareProject({ id: 'new', name: 'VPN', color: 'blue', parentId: '1' }, projects, null).parentId, '1')
  assert.equal(isProjectSettings({ revision: 0, sort: 'manual', projects: [{ ...projects[0], parentId: '' }], order: ['1'] }), false)
  const mailbox: Mailbox = { projects, contacts: [], conversations: [{ id: 'mail', contactId: 'p', projectId: 'archive', subject: 'VPN', preview: '', body: '', time: '', status: 'open', unread: true, assignee: null }] }
  assert.equal(filterConversations(mailbox, '1', '').length, 1)
  assert.equal(filterConversations(mailbox, 'plans', '').length, 1)
  assert.equal(isProjectHierarchy([...projects, { id: 'copy', name: 'Plans', color: 'rose', parentId: '1' }]), false)
  assert.equal(isProjectHierarchy(projects.map((item) => item.id === '1' ? { ...item, parentId: 'archive' } : item)), false)
  assert.equal(isProjectHierarchy([{ ...projects[1], parentId: 'absent' }]), false)
  assert.equal(projectPath(projects, 'archive'), '1 — Project / Plans / Archive')
  assert.deepEqual(projectTree(projects, 'manual', ['archive', 'plans', '1']).map(({ project, depth }) => [project.id, depth]), [['1', 0], ['plans', 1], ['archive', 2]])
  assert.deepEqual(projectTree(projects, 'manual', [], ['1']).map(({ project }) => project.id), ['1'])
  assert.deepEqual(projectTree(projects, 'manual', [], ['1'], 'archive').map(({ project }) => project.id), ['1', 'plans', 'archive'])
  assert.ok(isLabels([{ id: 'l1', name: 'Urgent', color: 'rose' }]))
  assert.equal(isLabels([{ id: 'l1', name: 'Urgent', color: 'rose' }, { id: 'l2', name: 'urgent', color: 'blue' }]), false)
  assert.equal(isConversationUpdate({ targets: [{ id: 'a', revision: 0 }], addLabelIds: ['l1', 'l1'] }), false)
  assert.ok(isConversationUpdate({ targets: [{ id: 'a', revision: 0 }], projectId: 'plans', addLabelIds: ['l1'] }))
})


test('locale validation and interpolation preserve user data and unknown messages', async () => {
  const { parseLocale, translate } = await import('../../shared/i18n.ts')
  assert.equal(parseLocale('en'), 'en')
  assert.equal(parseLocale('fr'), 'fr')
  assert.equal(parseLocale(['en']), 'fr')
  assert.equal(translate('en', 'Boîte de réception'), 'Inbox')
  assert.equal(translate('fr', 'Boîte de réception'), 'Boîte de réception')
  assert.equal(translate('en', 'Attribuer le label {0}', 'Priorité {1}'), 'Assign label Priorité {1}')
  assert.equal(translate('en', 'Custom project'), 'Custom project')
  assert.equal(translate('en', '{0} sélectionnée{1}', 2, 's'), '2 selected')
})


test('thread rows group by identity, preserve message IDs and order by latest activity', async () => {
  const { mailboxRows } = await import('./mailbox.ts')
  const base = { projectId: '1', contactId: 'p', subject: 'Same subject', preview: 'First', body: '', time: '', status: 'open' as const, assignee: null, unread: false }
  const messages = [
    { ...base, id: 'root', sentAt: '2026-10-06T09:00:00+02:00' },
    { ...base, id: 'other', sentAt: '2026-10-06T10:00:00+02:00' },
    { ...base, id: 'reply', threadId: 'root', sentAt: '2026-10-06T09:30:00Z', preview: 'Latest reply', unread: true, labelIds: ['urgent'] },
  ]
  const threads = mailboxRows(messages, 'threads')
  assert.equal(threads.length, 2)
  assert.equal(threads[0].id, 'root')
  assert.equal(threads[0].unread, true)
  assert.equal(threads[0].preview, 'Latest reply')
  assert.deepEqual(threads[0].messageIds, ['root', 'reply'])
  assert.deepEqual(threads[0].labelIds, ['urgent'])
  assert.equal(threads[1].id, 'other', 'An identical subject must not merge unrelated mail')
  assert.deepEqual(mailboxRows(messages, 'messages').map(x=>x.id), ['reply', 'other', 'root'])
  assert.equal(messages[0].preview, 'First', 'Grouping must not mutate the source')
})
