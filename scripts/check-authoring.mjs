import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { createApp } from '../api/dist/api/app.js'

// Every check owns its mailbox, frontend, browser and fictional attachments.
process.env.POSTFOLD_AUTH = 'basic'
process.env.MAILBOX_MODE = 'demo'
const mailboxId = `authoring-ui-${crypto.randomUUID()}`
const session = `postfold-authoring-${process.pid}`
const directory = mkdtempSync(join(tmpdir(), 'postfold-authoring-'))
const command = promisify(execFile)
const browser = async (...args) => (await command('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })).stdout.trim()
const evaluate = async script => JSON.parse(await browser('eval', script))
const click = async selector => {
  // Scroll only actual panels; hidden shell ancestors must never move the header.
  await evaluate(`(() => { const target=document.querySelector(${JSON.stringify(selector)}); for(let parent=target.parentElement;parent;parent=parent.parentElement) { if(!['auto','scroll'].includes(getComputedStyle(parent).overflowY)) continue; const rect=target.getBoundingClientRect(), bounds=parent.getBoundingClientRect(); if(rect.top<bounds.top||rect.bottom>bounds.bottom) parent.scrollTop+=rect.top-bounds.top-parent.clientHeight/2+rect.height/2; } return true })()`)
  await browser('click', selector)
}
let app, web
try {
  app = await createApp(true, mailboxId); await app.listen(0, '127.0.0.1')
  const apiOrigin = await app.getUrl()
  const allocation = createServer(); await new Promise(resolve => allocation.listen(0, '127.0.0.1', resolve)); const port = allocation.address().port; await new Promise(resolve => allocation.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  web = spawn(process.execPath, ['.output/server/index.mjs'], { env: { ...process.env, API_ORIGIN: apiOrigin, NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port), NODE_ENV: 'production' }, stdio: ['ignore', 'ignore', 'inherit'] })
  let ready = false
  for (let i = 0; i < 50; i++) { try { ready = (await fetch(origin + '/?lang=en')).ok; if (ready) break } catch {} await delay(200) }
  assert.ok(ready)
  await browser('open', origin + '/?lang=en'); await browser('set', 'viewport', '1440', '1040'); await browser('wait', '.thread-row'); await browser('uncheck', '.auto-refresh input')
  await click('.main-nav button:last-child'); await browser('wait', '.settings-card')
  for (const scope of ['personal', 'team']) {
    await click('.settings-tools .primary-button'); await browser('wait', '#settings-rich-editor')
    await browser('fill', '.settings-editor input', `VPN checklist · ${scope}`)
    await browser('select', '.settings-editor select', scope)
    await browser('fill', '#settings-rich-editor', 'Hello {{contact.name}}, please update the VPN client and reconnect.')
    await click('.settings-editor footer .primary-button'); await browser('wait', '--fn', '!document.querySelector(".settings-dialog")')
  }
  assert.equal(await evaluate('document.querySelectorAll(".settings-card").length'), 3)
  await click('.settings-card:first-child .icon-button'); await browser('wait', '#settings-rich-editor')
  const editedName = 'Ticket received · updated'
  await browser('fill', '.settings-editor input', editedName)
  const concurrentConfig = await (await fetch(apiOrigin + '/authoring')).json()
  const conflictWrite = await fetch(apiOrigin + '/authoring', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: concurrentConfig.revision, action: 'template', item: { id: 'concurrent', name: 'Concurrent response', scope: 'team', html: '<p>A concurrent team response.</p>' } }) })
  assert.equal(conflictWrite.status, 200)
  await click('.settings-editor footer .primary-button'); await browser('wait', '.settings-editor .settings-error')
  assert.equal(await evaluate('document.querySelector(".settings-editor input").value'), editedName)
  await click('.settings-editor .settings-error button'); await browser('wait', '--fn', '!document.querySelector(".settings-editor .settings-error")')
  assert.equal(await evaluate('document.querySelector(".settings-editor input").value'), editedName)
  await click('.settings-editor footer .primary-button'); await browser('wait', '--fn', '!document.querySelector(".settings-dialog")')
  console.info('Concurrent settings edit preserves content and allows explicit reload/retry inside the dialog: passed')
  const capture = async name => { if (process.env.AUTHORING_SCREENSHOTS) { mkdirSync(process.env.AUTHORING_SCREENSHOTS, { recursive: true }); await browser('screenshot', join(process.env.AUTHORING_SCREENSHOTS, name)) } }
  console.info('Personal and shared templates created: passed')
  await capture('email-templates.png')
  await click('.settings-tabs button:nth-child(2)'); await click('.settings-tools .primary-button'); await browser('wait', '.html-source')
  await browser('fill', '.settings-editor input', 'Engineering support')
  await browser('fill', '.html-source', '<table cellpadding="0" cellspacing="0"><tr><td style="border-left:3px solid #2563eb;padding:8px 12px;font-family:Arial;font-size:13px"><strong>Julie Dumoulin</strong><br><span style="color:#64748b">Engineering Support · Postfold</span><br><a href="mailto:julie@example.test">julie@example.test</a></td></tr></table>')
  await capture('signature-editor.png')
  await click('.settings-editor footer .primary-button'); await browser('wait', '--fn', '!document.querySelector(".settings-dialog")')
  let config = await (await fetch(apiOrigin + '/authoring')).json()
  const signature = config.signatures.find(s => s.name === 'Engineering support')
  assert.ok(signature.html.includes('<table')); assert.ok(signature.html.includes('border-left:3px solid #2563eb'))
  await click('.settings-tabs button:nth-child(3)'); await browser('wait', '.team-table')
  await browser('select', '[aria-label="Signature · Julie Dumoulin"]', signature.id); await browser('wait', '--text', 'Settings saved.')
  config = await (await fetch(apiOrigin + '/authoring')).json(); assert.equal(config.assignments['demo-julie'], signature.id)
  console.info('HTML signature saved and assigned to a teammate: passed')
  await capture('team-dashboard.png')
  await click('.main-nav button:first-child'); await click('.reply-bar button'); await browser('wait', '#reply')
  await browser('wait', '--fn', '!document.querySelector(".composer-signature select").disabled')
  assert.equal(await evaluate('document.querySelector(".composer-signature select").value'), signature.id)
  await browser('fill', '#reply', 'We have checked your account.')
  await browser('focus', '#reply'); await browser('press', process.platform === 'darwin' ? 'Meta+a' : 'Control+a'); await click('[aria-label="Bold"]')
  assert.ok(await evaluate('!!document.querySelector("#reply strong")'))
  await click('.template-control>button'); await browser('wait', '.template-menu'); await browser('fill', '.template-menu input', 'VPN checklist · personal'); await click('.template-menu button')
  assert.match(await evaluate('document.querySelector("#reply").textContent'), /We have checked your account/)
  assert.match(await evaluate('document.querySelector("#reply").textContent'), /Hello Paul Martin/)
  const attachmentPath = join(directory, 'vpn-checklist.txt'); writeFileSync(attachmentPath, 'Install the latest VPN client, then reconnect.\n')
  console.info('Rich reply and personalized template insertion: passed')
  await browser('upload', '.composer-files input[type=file]', attachmentPath); await browser('wait', '.attachment-list li')
  await browser('wait', '--fn', '!document.querySelector(".composer-files button").disabled')
  await click('.composer-actions button[type=submit]'); await browser('wait', '--text', 'Draft saved in this browser.')
  await evaluate('window.getSelection()?.removeAllRanges(); document.querySelector("#reply").blur(); document.querySelector(".reading-pane").scrollTop = document.querySelector(".reading-pane").scrollHeight')
  await capture('draft-composer.png')
  const draftTarget = await evaluate('document.querySelector(".thread-row.selected").dataset.conversationId')
  console.info('Attachment uploaded and draft saved: passed', draftTarget)
  await browser('reload'); await browser('wait', '.reply-bar'); if (draftTarget) await click(`[data-conversation-id="${draftTarget}"] .thread-open`); await click('.reply-bar button'); await browser('wait', '#reply'); await browser('wait', '.attachment-list li')
  assert.match(await evaluate('document.querySelector("#reply").innerHTML'), /<strong>/)
  assert.match(await evaluate('document.querySelector("#reply").textContent'), /Hello Paul Martin/)
  assert.equal(await evaluate('document.querySelector(".composer-signature select").value'), signature.id)
  assert.match(await evaluate('document.querySelector(".attachment-list").textContent'), /vpn-checklist.txt/)
  await click('.attachment-list button'); await browser('wait', '--fn', '!document.querySelector(".attachment-list")')
  console.info('Rich draft and attachment reload/removal: passed')
  const paste = `(() => { const transfer=new DataTransfer(); transfer.items.add(new File(['clipboard log'], 'pasted-log.txt', {type:'text/plain'})); document.querySelector('#reply').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:transfer})); return true })()`
  await evaluate(paste); await browser('wait', '.attachment-list li'); assert.match(await evaluate('document.querySelector(".attachment-list").textContent'), /pasted-log.txt/)
  await browser('set', 'viewport', '390', '844'); const mobileHeaderTop = await evaluate('document.querySelector(".topbar").getBoundingClientRect().top'); await evaluate('document.querySelector(".composer").scrollIntoView({block:"start"})'); assert.equal(await evaluate('document.querySelector(".topbar").getBoundingClientRect().top'), mobileHeaderTop); assert.equal(await evaluate('document.querySelector(".workspace").scrollTop'), 0); await evaluate('document.querySelector(".composer footer").scrollIntoView({block:"end"})'); await capture('mobile-composer.png')
  for (const [width,height] of [[1440,900],[768,1024],[390,844],[320,568],[667,375]]) {
    console.info(`Checking authoring viewport ${width}×${height}`)
    await browser('set', 'viewport', String(width), String(height)); assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1'))
    await click('.main-nav button:last-child'); await browser('wait', '.settings-page'); await browser('wait', '.settings-tabs')
    await click('.settings-tabs button:nth-child(3)'); await browser('wait', '.team-table')
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1'))
    await click('.settings-tabs button:first-child'); await click('.settings-tools .primary-button'); await browser('wait', '.settings-dialog')
    const bounds = await evaluate('document.querySelector(".settings-dialog").getBoundingClientRect().toJSON()'); assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.top >= 0 && bounds.bottom <= height)
    // Untouched editor: native modal Escape closes it without a discard prompt.
    await browser('press', 'Escape'); await browser('wait', '--fn', '!document.querySelector(".settings-dialog")')
    await click('.main-nav button:first-child')
    console.info(`Authoring pages and native editor dialog ${width}×${height}: passed`)
  }
  await browser('wait', '--load', 'networkidle')
  assert.equal(await browser('errors'), '')
  console.info('PASS: template CRUD/scopes/variables, HTML signature editing/assignment, team dashboard, formatting, attachment upload/paste/removal/persistence, saved rich drafts, responsive pages/dialogs')
} catch (error) {
  throw error
} finally {
  try { await browser('close') } catch {}
  if (web) { web.kill('SIGTERM'); if (web.exitCode === null) await new Promise(resolve => web.once('exit', resolve)) }
  await app?.close()
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://mailer_demo:mailer_demo@127.0.0.1:55432/mailer_support' })
  try { await pool.query('DELETE FROM demo_project_settings WHERE mailbox_id=$1', [mailboxId]) } finally { await pool.end() }
  rmSync(directory, { recursive: true, force: true })
}
