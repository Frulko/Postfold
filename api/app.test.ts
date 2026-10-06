import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from './app.js'
import { ProjectStore } from './project-store.js'
import { Pool } from 'pg'

test('l’API fonctionne et les données de démo exigent une activation explicite', async () => {
  for (const demoMode of [false, true]) {
    const mailboxId = `test-${crypto.randomUUID()}`
    const app = await createApp(demoMode, mailboxId)
    try {
      await app.listen(0, '127.0.0.1')
      const origin = await app.getUrl()
      const health = await fetch(`${origin}/health`)
      assert.equal(health.status, 200)
      assert.deepEqual(await health.json(), { status: 'ok' })
      const mailbox = await fetch(`${origin}/demo/mailbox`)
      assert.equal(mailbox.status, demoMode ? 200 : 404)
      if (demoMode) {
        const data = await mailbox.json()
        assert.equal(data.projects[0].id, '1842')
        assert.ok(data.contacts.every((contact: { email: string }) => contact.email.endsWith('@example.test')))
        const patch = (input: unknown) => fetch(`${origin}/demo/conversations/state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
        const initialStates = data.conversationStates
        const target = (id: string, states = initialStates) => ({ id, revision: states.find((item: { id: string }) => item.id === id).revision })
        const read = await patch({ targets: [target('plans')], unread: false })
        assert.equal(read.status, 200)
        const readStates = await read.json()
        assert.equal(readStates[0].unread, false)
        assert.equal(readStates[0].status, 'open')
        assert.equal((await patch({ targets: [target('plans')], unread: false })).status, 200)
        const failedBatch = await patch({ targets: [target('plans'), target('quote')], status: 'closed' })
        assert.equal(failedBatch.status, 409)
        let shared = await (await fetch(`${origin}/demo/mailbox`)).json()
        assert.equal(shared.conversations.find((item: { id: string }) => item.id === 'quote').status, 'open')
        assert.equal(shared.conversations.find((item: { id: string }) => item.id === 'plans').status, 'open')
        const batch = await patch({ targets: [target('plans', shared.conversationStates), target('quote', shared.conversationStates)], unread: true, status: 'closed' })
        assert.equal(batch.status, 200)
        const batchStates = await batch.json()
        assert.ok(batchStates.every((state: { unread: boolean; status: string }) => state.unread && state.status === 'closed'))
        const competing = await Promise.all([
          patch({ targets: [target('plans', batchStates)], status: 'open' }),
          patch({ targets: [target('plans', batchStates)], status: 'waiting' }),
        ])
        assert.deepEqual(competing.map((response) => response.status).sort(), [200, 409])
        shared = await (await fetch(`${origin}/demo/mailbox`)).json()
        assert.equal(shared.conversations.find((item: { id: string }) => item.id === 'delivery').status, 'waiting')
        assert.equal((await patch({ targets: [target('quote', shared.conversationStates), { id: 'absent', revision: 0 }], unread: false })).status, 400)
        assert.equal((await patch({ targets: [target('quote', shared.conversationStates)], status: 'invalid' })).status, 400)
        const reopened = new ProjectStore(mailboxId)
        try { await reopened.init(); assert.deepEqual(await reopened.readConversationStates(), shared.conversationStates) } finally { await reopened.onApplicationShutdown() }
        const initial = { ...data.projectSettings, projects: data.projects }
        const put = (settings: unknown) => fetch(`${origin}/demo/projects`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })
        const changed = { ...initial, sort: 'name-desc', projects: [...initial.projects, { id: '2401', name: 'Tilleuls', color: 'purple' }], order: ['2401', ...initial.order] }
        const created = await put(changed)
        assert.equal(created.status, 200)
        const saved = await created.json()
        assert.equal(saved.projects.at(-1).id, '2401')
        assert.ok(saved.projects.at(-1).createdAt)
        const responses = await Promise.all([put({ ...saved, sort: 'name-asc' }), put({ ...saved, sort: 'recent' })])
        assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409])
        const accepted = await responses.find((response) => response.status === 200)!.json()
        const conflict = await responses.find((response) => response.status === 409)!.json()
        assert.equal(accepted.revision, initial.revision + 2)
        assert.equal(conflict.settings.revision, accepted.revision)
        const secondReader = new ProjectStore(mailboxId)
        try { await secondReader.init(); assert.deepEqual(await secondReader.read(), accepted) } finally { await secondReader.onApplicationShutdown() }
        assert.equal((await put({ ...accepted, order: [accepted.order[0], accepted.order[0]] })).status, 400)
        assert.equal((await put({ ...accepted, projects: accepted.projects.slice(1), order: accepted.order.slice(1) })).status, 400)
        assert.equal((await put({ ...accepted, projects: [...accepted.projects, { id: '2401', name: 'Duplicate', color: 'blue' }], order: [...accepted.order, '2401'] })).status, 400)
      } else {
        assert.equal((await fetch(`${origin}/demo/projects`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404)
        assert.equal((await fetch(`${origin}/demo/conversations/state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404)
      }
    } finally {
      await app.close()
      if (demoMode) {
        const cleanup = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://mailer_demo:mailer_demo@127.0.0.1:55432/mailer_support' })
        try { await cleanup.query('DELETE FROM demo_project_settings WHERE mailbox_id = $1', [mailboxId]) } finally { await cleanup.end() }
      }
    }
  }
})

