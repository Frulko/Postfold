import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { ImapFlow } from 'imapflow'
import { MailStore } from '../api/dist/api/mail-store.js'
import { saveAccount } from '../api/dist/api/mail-secrets.js'
import { createApp } from '../api/dist/api/app.js'

// Large-mailbox check against an isolated GreenMail: thousands of folders and messages, batched cycles,
// a near-free steady state and user actions that do not wait for a whole import.
const FOLDERS = Number(process.env.SCALE_FOLDERS) || 1200
const MESSAGES = Number(process.env.SCALE_MESSAGES) || 20_000
const directory = mkdtempSync(join(tmpdir(), 'postfold-scale-'))
const container = `postfold-scale-${randomUUID()}`
const accountId = `scale-${randomUUID()}`
const database = process.env.DATABASE_URL ?? 'postgresql://mailer_demo:mailer_demo@127.0.0.1:55432/mailer_support'
const pool = new Pool({ connectionString: database })
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const seconds = (start) => Math.round((Date.now() - start) / 100) / 10
const megabytes = () => Math.round(process.memoryUsage().rss / 1048576)
let started = false
let store
let app
let web
try {
  writeFileSync(join(directory, 'openssl.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n')
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', join(directory, 'openssl.cnf'), '-keyout', join(directory, 'server.key'), '-out', join(directory, 'ca.pem')])
  command('openssl', ['pkcs12', '-export', '-name', 'greenmail', '-inkey', join(directory, 'server.key'), '-in', join(directory, 'ca.pem'), '-out', join(directory, 'server.p12'), '-passout', 'pass:test-only-keystore'])
  chmodSync(join(directory, 'server.p12'), 0o644)
  writeFileSync(join(directory, 'mailbox.key'), randomBytes(32).toString('hex'), { mode: 0o600 })
  Object.assign(process.env, { DATABASE_URL: database, MAILBOX_ID: accountId, MAILBOX_KEY_FILE: join(directory, 'mailbox.key'), MAILBOX_CA_FILE: join(directory, 'ca.pem'), POSTFOLD_AUTH: 'basic' })
  command('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::3993', '-p', '127.0.0.1::3465', '-v', `${join(directory, 'server.p12')}:/certs/server.p12:ro`, '-e', 'GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=support:test-only-mail-password@postfold.test -Dgreenmail.tls.keystore.file=/certs/server.p12 -Dgreenmail.tls.keystore.password=test-only-keystore -Dgreenmail.tls.key.password=test-only-keystore', '-e', 'JAVA_OPTS=-Xmx2g', 'greenmail/standalone:2.1.14'])
  started = true
  const ports = JSON.parse(command('docker', ['inspect', container]))[0].NetworkSettings.Ports
  const endpoint = (port) => ({ host: 'localhost', port: Number(ports[`${port}/tcp`][0].HostPort), security: 'tls', user: 'support', password: 'test-only-mail-password' })
  const account = { email: 'support@postfold.test', name: 'Support', imap: endpoint(3993), smtp: endpoint(3465), sentPath: 'Sent', saveSent: true }
  await saveAccount(pool, accountId, account)
  let imap
  for (let attempt = 0; ; attempt++) {
    imap = new ImapFlow({ ...account.imap, secure: true, auth: { user: 'support', pass: 'test-only-mail-password' }, tls: { ca: readFileSync(join(directory, 'ca.pem')) }, logger: false })
    imap.on('error', () => {})
    try { await imap.connect(); break } catch (error) { if (attempt > 60) throw error; await delay(500) }
  }

  // Nested client folders like the production mailbox; INBOX keeps a quarter of the mail.
  const seeding = Date.now()
  const paths = ['INBOX']
  for (let index = 1; paths.length < FOLDERS; index++) {
    const client = `${String(index).padStart(4, '0')} - Client ${index}`
    await imap.mailboxCreate(client); paths.push(client)
    for (const child of ['Devis', 'Factures']) if (paths.length < FOLDERS) { await imap.mailboxCreate(`${client}/${child}`); paths.push(`${client}/${child}`) }
  }
  for (let index = 0; index < MESSAGES; index++) {
    const path = index % 4 === 0 ? 'INBOX' : paths[1 + (index * 7919) % (paths.length - 1)]
    const date = new Date(Date.UTC(2020, 0, 1) + index * 3_600_000)
    const body = `Bonjour,\r\n\r\nMessage ${index} 🎉 pour le dossier ${path}.\r\n${'Lorem ipsum dolor sit amet. '.repeat(20)}\r\n`
    await imap.append(path, `From: Client ${index % 500} <client${index % 500}@example.test>\r\nTo: support@postfold.test\r\nSubject: Demande ${index}\r\nMessage-ID: <scale-${index}@example.test>\r\nDate: ${date.toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`, index % 3 ? ['\\Seen'] : [], date)
  }
  console.info(`Seeded ${MESSAGES} messages in ${paths.length} folders in ${seconds(seeding)} s`)

  store = new MailStore(accountId)
  await store.init()
  store.limit = 2000
  const cycles = []
  const importing = Date.now()
  for (let cycle = 1; ; cycle++) {
    const start = Date.now()
    // Like the background loop: later cycles continue the import.
    await store.runCycle(cycle === 1 ? 'manual' : 'resume')
    const progress = store.syncProgress()
    cycles.push(seconds(start))
    console.info(`Cycle ${cycle}: ${seconds(start)} s, ${progress.lastCycle.imported} imported, ${progress.stored}/${progress.total} stored, RSS ${megabytes()} MB`)
    if (progress.lastCycle.complete) break
    assert.ok(cycle < 100, 'Import must finish')
  }
  console.info(`Full import: ${seconds(importing)} s`)
  const { rows: [{ count }] } = await pool.query('SELECT count(*)::integer AS count FROM mail_messages WHERE mailbox_id=$1', [`imap:${accountId}`])
  assert.equal(count, MESSAGES)

  // Steady state: nothing changed, so no folder is rescanned and nothing is rewritten.
  const lastLog = async (prefix) => (await store.readLogs(0)).entries.findLast((entry) => entry.message.startsWith(prefix))
  const steady = Date.now()
  await store.sync()
  console.info(`Steady cycle: ${seconds(steady)} s`)
  assert.equal((await lastLog('Inventory: {0} messages')).values[3], 0, 'An unchanged mailbox must not be rescanned')
  assert.equal((await lastLog('Saving')).values[0], 0, 'An unchanged mailbox must not be rewritten')

  // One new message: only its folder is rescanned and the message appears.
  await imap.logout().catch(() => {})
  imap = new ImapFlow({ ...account.imap, secure: true, auth: { user: 'support', pass: 'test-only-mail-password' }, tls: { ca: readFileSync(join(directory, 'ca.pem')) }, logger: false })
  imap.on('error', () => {})
  await imap.connect()
  await imap.append('0002 - Client 2', 'From: late@example.test\r\nTo: support@postfold.test\r\nSubject: Arrivée tardive\r\nMessage-ID: <late@example.test>\r\n\r\nNouveau.\r\n', [])
  const incremental = Date.now()
  const mailbox = await store.sync()
  console.info(`Incremental cycle: ${seconds(incremental)} s`)
  assert.ok(mailbox.conversations.some((item) => item.subject === 'Arrivée tardive'))
  assert.equal((await lastLog('Inventory: {0} messages')).values[3], 1, 'Only the changed folder is rescanned')

  // The list is read in windows: filtered, searched and paged in PostgreSQL.
  const listing = Date.now()
  const window = await store.mailbox({ query: 'demande 1999' })
  console.info(`Search window: ${seconds(listing)} s, ${window.page.total} matches`)
  assert.ok(window.conversations.some((item) => item.subject === 'Demande 1999'))
  const first = await store.mailbox({})
  assert.equal(first.conversations.length, 200)
  assert.equal(first.counts.messages, MESSAGES + 1)
  const second = await store.mailbox({ cursor: first.page.nextCursor })
  assert.ok(second.conversations.every((item) => !first.conversations.some((other) => other.id === item.id)), 'Pages must not overlap')
  assert.ok(second.conversations[0].sentAt <= first.conversations.at(-1).sentAt, 'Pages continue in date order')
  const folder = await store.mailbox({ projectId: '0003' })
  assert.ok(folder.conversations.length > 0 && folder.conversations.every((item) => ['0003', ...first.projects.filter((project) => project.parentId === '0003').map((project) => project.id)].includes(item.projectId)), 'A folder window includes its subfolders only')

  // A user action during a long cycle waits for the next checkpoint, not for the whole cycle.
  store.limit = 5000
  await imap.logout().catch(() => {})
  imap = new ImapFlow({ ...account.imap, secure: true, auth: { user: 'support', pass: 'test-only-mail-password' }, tls: { ca: readFileSync(join(directory, 'ca.pem')) }, logger: false })
  imap.on('error', () => {})
  await imap.connect()
  for (let index = 0; index < 3000; index++) await imap.append('INBOX', `From: burst@example.test\r\nTo: support@postfold.test\r\nSubject: Rafale ${index}\r\nMessage-ID: <burst-${index}@example.test>\r\n\r\n${'Texte. '.repeat(200)}\r\n`, [])
  const target = (await store.readConversationStates()).find((state) => state.unread)
  const running = store.sync()
  while (store.syncProgress().state !== 'importing') await delay(50)
  await delay(1000)
  const action = Date.now()
  await store.updateConversations({ targets: [{ id: target.id, revision: target.revision }], unread: false })
  console.info(`User action during an import: ${seconds(action)} s`)
  assert.ok(seconds(action) < 15, 'User actions must pause the import instead of waiting for it')
  await running
  // Optional browser pass over the compiled frontend (pnpm build): windows, infinite scroll, folder, search and contacts.
  if (process.env.MAIL_TEST_BROWSER === 'true') {
    const salt = randomBytes(16).toString('hex')
    writeFileSync(join(directory, 'access.json'), JSON.stringify({ user: 'operator', salt, hash: scryptSync('test-only-access-password', salt, 64).toString('hex') }), { mode: 0o600 })
    process.env.POSTFOLD_ACCESS_FILE = join(directory, 'access.json')
    app = await createApp(false, '', true)
    await app.listen(0, '127.0.0.1')
    const allocation = createServer()
    await new Promise((resolve) => allocation.listen(0, '127.0.0.1', resolve))
    const port = allocation.address().port
    await new Promise((resolve) => allocation.close(resolve))
    web = spawn(process.execPath, ['.output/server/index.mjs'], { env: { ...process.env, MAILBOX_MODE: 'imap', API_ORIGIN: await app.getUrl(), NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port), NODE_ENV: 'production' }, stdio: ['ignore', 'ignore', 'inherit'] })
    const webOrigin = `http://127.0.0.1:${port}`
    for (let attempt = 0; attempt < 40; attempt++) { try { await fetch(webOrigin); break } catch { await delay(250) } }
    const session = `postfold-scale-${process.pid}`
    const browser = async (...args) => (await promisify(execFile)('agent-browser', ['--session', session, ...args], { encoding: 'utf8' })).stdout.trim()
    const rows = async () => JSON.parse(await browser('eval', 'JSON.stringify([...document.querySelectorAll(".thread-row")].map((row) => [row.dataset.folderId, row.textContent]))'))
    try {
      await browser('set', 'viewport', '1440', '1000')
      await browser('set', 'credentials', 'operator', 'test-only-access-password')
      await browser('open', webOrigin + '/?lang=en')
      await browser('wait', '.thread-row')
      const total = await store.mailbox({})
      assert.ok((await browser('eval', 'document.querySelector(".list-header [aria-live]").textContent')).includes(String(total.counts.messages)), 'The list header shows the whole mailbox count')
      for (let attempt = 0; attempt < 40 && (await rows()).length <= 250; attempt++) {
        await browser('eval', 'document.querySelector(".list-rows").scrollTop = 1e9')
        await delay(300)
      }
      assert.ok((await rows()).length > 250, 'Scrolling past the first window loads the next one')
      const folderIds = ['0003', ...total.projects.filter((project) => project.parentId === '0003').map((project) => project.id)]
      await browser('eval', `[...document.querySelectorAll(".project-button")].find((button) => button.title.startsWith("0003 "))?.click()`)
      await browser('wait', '--fn', `(() => { const rows = [...document.querySelectorAll(".thread-row")]; return rows.length > 0 && rows.every((row) => ${JSON.stringify(folderIds)}.includes(row.dataset.folderId)) })()`)
      await browser('eval', `document.querySelector(".main-nav button").click()`)
      await browser('fill', '.search-field input', 'Demande 1999')
      await browser('wait', '--fn', `(() => { const rows = [...document.querySelectorAll(".thread-row")]; return rows.length > 0 && rows.length < 20 && rows.some((row) => row.textContent.includes("Demande 1999")) })()`)
      await browser('eval', `document.querySelector(".main-nav button:nth-child(2)").click()`)
      await browser('fill', '.list-header .search-field input', 'client42@')
      await browser('wait', '--fn', `[...document.querySelectorAll(".contact-row")].some((row) => row.textContent.includes("Client 42"))`)
      await browser('click', '.contact-row')
      await browser('wait', '--fn', `[...document.querySelectorAll(".history-item")].length > 0`)
      assert.ok(JSON.parse(await browser('eval', 'document.documentElement.scrollWidth <= innerWidth')))
      const badge = await browser('eval', `[...document.querySelectorAll(".folder-row")].find((row) => row.querySelector(".project-button")?.title.startsWith("0003 "))?.querySelector("b")?.textContent`)
      assert.equal(Number(JSON.parse(badge)), (await store.mailbox({ projectId: '0003' })).page.total, 'Folder badges count the whole folder and its subfolders')
      // New mail arriving while the page is open: the list refreshes by itself once a batch is saved (all share one timestamp).
      const late = new ImapFlow({ ...account.imap, secure: true, auth: { user: 'support', pass: 'test-only-mail-password' }, tls: { ca: readFileSync(join(directory, 'ca.pem')) }, logger: false })
      late.on('error', () => {})
      await late.connect()
      for (let index = 0; index < 1500; index++) await late.append('INBOX', `From: wave@example.test\r\nTo: support@postfold.test\r\nSubject: Vague ${index}\r\nMessage-ID: <wave-${index}@example.test>\r\n\r\nTexte.\r\n`, [])
      await late.logout().catch(() => {})
      await browser('eval', 'document.querySelector(".main-nav button").click()')
      await browser('eval', `(() => { const input = document.querySelector(".search-field input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })) })()`)
      await browser('click', '.refresh-button')
      // A fast import can finish between two progress polls, so the bar is captured only when it shows up.
      if (await browser('wait', '.sync-progress progress').then(() => true, () => false) && process.env.MAIL_SCALE_SCREENSHOT) await browser('screenshot', process.env.MAIL_SCALE_SCREENSHOT)
      // The API's first cycle after startup rescans every folder before importing the wave; GreenMail is slow at that.
      for (let attempt = 0; ; attempt++) {
        try { await browser('wait', '--fn', `[...document.querySelectorAll(".thread-row")].some((row) => row.textContent.includes("Vague "))`); break }
        catch (error) { if (attempt >= 12) throw error }
      }
      console.info('Browser: whole-mailbox counts, infinite scroll across windows, folder, search and contact windows: passed')
    } finally { await browser('close').catch(() => {}) }
  }
  console.info(`PASS: ${MESSAGES} messages in ${paths.length} folders, ${cycles.length} import cycles, steady and incremental cycles, responsive user actions`)
  await imap.logout().catch(() => {})
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (web && web.exitCode === null) { web.kill('SIGTERM'); await new Promise((resolve) => web.once('exit', resolve)) }
  if (app) await app.close()
  if (store) await store.onApplicationShutdown()
  await pool.query('DELETE FROM demo_project_settings WHERE mailbox_id=$1', [`imap:${accountId}`]).catch(() => {})
  await pool.query('DELETE FROM mail_accounts WHERE id=$1', [accountId]).catch(() => {})
  await pool.end()
  if (started) command('docker', ['rm', '-f', container])
  rmSync(directory, { recursive: true, force: true })
}
