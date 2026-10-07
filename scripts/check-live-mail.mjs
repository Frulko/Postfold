import assert from 'node:assert/strict'
import { execFileSync, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { MailStore } from '../api/dist/api/mail-store.js'
import { saveAccount } from '../api/dist/api/mail-secrets.js'
import { createApp } from '../api/dist/api/app.js'

// Real IMAPS/SMTPS in an isolated, non-forwarding GreenMail container.
const directory = mkdtempSync(join(tmpdir(), 'postfold-mail-'))
const container = `postfold-mail-${randomUUID()}`
const accountId = `test-${randomUUID()}`
const database = process.env.DATABASE_URL ?? 'postgresql://mailer_demo:mailer_demo@127.0.0.1:55432/mailer_support'
const pool = new Pool({ connectionString: database })
let started = false
let store
let peer
let app
let web
let browserArchiveId
let browserArchiveSource
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
try {
  writeFileSync(join(directory, 'openssl.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n')
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', join(directory, 'openssl.cnf'), '-keyout', join(directory, 'server.key'), '-out', join(directory, 'ca.pem')])
  command('openssl', ['pkcs12', '-export', '-name', 'greenmail', '-inkey', join(directory, 'server.key'), '-in', join(directory, 'ca.pem'), '-out', join(directory, 'server.p12'), '-passout', 'pass:test-only-keystore'])
  // The host directory stays private; only the fictional keystore is mounted for GreenMail's non-root user.
  chmodSync(join(directory, 'server.p12'), 0o644)
  const salt = randomBytes(16).toString('hex')
  writeFileSync(join(directory, 'mailbox.key'), randomBytes(32).toString('hex'), { mode: 0o600 })
  writeFileSync(join(directory, 'access.json'), JSON.stringify({ user: 'operator', salt, hash: scryptSync('test-only-access-password', salt, 64).toString('hex') }), { mode: 0o600 })
  process.env.DATABASE_URL = database
  process.env.MAILBOX_ID = accountId
  process.env.MAILBOX_KEY_FILE = join(directory, 'mailbox.key')
  process.env.POSTFOLD_ACCESS_FILE = join(directory, 'access.json')
  process.env.MAILBOX_CA_FILE = join(directory, 'ca.pem')
  command('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::3993', '-p', '127.0.0.1::3465', '-p', '127.0.0.1::3025', '-p', '127.0.0.1::3143', '-v', `${join(directory, 'server.p12')}:/certs/server.p12:ro`, '-e', 'GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=support:test-only-mail-password@postfold.test,customer:test-only-customer-password@postfold.test -Dgreenmail.tls.keystore.file=/certs/server.p12 -Dgreenmail.tls.keystore.password=test-only-keystore -Dgreenmail.tls.key.password=test-only-keystore', 'greenmail/standalone:2.1.14'])
  started = true
  const ports = JSON.parse(command('docker', ['inspect', container]))[0].NetworkSettings.Ports
  const imapPort = Number(ports['3993/tcp'][0].HostPort)
  const smtpPort = Number(ports['3465/tcp'][0].HostPort)
  const account = { email: 'support@postfold.test', name: 'Postfold support', imap: { host: 'localhost', port: imapPort, security: 'tls', user: 'support', password: 'test-only-mail-password' }, smtp: { host: 'localhost', port: smtpPort, security: 'tls', user: 'support', password: 'test-only-mail-password' }, sentPath: 'Sent', saveSent: true }
  await saveAccount(pool, accountId, account)
  const setupAccess = join(directory, 'setup-access.json')
  const bootstrap = execFileSync(process.execPath, ['api/dist/api/configure-mailbox.js'], {
    env: { ...process.env, POSTFOLD_ACCESS_FILE: setupAccess }, encoding: 'utf8',
    input: JSON.stringify({ account, access: { user: 'operator', password: 'test-only-access-password' } }),
  })
  assert.ok(bootstrap.includes('Encrypted mailbox account'))
  assert.ok(!bootstrap.includes('test-only-mail-password'))
  const accessBefore = (await import('node:fs')).readFileSync(setupAccess, 'utf8')
  execFileSync(process.execPath, ['api/dist/api/configure-mailbox.js'], { env: { ...process.env, POSTFOLD_ACCESS_FILE: setupAccess }, encoding: 'utf8', input: JSON.stringify({ account }) })
  assert.equal((await import('node:fs')).readFileSync(setupAccess, 'utf8'), accessBefore)
  const unusedAccess = join(directory, 'sso-access.json')
  execFileSync(process.execPath, ['api/dist/api/configure-mailbox.js'], { env: { ...process.env, POSTFOLD_AUTH: 'keycloak', POSTFOLD_ACCESS_FILE: unusedAccess }, encoding: 'utf8', input: JSON.stringify({ account }) })
  assert.equal(existsSync(unusedAccess), false, 'SSO mailbox bootstrap must not create or require shared Basic credentials')
  const encrypted = (await pool.query('SELECT secret FROM mail_accounts WHERE id=$1', [accountId])).rows[0].secret
  assert.ok(!JSON.stringify(encrypted).includes('test-only-mail-password'))
  const tls = { ca: (await import('node:fs')).readFileSync(join(directory, 'ca.pem')), rejectUnauthorized: true }
  const smtp = nodemailer.createTransport({ host: 'localhost', port: smtpPort, secure: true, auth: { user: 'customer', pass: 'test-only-customer-password' }, tls, connectionTimeout: 2000 })
  let ready = false
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await smtp.verify(); ready = true; break } catch { await delay(500) }
  }
  assert.ok(ready, 'TLS mail server must become ready')
  const startSmtp = nodemailer.createTransport({ host: 'localhost', port: Number(ports['3025/tcp'][0].HostPort), secure: false, requireTLS: true, auth: { user: 'customer', pass: 'test-only-customer-password' }, tls })
  await assert.rejects(startSmtp.verify(), 'GreenMail lacks SMTP STARTTLS; plaintext authentication must not be used as a fallback')
  const startImap = new ImapFlow({ host: 'localhost', port: Number(ports['3143/tcp'][0].HostPort), secure: false, doSTARTTLS: true, auth: { user: 'support', pass: 'test-only-mail-password' }, tls, logger: false })
  startImap.on('error', () => {})
  try { await assert.rejects(startImap.connect(), 'GreenMail lacks IMAP STARTTLS; plaintext authentication must not be used as a fallback') } finally { await startImap.logout().catch(() => startImap.close()) }
  console.info('Certificate-validated TLS and refusal to downgrade when STARTTLS is unavailable: passed')
  await assert.rejects(nodemailer.createTransport({ host: 'localhost', port: smtpPort, secure: true, auth: { user: 'customer', pass: 'test-only-customer-password' }, connectionTimeout: 2000 }).verify(), 'Untrusted TLS must be rejected')
  const originalId = `<${randomUUID()}@postfold.test>`
  await smtp.sendMail({ from: 'Customer <customer@postfold.test>', to: [account.email, 'Manager <manager@postfold.test>'], cc: 'Platform <platform@postfold.test>', envelope: { from: 'customer@postfold.test', to: [account.email] }, subject: 'VPN access request', text: 'Please help with my VPN.', messageId: originalId })
  store = new MailStore(accountId)
  await store.init()
  assert.deepEqual((await store.mailbox()).conversations, [])
  let mailbox = await store.sync()
  assert.equal(mailbox.connection.error, false)
  assert.equal(mailbox.conversations.length, 1)
  const received = mailbox.conversations[0]
  assert.equal(received.body.trim(), 'Please help with my VPN.')
  assert.equal(received.unread, true)
  assert.deepEqual(received.participants.map(person => person.email).sort(), ['customer@postfold.test', 'manager@postfold.test', 'platform@postfold.test'])
  assert.equal(mailbox.contacts.find(person => person.email === 'platform@postfold.test').name, 'Platform')
  assert.ok(!received.participants.some(person => person.email === account.email), 'Shared mailbox must not become an external contact')
  const state = () => mailbox.conversationStates.find((item) => item.id === received.id)
  const supportActor = { id: 'test-alice', name: 'Alice Support', email: 'alice@example.test' }
  await store.members(supportActor)
  await store.updateConversations({ targets: [{ id: received.id, revision: state().revision }], assigneeId: supportActor.id }, supportActor)
  mailbox = await store.sync()
  assert.equal(mailbox.conversations[0].assigneeId, supportActor.id)
  await store.updateConversations({ targets: [{ id: received.id, revision: state().revision }], unread: false })
  mailbox = await store.sync()
  assert.equal(mailbox.conversations[0].unread, false)
  let settings = { ...mailbox.projectSettings, projects: mailbox.projects }
  settings = await store.update({ ...settings, projects: [...settings.projects, { id: '1842', name: 'IT support', color: 'blue' }], order: [...settings.order, '1842'] })
  settings = await store.update({ ...settings, projects: [...settings.projects, { id: 'vpn', name: 'VPN', color: 'blue', parentId: '1842' }], order: [...settings.order, 'vpn'] })
  settings = await store.update({ ...settings, projects: settings.projects.map((item) => item.id === '1842' ? { ...item, name: 'Support requests' } : item), labels: [{ id: 'urgent', name: 'Urgent', color: 'rose' }] })
  await assert.rejects(store.update({ ...settings, projects: [...settings.projects, { id: 'alias', code: '1842', name: 'Support requests', color: 'blue' }], order: [...settings.order, 'alias'] }), /Folder paths must be unique/)
  const native = new ImapFlow({ host: 'localhost', port: imapPort, secure: true, auth: { user: 'support', pass: 'test-only-mail-password' }, tls, logger: false })
  native.on('error', () => {})
  try {
    await native.connect()
    const listed = await native.list()
    const delimiter = listed.find((folder) => folder.path === 'INBOX').delimiter
    const destinationPath = `1842 - Support requests${delimiter}VPN`
    assert.ok(listed.some((folder) => folder.path === destinationPath), JSON.stringify(listed.map((folder) => folder.path)))
    console.info('Native folders and subfolder rename: passed')
    mailbox = await store.sync()
    await store.updateConversations({ targets: [{ id: received.id, revision: state().revision }], addLabelIds: ['urgent'] })
    mailbox = await store.sync()
    if (native.capabilities.has('MOVE') && native.capabilities.has('UIDPLUS')) {
      await store.updateConversations({ targets: [{ id: received.id, revision: state().revision }], projectId: 'vpn' })
    } else {
      await assert.rejects(store.updateConversations({ targets: [{ id: received.id, revision: state().revision }], projectId: 'vpn' }))
      const lock = await native.getMailboxLock('INBOX')
      try { await native.messageMove('1:*', destinationPath) } finally { lock.release() }
      console.info('Server lacks MOVE; guarded app filing and external-client reconciliation: passed')
    }
    mailbox = await store.sync()
    const moved = mailbox.conversations.find((item) => item.messageId === originalId)
    assert.equal(moved.id, received.id)
    assert.equal(moved.projectId, 'vpn')
    assert.deepEqual(moved.labelIds, ['urgent'])
    assert.equal(moved.assigneeId, supportActor.id, 'Native moves and synchronization must preserve shared assignment')
    const lock = await native.getMailboxLock(destinationPath)
    try {
      const fetched = await native.fetchAll('1:*', { flags: true })
      assert.equal(fetched.length, 1)
      assert.ok(fetched[0].flags.has('\\Seen'))
    } finally { lock.release() }
  } finally { await native.logout().catch(() => native.close()) }
  const bulkIds = [`<${randomUUID()}@postfold.test>`, `<${randomUUID()}@postfold.test>`]
  for (const [index, id] of bulkIds.entries()) await smtp.sendMail({ from: 'Customer <customer@postfold.test>', to: account.email, subject: ['Wi-Fi enrollment', 'Printer access'][index], text: 'Please grant access.', messageId: id })
  store.limit = 1
  await store.sync()
  mailbox = await store.sync()
  const bulkMessages = mailbox.conversations.filter((item) => bulkIds.includes(item.messageId))
  assert.equal(bulkMessages.length, 2)
  await store.updateConversations({ targets: bulkMessages.map((message) => ({ id: message.id, revision: mailbox.conversationStates.find((item) => item.id === message.id).revision })), addLabelIds: ['urgent'] })
  const bulkClient = new ImapFlow({ host: 'localhost', port: imapPort, secure: true, auth: { user: 'support', pass: 'test-only-mail-password' }, tls, logger: false })
  bulkClient.on('error', () => {})
  try {
    await bulkClient.connect()
    const listed = await bulkClient.list()
    const path = listed.find((item) => item.name === 'VPN').path
    const lock = await bulkClient.getMailboxLock('INBOX')
    try { await bulkClient.messageMove('1:*', path) } finally { lock.release() }
  } finally { await bulkClient.logout().catch(() => bulkClient.close()) }
  await store.sync()
  mailbox = await store.sync()
  for (const original of bulkMessages) {
    const moved = mailbox.conversations.find((item) => item.messageId === original.messageId)
    assert.equal(moved.id, original.id)
    assert.equal(moved.projectId, 'vpn')
    assert.deepEqual(moved.labelIds, ['urgent'])
  }
  store.limit = 200
  console.info('Bounded multi-cycle import preserves annotations during large native moves: passed')
  peer = new MailStore(accountId)
  await peer.init()
  const reply = { id: received.id, revision: state().revision, text: 'VPN access has been restored.', html: '<p><strong>VPN access</strong> has been restored.</p><script>unsafe()</script>', attachments: [{ filename: 'vpn-checklist.txt', contentType: 'text/plain', content: Buffer.from('Update the client, then reconnect.').toString('base64') }], requestId: randomUUID() }
  const outcomes = await Promise.allSettled([store.reply(reply, supportActor), peer.reply({ ...reply, requestId: randomUUID() }, supportActor)])
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1)
  const accepted = outcomes[0].status === 'fulfilled' ? reply : null
  if (accepted) {
    assert.deepEqual(await store.reply(accepted), outcomes[0].value)
    await assert.rejects(store.reply({ ...accepted, html: '<p>A different reply</p>' }), /different reply/)
    await assert.rejects(store.reply({ ...accepted, attachments: [{ ...accepted.attachments[0], content: Buffer.from('changed').toString('base64') }] }), /different reply/)
  }
  const richSentClient = new ImapFlow({ host: 'localhost', port: imapPort, secure: true, auth: { user: 'support', pass: 'test-only-mail-password' }, tls, logger: false })
  try {
    await richSentClient.connect(); const lock = await richSentClient.getMailboxLock('Sent')
    try { const raw = await richSentClient.fetchOne('1', { source: true }); assert.ok(raw); const parsed = await (await import('mailparser')).simpleParser(raw.source); assert.ok(parsed.html.includes('<strong>VPN access</strong>')); assert.ok(!parsed.html.includes('<script>')); assert.equal(parsed.attachments.length, 1); assert.equal(parsed.attachments[0].filename, 'vpn-checklist.txt'); assert.equal(parsed.attachments[0].content.toString(), 'Update the client, then reconnect.'); assert.equal(parsed.to.value[0].address, 'customer@postfold.test') } finally { lock.release() }
  } finally { await richSentClient.logout().catch(() => richSentClient.close()) }
  console.info('Sanitized multipart HTML, exact attachment bytes and full-payload idempotency: passed')
  await assert.rejects(store.reply({ ...reply, requestId: randomUUID() }))
  assert.deepEqual((await store.mailbox()).conversations.find(item => item.outgoing).participants.map(person => person.email), ['customer@postfold.test'], 'A direct reply must not claim the original Cc received it')
  mailbox = await store.sync()
  assert.ok(mailbox.conversations.some((item) => item.outgoing && item.body.trim() === reply.text))
  assert.equal(mailbox.deliveries[0].status, 'sent')
  assert.equal(mailbox.deliveries[0].sentCopy, true)
  assert.equal(mailbox.conversations.filter((item) => item.outgoing).length, 1)
  const sentActivity = (await store.activity([received.id])).filter((entry) => entry.kind === 'reply')
  assert.equal(sentActivity.length, 1, 'Retries and duplicate replies must not create additional send activity')
  assert.equal(sentActivity[0].actor.id, supportActor.id)
  assert.equal(sentActivity[0].data.status, 'sent')
  assert.equal((await pool.query('SELECT source FROM mail_sends WHERE mailbox_id=$1 AND status=$2',[`imap:${accountId}`,'sent'])).rows[0].source,null, 'Confirmed MIME must be archived before clearing its send spool')
  const outgoingArchive = (await store.archives({query:'Re: VPN access request',missingOnly:false})).items.find(item=>item.messageId.startsWith('sent_'))
  assert.ok(outgoingArchive)
  const archivedReply = await (await import('mailparser')).simpleParser(await store.archiveSource(outgoingArchive.id))
  assert.ok(archivedReply.html.includes('<strong>VPN access</strong>'))
  assert.equal(archivedReply.attachments[0].content.toString(),'Update the client, then reconnect.')
  assert.equal(mailbox.conversations.find((item) => item.outgoing).assigneeId, supportActor.id)
  await smtp.sendMail({ from: 'customer@postfold.test', to: account.email, subject: 'Re: VPN access request', text: 'Thanks, I have another question.', messageId: `<${randomUUID()}@postfold.test>`, inReplyTo: originalId, references: [originalId] })
  mailbox = await store.sync()
  assert.equal(mailbox.conversations.find((item) => item.body.includes('another question')).assigneeId, supportActor.id, 'New messages in an existing thread must inherit assignment')
  const recipient = new ImapFlow({ host: 'localhost', port: imapPort, secure: true, auth: { user: 'customer', pass: 'test-only-customer-password' }, tls, logger: false })
  recipient.on('error', () => {})
  try {
    await recipient.connect()
    const lock = await recipient.getMailboxLock('INBOX')
    try { assert.equal((await recipient.fetchAll('1:*', { uid: true })).length, 1) } finally { lock.release() }
  } finally { await recipient.logout().catch(() => recipient.close()) }
  await smtp.sendMail({ from: 'customer@postfold.test', to: account.email, subject: 'MFA reset request', text: 'Please reset my MFA.', messageId: `<${randomUUID()}@postfold.test>` })
  mailbox = await store.sync()
  const uncertainTarget = mailbox.conversations.find((item) => item.subject === 'MFA reset request')
  const uncertainReply = { id: uncertainTarget.id, revision: mailbox.conversationStates.find((item) => item.id === uncertainTarget.id).revision, text: 'Your MFA has been reset.', requestId: randomUUID() }
  const originalSmtp = store.smtp.bind(store)
  store.smtp = () => {
    const transport = originalSmtp()
    return { verify: () => transport.verify(), sendMail: async (...args) => { await transport.sendMail(...args); throw new Error('Injected loss of SMTP acknowledgement after acceptance') } }
  }
  await assert.rejects(store.reply(uncertainReply, supportActor))
  store.smtp = originalSmtp
  await assert.rejects(peer.reply(uncertainReply))
  await assert.rejects(peer.reply({ ...uncertainReply, requestId: randomUUID() }))
  assert.equal((await peer.mailbox()).deliveries.find((item) => item.targetId === uncertainTarget.id).status, 'uncertain')
  const uncertainActivity = (await peer.activity([uncertainTarget.id])).filter((entry) => entry.kind === 'reply')
  assert.equal(uncertainActivity.length, 1)
  assert.equal(uncertainActivity[0].actor.id, supportActor.id)
  assert.equal(uncertainActivity[0].data.status, 'uncertain')
  const uncertainMime = (await pool.query('SELECT source FROM mail_sends WHERE mailbox_id=$1 AND request_id=$2',[`imap:${accountId}`,uncertainReply.requestId])).rows[0].source
  assert.ok(Buffer.isBuffer(uncertainMime) && uncertainMime.includes(Buffer.from('Your MFA has been reset.')), 'Unconfirmed SMTP attempts must retain their complete MIME')
  console.info('Lost SMTP acknowledgement persists uncertainty and blocks retries across instances: passed')
  const nativeTargetId = `<${randomUUID()}@postfold.test>`
  await smtp.sendMail({ from: 'customer@postfold.test', to: account.email, subject: 'Email client setup', text: 'Please configure my email client.', messageId: nativeTargetId })
  mailbox = await store.sync()
  const nativeTarget = mailbox.conversations.find((item) => item.messageId === nativeTargetId)
  const nativeReply = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({ from: account.email, to: 'customer@postfold.test', subject: 'Re: Email client setup', text: 'Already handled from a native client.', inReplyTo: nativeTargetId })
  const sentClient = new ImapFlow({ host: 'localhost', port: imapPort, secure: true, auth: { user: 'support', pass: 'test-only-mail-password' }, tls, logger: false })
  sentClient.on('error', () => {})
  try { await sentClient.connect(); await sentClient.append('Sent', nativeReply.message, ['\\Seen']) } finally { await sentClient.logout().catch(() => sentClient.close()) }
  await assert.rejects(store.reply({ id: nativeTarget.id, revision: mailbox.conversationStates.find((item) => item.id === nativeTarget.id).revision, text: 'Duplicate reply must be blocked.', requestId: randomUUID() }), /another mail client/)
  console.info('Native-client replies with only In-Reply-To prevent a duplicate app reply: passed')
  await smtp.sendMail({ from: 'customer@postfold.test', to: account.email, subject: 'Large diagnostic report', text: 'Please attach the diagnostic archive.', messageId: `<${randomUUID()}@postfold.test>` })
  mailbox = await store.sync()
  const largeTarget = mailbox.conversations.find(item => item.subject === 'Large diagnostic report')
  const largeReply = { id: largeTarget.id, revision: mailbox.conversationStates.find(item => item.id === largeTarget.id).revision, text: 'The diagnostic archive is attached.', requestId: randomUUID(), html: '<p>The diagnostic archive is attached.</p>', attachments: [{ filename: 'diagnostics.bin', contentType: 'application/octet-stream', content: Buffer.alloc(8 * 1024 * 1024, 42).toString('base64') }] }
  await store.reply(largeReply, supportActor)
  mailbox = await store.sync()
  const largeSent = mailbox.conversations.find(item => item.id === `sent_${largeReply.requestId}`)
  assert.equal(largeSent.imapReady, true, 'A sent MIME copy above 10 MiB must still synchronize within the 16 MiB import bound')
  console.info('Large attachment MIME overhead and native Sent synchronization: passed')
  const recoveryClient = new ImapFlow({ host: 'localhost', port: imapPort, secure: true, auth: { user: 'support', pass: 'test-only-mail-password' }, tls, logger: false })
  recoveryClient.on('error', () => {})
  const archiveMessageId = `<${randomUUID()}@postfold.test>`
  const diagnostic = Buffer.from([0, 1, 127, 128, 255, 42])
  const archiveDate = new Date('2026-01-02T09:10:11Z')
  let archivedCopy, expectedSource
  try {
    await recoveryClient.connect(); await recoveryClient.mailboxCreate('Recovery scratch')
    const generated = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({ from: 'Customer <customer@postfold.test>', to: account.email, subject: 'Archived VPN diagnostics', text: 'Original VPN diagnostics, preserved for recovery.', html: '<p><strong>Original VPN diagnostics</strong>, preserved for recovery.</p>', messageId: archiveMessageId, date: archiveDate, attachments: [{ filename: 'network-report.bin', content: diagnostic }] })
    await recoveryClient.append('Recovery scratch', generated.message, ['\\Seen', '\\Flagged'], archiveDate)
    let lock = await recoveryClient.getMailboxLock('Recovery scratch')
    try { expectedSource = (await recoveryClient.fetchAll('1:*', { source: true }))[0].source } finally { lock.release() }
    mailbox = await store.sync()
    const original = mailbox.conversations.find(item => item.messageId === archiveMessageId)
    await store.updateConversations({ targets: [{ id: original.id, revision: mailbox.conversationStates.find(item => item.id === original.id).revision }], status: 'closed', addLabelIds: ['urgent'], assigneeId: supportActor.id }, supportActor)
    await store.sync()
    let archivePage = await store.archives({ query: 'Archived VPN diagnostics', missingOnly: false })
    assert.equal(archivePage.items.length, 1); archivedCopy = archivePage.items[0]
    assert.equal(archivedCopy.missingSince, null)
    assert.deepEqual(await store.archiveSource(archivedCopy.id), expectedSource)
    await assert.rejects(store.restoreArchive({ id: archivedCopy.id, folderId: 'inbox' }, supportActor), /already present/)
    // An existing installation downloads complete MIME without changing message identities or duplicating archives.
    await pool.query('UPDATE mail_messages SET source_sha256=NULL WHERE mailbox_id=$1 AND id=$2', [`imap:${accountId}`,original.id])
    await store.sync()
    archivePage = await store.archives({ query: 'Archived VPN diagnostics', missingOnly: false })
    assert.equal(archivePage.items.length, 1); assert.equal(archivePage.items[0].id, archivedCopy.id)
    await recoveryClient.mailboxClose(); await recoveryClient.mailboxDelete('Recovery scratch')
    mailbox = await store.sync()
    assert.ok(!mailbox.conversations.some(item => item.id === original.id))
    archivePage = await store.archives({ query: 'Archived VPN diagnostics', missingOnly: true })
    assert.equal(archivePage.items.length, 1); assert.ok(archivePage.items[0].missingSince)
    assert.equal(archivePage.items[0].lastPath, 'Recovery scratch')
    assert.equal(archivePage.items[0].snapshot.status, 'closed')
    assert.deepEqual(archivePage.items[0].snapshot.labelIds, ['urgent'])
    assert.equal(archivePage.items[0].snapshot.assigneeId, supportActor.id)
    await store.onApplicationShutdown(); store = new MailStore(accountId); await store.init()
    assert.deepEqual(await store.archiveSource(archivedCopy.id), expectedSource, 'Deleted mail must survive a backend restart')
    await pool.query('UPDATE mail_archives SET source=$3 WHERE mailbox_id=$1 AND id=$2', [`imap:${accountId}`,archivedCopy.id,Buffer.from('damaged')])
    await assert.rejects(store.archiveSource(archivedCopy.id), /integrity/)
    await pool.query('UPDATE mail_archives SET source=$3 WHERE mailbox_id=$1 AND id=$2', [`imap:${accountId}`,archivedCopy.id,expectedSource])
    const restorations = await Promise.allSettled([store.restoreArchive({ id: archivedCopy.id, folderId: 'inbox' },supportActor),peer.restoreArchive({ id: archivedCopy.id, folderId: 'inbox' },supportActor)])
    assert.equal(restorations.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(restorations.filter(item => item.status === 'rejected').length, 1)
    mailbox = await store.sync()
    const restored = mailbox.conversations.find(item => item.id === original.id)
    assert.equal(restored.status, 'closed'); assert.deepEqual(restored.labelIds, ['urgent']); assert.equal(restored.assigneeId, supportActor.id)
    assert.equal(restored.projectId, 'inbox'); assert.equal(restored.unread, false)
    assert.ok(mailbox.conversationStates.find(item => item.id === original.id).revision > archivedCopy.snapshot.revision)
    const activity = await store.activity([original.id])
    assert.ok(activity.some(item => item.actor?.id === supportActor.id && item.data.restoredFromArchive === archivedCopy.id && item.data.status === 'sent'))
    lock = await recoveryClient.getMailboxLock('INBOX')
    try {
      const uids = await recoveryClient.search({ header: { 'Message-ID': archiveMessageId } }, { uid: true })
      assert.equal(uids.length, 1)
      const recovered = (await recoveryClient.fetchAll(uids,{ source: true,flags: true,internalDate: true },{uid:true}))[0]
      const { simpleParser } = await import('mailparser'); const parsed = await simpleParser(recovered.source)
      assert.deepEqual(parsed.attachments[0].content,diagnostic)
      assert.ok(parsed.html.includes('<strong>Original VPN diagnostics</strong>'))
      assert.equal(recovered.internalDate.toISOString(),archiveDate.toISOString())
      assert.ok(recovered.flags.has('\\Seen') && recovered.flags.has('\\Flagged'))
      await recoveryClient.messageDelete(uids,{uid:true})
    } finally { lock.release() }
    await store.sync()
    // A lost APPEND acknowledgement is durable, and another backend cannot blindly append a second copy.
    const actualImap = store.imap.bind(store)
    store.imap = () => { const client = actualImap(); client.append = async () => { throw new Error('Simulated missing APPEND acknowledgement') }; return client }
    await assert.rejects(store.restoreArchive({ id: archivedCopy.id,folderId:'inbox' },supportActor),/could not be confirmed/)
    store.imap = actualImap
    await assert.rejects(peer.restoreArchive({ id: archivedCopy.id,folderId:'inbox' },supportActor),/unconfirmed/)
    assert.equal((await store.archives({query:'Archived VPN diagnostics',missingOnly:true})).items[0].restoreStatus,'uncertain')
    assert.deepEqual(await store.archiveSource(archivedCopy.id),expectedSource)
    await assert.rejects(store.archives({query:'x'.repeat(201),missingOnly:false}),/Invalid/)
    await assert.rejects(store.archiveSource('../../mail_accounts'),/Invalid/)
    await assert.rejects(store.archiveSource(randomUUID()),/not found/)
    // Multiple native copies with identical MIME must keep distinct identities and paginate without omissions.
    await recoveryClient.mailboxCreate('IT service history')
    const paginationSource = await nodemailer.createTransport({streamTransport:true,buffer:true}).sendMail({from:'Customer <customer@postfold.test>',to:account.email,subject:'Device enrollment archive',text:'Identical native copies for pagination.',messageId:`<${randomUUID()}@postfold.test>`})
    for (let index=0;index<51;index++) await recoveryClient.append('IT service history',paginationSource.message,['\\Seen'])
    mailbox = await store.sync()
    assert.equal(mailbox.conversations.filter(item=>item.subject==='Device enrollment archive').length,51)
    const firstPage = await store.archives({query:'Device enrollment archive',missingOnly:false})
    assert.equal(firstPage.items.length,50); assert.ok(firstPage.nextCursor)
    const secondPage = await store.archives({query:'Device enrollment archive',missingOnly:false,cursor:firstPage.nextCursor})
    assert.equal(secondPage.items.length,1); assert.equal(secondPage.nextCursor,null)
    assert.equal(new Set([...firstPage.items,...secondPage.items].map(item=>item.id)).size,51)
    // Existing MIME anywhere in IMAP blocks restoring another historical copy of the same source.
    await assert.rejects(store.restoreArchive({id:firstPage.items[0].id,folderId:'inbox'},supportActor),/already present/)
    if (process.env.MAIL_TEST_BROWSER === 'true') {
      const uiSource = await nodemailer.createTransport({streamTransport:true,buffer:true}).sendMail({from:'Customer <customer@postfold.test>',to:account.email,subject:'VPN client diagnostics',text:'The VPN connection drops after sign-in. Attached are the network diagnostics.',html:'<p>The VPN connection drops after sign-in. Attached are the network diagnostics.</p>',messageId:`<${randomUUID()}@postfold.test>`,date:archiveDate,attachments:[{filename:'network-report.bin',content:diagnostic}]})
      await recoveryClient.append('INBOX',uiSource.message,['\\Seen'],archiveDate)
      await store.sync()
      const entry = (await store.archives({query:'VPN client diagnostics',missingOnly:false})).items[0]
      browserArchiveId = entry.id; browserArchiveSource = await store.archiveSource(entry.id)
      lock = await recoveryClient.getMailboxLock('INBOX')
      try { const uids=await recoveryClient.search({header:{'Subject':'VPN client diagnostics'}},{uid:true}); await recoveryClient.messageDelete(uids,{uid:true}) } finally { lock.release() }
      await store.sync()
    }
  } finally { await recoveryClient.logout().catch(() => recoveryClient.close()) }
  console.info('Complete MIME archive, legacy backfill, external folder deletion, restart, integrity, concurrent restoration, exact attachments/flags/date and uncertainty guards: passed')

  app = await createApp(false, '', true)
  await app.listen(0, '127.0.0.1')
  const origin = await app.getUrl()
  assert.equal((await fetch(origin + '/mailbox')).status, 401)
  assert.equal((await fetch(origin + '/mailbox/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reply) })).status, 401)
  assert.equal((await fetch(origin + '/demo/mailbox')).status, 404)
  assert.equal((await fetch(origin + `/mailbox/archives/${archivedCopy.id}/source`)).status,401)
  assert.equal((await fetch(origin + '/mailbox/archives/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:archivedCopy.id,folderId:'inbox'})})).status,401)
  const exported = await fetch(origin + `/mailbox/archives/${archivedCopy.id}/source`,{headers:{Authorization:'Basic '+Buffer.from('operator:test-only-access-password').toString('base64')}})
  assert.equal(exported.status,200); assert.equal(exported.headers.get('cache-control'),'private, no-store')
  assert.equal(exported.headers.get('x-content-type-options'),'nosniff'); assert.match(exported.headers.get('content-disposition'),/attachment/)
  assert.deepEqual(Buffer.from(await exported.arrayBuffer()),expectedSource)

  const authorized = await fetch(origin + '/mailbox', { headers: { Authorization: 'Basic ' + Buffer.from('operator:test-only-access-password').toString('base64') } })
  assert.equal(authorized.status, 200)
  assert.equal(authorized.headers.get('cache-control'), 'private, no-store')
  assert.ok(!JSON.stringify(await authorized.json()).includes('test-only-mail-password'))
  let largeApiResult
  for (let retry = 0; retry < 30; retry++) {
    const replayLarge = await fetch(origin + '/mailbox/reply', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from('operator:test-only-access-password').toString('base64'), 'Content-Type': 'application/json' }, body: JSON.stringify(largeReply) })
    largeApiResult = await replayLarge.json()
    if (replayLarge.status === 409 && largeApiResult.message === 'Mailbox operation in progress; refresh before retrying.') { await delay(200); continue }
    assert.equal(replayLarge.status, 201, 'Authenticated API must accept bounded base64 attachment payloads above the default 100 KB JSON limit')
    break
  }
  assert.equal(largeApiResult.status, 'sent')
  if (process.env.MAIL_TEST_WEB === 'true') {
    const { createServer } = await import('node:net')
    const allocation = createServer()
    await new Promise((resolve) => allocation.listen(0, '127.0.0.1', resolve))
    const port = allocation.address().port
    await new Promise((resolve) => allocation.close(resolve))
    web = spawn(process.execPath, ['.output/server/index.mjs'], { env: { ...process.env, MAILBOX_MODE: 'imap', API_ORIGIN: origin, NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port), NODE_ENV: 'production' }, stdio: ['ignore', 'ignore', 'inherit'] })
    const webOrigin = `http://127.0.0.1:${port}`
    let response
    for (let attempt = 0; attempt < 40; attempt++) { try { response = await fetch(webOrigin); break } catch { await delay(250) } }
    assert.equal(response.status, 401)
    const authorization = 'Basic ' + Buffer.from('operator:test-only-access-password').toString('base64')
    const authenticated = await fetch(webOrigin + '/?lang=en', { headers: { Authorization: authorization } })
    assert.equal(authenticated.status, 200)
    assert.equal(authenticated.headers.get('cache-control'), 'private, no-store')
    assert.ok((await authenticated.text()).includes('IMAP mailbox connected'))
    if (process.env.MAIL_TEST_BROWSER === 'true') {
      const session = 'postfold-live-mail'
      const browser = async (...args) => (await promisify(execFile)('agent-browser', ['--session', session, ...args], { encoding: 'utf8' })).stdout.trim()
      try {
        await smtp.sendMail({ from: 'Customer <customer@postfold.test>', to: account.email, subject: 'Laptop enrollment', text: 'Can you enroll my laptop?', messageId: `<${randomUUID()}@postfold.test>` })
        // Wait for the API's initial background sync, if it still owns the mailbox lock.
        let laptopReady = false
        for (let attempt = 0; attempt < 40; attempt++) {
          try { laptopReady = (await store.sync()).conversations.some((item) => item.subject === 'Laptop enrollment'); if (laptopReady) break } catch {}
          await delay(250)
        }
        assert.ok(laptopReady, 'The browser fixture must be synchronized before opening the inbox')
        await browser('set', 'viewport', '1440', '1040')
        await browser('set', 'credentials', 'operator', 'test-only-access-password')
        await browser('open', webOrigin + '/?lang=en')
        await browser('wait', '--text', 'Laptop enrollment')
        assert.ok((await browser('snapshot', '-i')).includes('Laptop enrollment'))
        await browser('eval', "document.querySelector('[role=group][aria-label=\"Mailbox synchronization\"] input').click()")
        await browser('find', 'role', 'button', 'click', '--name', 'Laptop enrollment')
        await browser('snapshot', '-i')
        await browser('find', 'role', 'button', 'click', '--name', 'Reply to this message', '--exact')
        await browser('wait', '#reply')
        await browser('find', 'role', 'textbox', 'fill', 'Your laptop enrollment is complete.', '--name', 'Your draft')
        await browser('wait', '--fn', "Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === 'Send' && !button.disabled)")
        await browser('screenshot', process.env.MAIL_TEST_SCREENSHOT ?? join(directory, 'live-mail.png'))
        await browser('find', 'role', 'button', 'click', '--name', 'Send', '--exact')
        await browser('wait', '--text', 'Reply accepted by the SMTP server.')
        await browser('wait', '--fn', `Array.from(document.querySelectorAll('[data-message-id]')).some(message => message.dataset.messageId.startsWith('sent_') && message.textContent.includes('Your laptop enrollment is complete.'))`)
        await browser('wait', '--fn', `(() => { const sent = Array.from(document.querySelectorAll('[data-message-id]')).find(message => message.dataset.messageId.startsWith('sent_')); const rect = sent.getBoundingClientRect(), pane = document.querySelector('.reading-pane').getBoundingClientRect(), header = document.querySelector('.reading-context').getBoundingClientRect(); return rect.top >= header.bottom && rect.bottom <= pane.bottom; })()`)
        const stored = await browser('eval', "JSON.parse(localStorage.getItem('postfold:mailbox:support@postfold.test:v1')).drafts")
        assert.ok(!stored.includes('Your laptop enrollment is complete.'))
        console.info('Browser: authenticated SSR, server functions, draft saved before real SMTP send, success cleanup: passed')
        await browser('click', '.main-nav button:last-child'); await browser('wait', '.settings-tabs')
        await browser('click', '.settings-tabs button:last-child'); await browser('wait', '.archive-item')
        await browser('fill', '[aria-label="Search mail archives"]', 'VPN client diagnostics')
        await browser('wait', '--fn', `document.querySelectorAll('.archive-item').length === 1 && document.querySelector('.archive-item').dataset.archiveId === '${browserArchiveId}'`)
        await browser('check', '.archive-filter input'); await browser('wait', '--fn', '!document.querySelector(".archive-items").getAttribute("aria-busy").includes("true")')
        const recoveredPath = join(directory,'recovered-mail.eml')
        await browser('download', '.archive-item footer button:first-child', recoveredPath)
        assert.deepEqual(readFileSync(recoveredPath),browserArchiveSource,'Browser .eml download must preserve every MIME byte')
        for (const [width,height] of [[1440,1040],[390,844],[320,568],[667,375]]) {
          await browser('set','viewport',String(width),String(height))
          assert.ok(JSON.parse(await browser('eval','document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1')))
          await browser('eval','document.querySelector(".archive-restore").scrollIntoView({block:"nearest"})')
          await browser('click','.archive-restore'); await browser('wait','.archive-dialog:modal')
          assert.ok(JSON.parse(await browser('eval','(() => {const bounds=document.querySelector(".archive-dialog").getBoundingClientRect();return bounds.left>=0 && bounds.right<=innerWidth && bounds.top>=0 && bounds.bottom<=innerHeight})()')))
          await browser('press','Escape'); await browser('wait','--fn','!document.querySelector(".archive-dialog")')
        }
        await browser('set','viewport','1440','1040')
        await browser('eval','document.querySelector(".settings-page").scrollTop=0')
        if (process.env.MAIL_ARCHIVE_SCREENSHOT) await browser('screenshot',process.env.MAIL_ARCHIVE_SCREENSHOT)
        await browser('eval','document.querySelector(".archive-restore").scrollIntoView({block:"nearest"})')
        await browser('click','.archive-restore'); await browser('wait','.archive-dialog:modal')
        await browser('select','.archive-dialog select','inbox')
        await browser('click','.archive-dialog .primary-button')
        await browser('wait','--text','Message restored to the IMAP folder. The archive is preserved.')
        await browser('wait','--fn','!document.querySelector(".archive-dialog")')
        await browser('uncheck','.archive-filter input')
        await browser('wait',`[data-archive-id="${browserArchiveId}"]`)
        await browser('wait','--fn',`document.querySelector('[data-archive-id="${browserArchiveId}"] .archive-restore').disabled`)
        assert.equal((await store.archives({query:'VPN client diagnostics',missingOnly:false})).items.length,1)
        assert.equal((await store.archives({query:'VPN client diagnostics',missingOnly:false})).items[0].missingSince,null)
        console.info('Browser archives: exact MIME download, guarded IMAP restoration, mobile layout and destination dialog: passed')

      } finally { await browser('close') }
    }
    console.info('Compiled frontend: anonymous access denied, authenticated real-mail SSR passed')
  }
  console.info('PASS: encrypted credentials, certificate validation, IMAP import/read flags/folders/native moves, SMTP reply/Sent copy, concurrency/idempotency, API access guards')
} catch (error) {
  console.error(error)
  if (started) console.error(command('docker', ['logs', '--tail', '25', container]))
  process.exitCode = 1
} finally {
  if (web && web.exitCode === null) { web.kill('SIGTERM'); await new Promise((resolve) => web.once('exit', resolve)) }
  if (app) await app.close()
  if (peer) await peer.onApplicationShutdown()
  if (store) await store.onApplicationShutdown()
  await pool.query('DELETE FROM demo_project_settings WHERE mailbox_id=$1', [`imap:${accountId}`]).catch(() => {})
  await pool.query('DELETE FROM mail_accounts WHERE id=$1', [accountId]).catch(() => {})
  await pool.end()
  if (started) command('docker', ['rm', '-f', container])
  rmSync(directory, { recursive: true, force: true })
}