test('shared filing and label cleanup preserve hierarchy and reject unsafe deletion', async () => {
  const mailboxId = `test-${crypto.randomUUID()}`
  const store = new ProjectStore(mailboxId)
  const cleanup = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://mailer_demo:mailer_demo@127.0.0.1:55432/mailer_support' })
  try {
    await store.init()
    const initial = await store.read()
    let settings = await store.update({ ...initial, projects: [...initial.projects, { id: 'plans-folder', name: 'Plans', parentId: '1842', color: 'blue' }], order: [...initial.order, 'plans-folder'], labels: [{ id: 'urgent', name: 'Urgent', color: 'rose' }] })
    const states = await store.readConversationStates()
    const targets = states.filter((item) => ['plans', 'delivery'].includes(item.id)).map(({ id, revision }) => ({ id, revision }))
    const updated = await store.updateConversations({ targets, projectId: 'plans-folder', addLabelIds: ['urgent'] })
    assert.ok(updated.every((item) => item.projectId === 'plans-folder' && item.labelIds?.includes('urgent')))
    await assert.rejects(store.updateConversations({ targets: updated.map(({ id, revision }) => ({ id, revision })), addLabelIds: ['unknown'] }))
    await assert.rejects(store.update({ ...settings, projects: settings.projects.filter((item) => item.id !== 'plans-folder'), order: settings.order.filter((id) => id !== 'plans-folder') }))
    await assert.rejects(store.update({ ...settings, projects: settings.projects.map((item) => item.id === '1842' ? { ...item, parentId: 'plans-folder' } : item) }))
    settings = await store.update({ ...settings, labels: [] })
    const cleaned = (await store.readConversationStates()).filter((item) => ['plans', 'delivery'].includes(item.id))
    assert.ok(cleaned.every((item) => item.labelIds?.length === 0 && item.projectId === 'plans-folder'))
    assert.equal(cleaned[0].revision, updated[0].revision + 1)
    await assert.rejects(store.updateConversations({ targets: updated.map(({ id, revision }) => ({ id, revision })), projectId: '1842' }))
    await store.updateConversations({ targets: cleaned.map(({ id, revision }) => ({ id, revision })), projectId: '1842' })
    settings = await store.update({ ...settings, projects: settings.projects.filter((item) => item.id !== 'plans-folder'), order: settings.order.filter((id) => id !== 'plans-folder') })
    assert.ok(!settings.projects.some((item) => item.id === 'plans-folder'))
    assert.ok((await store.readConversationStates()).filter((item) => ['plans', 'delivery'].includes(item.id)).every((item) => item.projectId === '1842'))
  } finally {
    await store.onApplicationShutdown()
    await cleanup.query('DELETE FROM demo_project_settings WHERE mailbox_id = $1', [mailboxId])
    await cleanup.end()
  }
})
