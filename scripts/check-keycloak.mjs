import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { createApp } from '../api/dist/api/app.js'
import { mailboxKey, openSecret, sealSecret } from '../api/dist/api/mail-secrets.js'

const allocatePort = async () => {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
const directory = mkdtempSync(join(tmpdir(), 'postfold-sso-'))
const identifier = randomUUID()
const realm = `postfold-${identifier}`
const container = `postfold-sso-${identifier}`
const database = process.env.DATABASE_URL ?? 'postgresql://mailer_demo:mailer_demo@127.0.0.1:55432/mailer_support'
const pool = new Pool({ connectionString: database })
const sessionIds = []
const sessions = [`postfold-sso-${identifier}`, `postfold-denied-${identifier}`, `postfold-teammate-${identifier}`]
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const browser = async (session, ...args) => (await promisify(execFile)('agent-browser', ['--session', session, ...args], { encoding: 'utf8' })).stdout.trim()
const digest = (value) => createHash('sha256').update(value).digest('hex')
let started = false, app, peer, web
try {
  const keycloakPort = await allocatePort(), webPort = await allocatePort()
  const publicOrigin = `http://127.0.0.1:${webPort}`
  const issuer = `http://127.0.0.1:${keycloakPort}/realms/${realm}`
  writeFileSync(join(directory, 'mailbox.key'), randomBytes(32).toString('hex'), { mode: 0o600 })
  writeFileSync(join(directory, 'client.secret'), 'test-only-keycloak-secret', { mode: 0o600 })
  writeFileSync(join(directory, 'realm.json'), JSON.stringify({
    realm, enabled: true, sslRequired: 'none', accessTokenLifespan: 60, revokeRefreshToken: true, refreshTokenMaxReuse: 0,
    registrationAllowed: false, loginWithEmailAllowed: true,
    roles: { client: { postfold: [{ name: 'support' }, { name: 'support-admin' }] } },
    clients: [{ clientId: 'postfold', enabled: true, protocol: 'openid-connect', publicClient: false, secret: 'test-only-keycloak-secret', standardFlowEnabled: true,
      directAccessGrantsEnabled: false, redirectUris: [publicOrigin + '/auth/callback'], webOrigins: [publicOrigin], defaultClientScopes: ['basic', 'profile', 'email', 'roles'],
      attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': publicOrigin + '/auth/logged-out' },
      protocolMappers: [{ name: 'postfold-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: { 'included.client.audience': 'postfold', 'access.token.claim': 'true', 'id.token.claim': 'false' } }],
    }],
    users: ['alice', 'bob', 'charlie'].map((username) => ({ username, enabled: true, email: username + '@postfold.test', emailVerified: true,
      firstName: username[0].toUpperCase() + username.slice(1), lastName: 'Support', credentials: [{ type: 'password', value: 'test-only-user-password', temporary: false }],
      clientRoles: username !== 'bob' ? { postfold: username === 'alice' ? ['support', 'support-admin'] : ['support'] } : {},
    })),
  }))
  Object.assign(process.env, { DATABASE_URL: database, POSTFOLD_AUTH: 'keycloak', POSTFOLD_ORIGIN: publicOrigin, KEYCLOAK_ISSUER: issuer,
    KEYCLOAK_CLIENT_ID: 'postfold', KEYCLOAK_CLIENT_SECRET_FILE: join(directory, 'client.secret'), KEYCLOAK_REQUIRED_ROLE: 'support', KEYCLOAK_ALLOW_LOCAL_HTTP: 'true', MAILBOX_KEY_FILE: join(directory, 'mailbox.key') })
  command('docker', ['run', '-d', '--name', container, '-p', `127.0.0.1:${keycloakPort}:8080`, '-v', `${join(directory, 'realm.json')}:/opt/keycloak/data/import/realm.json:ro`, 'quay.io/keycloak/keycloak:26.5.2', 'start-dev', '--import-realm', `--hostname=http://127.0.0.1:${keycloakPort}`])
  started = true
  let ready = false
  for (let attempt = 0; attempt < 480; attempt++) {
    try { ready = (await fetch(issuer + '/.well-known/openid-configuration', { signal: AbortSignal.timeout(2000) })).ok; if (ready) break } catch {}
    if (attempt > 0 && attempt % 60 === 0) console.info('Waiting for the isolated Keycloak realm to finish its first startup...')
    await delay(500)
  }
  assert.ok(ready, 'Keycloak must import the realm and become ready')
  app = await createApp(true, `sso-test-${identifier}`)
  await app.listen(0, '127.0.0.1')
  const origin = await app.getUrl()
  assert.equal((await fetch(origin + '/demo/mailbox')).status, 401)
  assert.equal((await fetch(origin + '/demo/mailbox', { headers: { Authorization: 'Basic ' + Buffer.from('operator:unused-password').toString('base64') } })).status, 401)
  assert.equal((await fetch(origin + '/auth/me', { headers: { Cookie: 'postfold-session=' + randomBytes(32).toString('base64url') } })).status, 401)
  const login = await fetch(origin + '/auth/login', { redirect: 'manual' })
  const loginUrl = new URL(login.headers.get('location'))
  assert.equal(loginUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(loginUrl.searchParams.get('nonce'))
  const flowCookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(origin + '/auth/callback?code=unused&state=wrong', { headers: { Cookie: flowCookie }, redirect: 'manual' })).status, 400)
  assert.equal((await fetch(origin + '/auth/callback?code=unused&state=wrong', { headers: { Cookie: flowCookie }, redirect: 'manual' })).status, 400)
  assert.equal((await fetch(origin + '/auth/callback?code=unused&state=wrong', { redirect: 'manual' })).status, 400)
  web = spawn(process.execPath, ['.output/server/index.mjs'], { env: { ...process.env, MAILBOX_MODE: 'demo', API_ORIGIN: origin, NITRO_HOST: '127.0.0.1', NITRO_PORT: String(webPort), NODE_ENV: 'production' }, stdio: ['ignore', 'ignore', 'inherit'] })
  let anonymous
  for (let attempt = 0; attempt < 40; attempt++) { try { anonymous = await fetch(publicOrigin, { redirect: 'manual' }); break } catch { await delay(250) } }
  assert.equal(anonymous.status, 302)
  assert.equal(anonymous.headers.get('location'), '/auth/login?lang=fr')
  const signIn = async (session, user) => {
    await browser(session, 'set', 'viewport', '1440', '1040')
    await browser(session, 'open', publicOrigin + '/?lang=en')
    await browser(session, 'wait', 'input[name=username]')
    await browser(session, 'snapshot', '-i')
    await browser(session, 'find', 'label', 'Username or email', 'fill', user)
    await browser(session, 'find', 'label', 'Password', 'fill', 'test-only-user-password')
    await browser(session, 'find', 'role', 'button', 'click', '--name', 'Sign In', '--exact')
  }
  await signIn(sessions[0], 'alice')
  await browser(sessions[0], 'wait', '--text', 'Alice Support')
  await browser(sessions[0], 'snapshot', '-i')
  const statePath = join(directory, 'browser.json')
  await browser(sessions[0], 'state', 'save', statePath)
  const cookie = JSON.parse(readFileSync(statePath, 'utf8')).cookies.find((item) => item.name === 'postfold-session')
  assert.ok(cookie.httpOnly)
  assert.equal(cookie.sameSite, 'Lax')
  const id = digest(cookie.value)
  sessionIds.push(id)
  const headers = { Cookie: 'postfold-session=' + cookie.value }
  for (const extra of [{ Origin: 'https://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, {}]) {
    assert.equal((await fetch(publicOrigin + '/_serverFn/csrf-check', { method: 'POST', headers: { ...headers, ...extra } })).status, 403, 'Frontend server functions must reject cross-site or unverified requests before dispatch')
  }
  const viewer = await (await fetch(origin + '/auth/me', { headers })).json()
  assert.equal(viewer.name, 'Alice Support')
  assert.equal(viewer.provider, 'keycloak')
  assert.ok(!JSON.stringify(viewer).includes('access_token'))
  assert.ok(!(await browser(sessions[0], 'eval', 'document.cookie')).includes('postfold-session'))
  const readSession = async () => (await pool.query('SELECT secret FROM postfold_sessions WHERE id=$1', [id])).rows[0].secret
  let sealed = await readSession()
  assert.ok(!JSON.stringify(sealed).includes('eyJ'))
  let data = JSON.parse(openSecret(sealed, mailboxKey(), 'oidc:' + id))
  const oldRefresh = data.refresh
  data.accessExpiresAt = Date.now() - 1
  await pool.query('UPDATE postfold_sessions SET secret=$2 WHERE id=$1', [id, sealSecret(JSON.stringify(data), mailboxKey(), 'oidc:' + id)])
  peer = await createApp(true, `sso-test-${identifier}`)
  await peer.listen(0, '127.0.0.1')
  const concurrent = await Promise.all([fetch(origin + '/auth/me', { headers }), fetch((await peer.getUrl()) + '/auth/me', { headers })])
  assert.ok(concurrent.every((response) => response.status === 200))
  data = JSON.parse(openSecret(await readSession(), mailboxKey(), 'oidc:' + id))
  assert.notEqual(data.refresh, oldRefresh)
  const forgedCookie = randomBytes(32).toString('base64url'), forgedId = digest(forgedCookie)
  sessionIds.push(forgedId)
  const parts = data.access.split('.')
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1)
  const forged = { ...data, access: parts.join('.') }
  await pool.query("INSERT INTO postfold_sessions (id,secret,expires_at) VALUES ($1,$2,now()+interval '8 hours')", [forgedId, sealSecret(JSON.stringify(forged), mailboxKey(), 'oidc:' + forgedId)])
  assert.equal((await fetch(origin + '/auth/me', { headers: { Cookie: 'postfold-session=' + forgedCookie } })).status, 401)
  assert.equal((await pool.query('SELECT 1 FROM postfold_sessions WHERE id=$1', [forgedId])).rowCount, 0)
  const mailbox = await (await fetch(origin + '/demo/mailbox', { headers })).json()
  assert.equal(mailbox.viewer.id, viewer.id)
  const patch = { targets: [{ id: mailbox.conversationStates[0].id, revision: mailbox.conversationStates[0].revision }], status: 'waiting' }
  const change = (originHeader) => fetch(origin + '/demo/conversations/state', { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', ...(originHeader ? { Origin: originHeader } : {}) }, body: JSON.stringify(patch) })
  assert.equal((await change('https://attacker.invalid')).status, 403)
  assert.equal((await change()).status, 403)
  assert.equal((await change(publicOrigin)).status, 200)
  await signIn(sessions[2], 'charlie')
  await browser(sessions[2], 'wait', '--text', 'Charlie Support')
  await browser(sessions[2], 'state', 'save', statePath)
  const teammateCookie = JSON.parse(readFileSync(statePath, 'utf8')).cookies.find((item) => item.name === 'postfold-session')
  const teammateHeaders = { Cookie: 'postfold-session=' + teammateCookie.value }
  sessionIds.push(digest(teammateCookie.value))
  const authoring = credentials => fetch(origin + '/authoring', { headers: credentials })
  const editAuthoring = (body, credentials = headers) => fetch(origin + '/authoring', { method: 'PUT', headers: { ...credentials, Origin: publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let authoringConfig = await (await authoring(headers)).json()
  assert.equal(authoringConfig.canAdmin, true, 'The administrator role must come from a verified Keycloak token')
  assert.equal((await (await authoring({ Cookie: 'postfold-session=' + teammateCookie.value })).json()).canAdmin, false)
  const colleagueHeaders = { Cookie: 'postfold-session=' + teammateCookie.value }
  const unauthorizedSignature = await editAuthoring({ revision: authoringConfig.revision, action: 'signature', item: { id: 'unauthorized', name: 'Unsafe', html: '<p>Unauthorized</p>' } }, colleagueHeaders)
  assert.equal(unauthorizedSignature.status, 403)
  const signatureResponse = await editAuthoring({ revision: authoringConfig.revision, action: 'signature', item: { id: 'sso-signature', name: 'Team support', html: '<p><strong>Verified IT support</strong></p>' } })
  assert.equal(signatureResponse.status, 200); authoringConfig = await signatureResponse.json()
  const teammateIdentity = (await (await authoring(colleagueHeaders)).json()).currentMemberId
  const memberChange = { action: 'member', id: teammateIdentity, role: 'member', active: false, signatureId: 'sso-signature' }
  const blocked = await editAuthoring({ ...memberChange, revision: authoringConfig.revision })
  assert.equal(blocked.status, 200); authoringConfig = await blocked.json()
  assert.equal((await fetch(origin + '/demo/mailbox', { headers: colleagueHeaders })).status, 403)
  assert.equal((await authoring(colleagueHeaders)).status, 403)
  const restored = await editAuthoring({ ...memberChange, active: true, revision: authoringConfig.revision })
  assert.equal(restored.status, 200)
  assert.equal((await authoring(colleagueHeaders)).status, 200)
  console.info('Verified Keycloak administrator role, protected signatures, member access revocation and restoration: passed')
  let shared = await (await fetch(origin + '/demo/mailbox', { headers })).json()
  assert.equal(shared.currentMemberId, viewer.id)
  assert.equal(shared.members.length, 2, 'Only authorized users who visited the mailbox appear in its directory')
  const colleague = shared.members.find((member) => member.name === 'Charlie Support')
  const selectedId = shared.conversations[0].id
  const assign = (body, credentials = headers) => fetch(origin + '/demo/conversations/state', { method: 'PATCH', headers: { ...credentials, Origin: publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const target = () => ({ id: selectedId, revision: shared.conversationStates.find((state) => state.id === selectedId).revision })
  assert.equal((await assign({ targets: [target()], assigneeId: colleague.id, actor: { id: colleague.id, name: colleague.name } })).status, 400)
  assert.equal((await assign({ targets: [target()], assigneeId: 'unknown' })).status, 400)
  assert.equal((await assign({ targets: [target()], assigneeId: colleague.id })).status, 200)
  shared = await (await fetch(origin + '/demo/mailbox', { headers })).json()
  const race = await Promise.all([assign({ targets: [target()], assigneeId: viewer.id }), assign({ targets: [target()], assigneeId: null }, teammateHeaders)])
  assert.deepEqual(race.map((response) => response.status).sort(), [200,409])
  const activity = await (await fetch(origin + '/demo/conversations/activity', { method: 'POST', headers: { ...headers, Origin: publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify([selectedId]) })).json()
  const assigned = activity.find((entry) => entry.data.after?.assigneeId === colleague.id)
  assert.equal(assigned.actor.id, viewer.id, 'Assignment author comes from the verified session, independently of the assignee')
  // Either request can win the race; the UI check needs a real Charlie → Alice transition.
  shared = await (await fetch(origin + '/demo/mailbox', { headers })).json()
  assert.equal((await assign({ targets: [target()], assigneeId: colleague.id })).status, 200)
  await browser(sessions[0], 'find', 'role', 'button', 'click', '--name', 'Refresh', '--exact')
  await browser(sessions[0], 'wait', '--fn', 'document.querySelector(\'summary[aria-label="Assignment"]\').textContent.includes("Charlie Support")')
  assert.ok((await browser(sessions[0], 'snapshot', '-i')).includes('Sign out'))
  await browser(sessions[0], 'click', 'summary[aria-label="Assignment"]')
  await browser(sessions[0], 'snapshot', '-i')
  await browser(sessions[0], 'find', 'role', 'button', 'click', '--name', 'Assign to me', '--exact')
  await browser(sessions[0], 'wait', '--fn', 'document.querySelector(\'summary[aria-label="Assignment"]\').textContent.includes("Alice Support")')
  await browser(sessions[0], 'find', 'text', 'Activity history', 'click', '--exact')
  await browser(sessions[0], 'wait', '--text', 'Assigned to Alice Support')
  if (process.env.ASSIGNMENT_TEST_SCREENSHOT) { await browser(sessions[0], 'set', 'viewport', '1440', '1200'); await browser(sessions[0], 'screenshot', process.env.ASSIGNMENT_TEST_SCREENSHOT) }
  await browser(sessions[0], 'check', `[data-conversation-id="${selectedId}"] input[type=checkbox]`)
  await browser(sessions[0], 'check', '[data-conversation-id="quote"] input[type=checkbox]')
  await browser(sessions[0], 'find', 'role', 'button', 'click', '--name', 'Actions', '--exact')
  await browser(sessions[0], 'wait', '--text', 'Mixed assignment')
  await browser(sessions[0], 'click', '.bulk-actions summary[aria-label="Assignment"]')
  await browser(sessions[0], 'snapshot', '-i')
  await browser(sessions[0], 'find', 'role', 'searchbox', 'fill', 'charlie', '--name', 'Search teammates', '--exact')
  await browser(sessions[0], 'click', '.bulk-actions .assignment-popup button[title="charlie@postfold.test"]')
  await browser(sessions[0], 'wait', '--fn', 'document.querySelector(\'.bulk-actions summary[aria-label="Assignment"]\').textContent.includes("Charlie Support")')
  shared = await (await fetch(origin + '/demo/mailbox', { headers })).json()
  assert.ok(shared.conversations.filter((item) => [selectedId,'quote'].includes(item.id)).every((item) => item.assigneeId === colleague.id))
  await browser(sessions[0], 'click', '.bulk-actions summary[aria-label="Assignment"]')
  await browser(sessions[0], 'find', 'role', 'button', 'click', '--name', 'Remove assignment', '--exact')
  await browser(sessions[0], 'wait', '--fn', 'document.querySelector(\'.bulk-actions summary[aria-label="Assignment"]\').textContent.includes("Unassigned")')
  shared = await (await fetch(origin + '/demo/mailbox', { headers })).json()
  assert.ok(shared.conversations.filter((item) => [selectedId,'quote'].includes(item.id)).every((item) => item.assigneeId === null))
  await browser(sessions[0], 'find', 'role', 'button', 'click', '--name', 'Clear selection', '--exact')
  await browser(sessions[0], 'set', 'viewport', '390', '900')
  await browser(sessions[0], 'click', 'summary[aria-label="Assignment"]')
  const mobile = JSON.parse(await browser(sessions[0], 'eval', 'JSON.stringify((()=>{const box=document.querySelector(".assignment-popup").getBoundingClientRect();return {left:box.left,right:box.right,width:innerWidth,documentWidth:document.documentElement.scrollWidth}})())'))
  const bounds = typeof mobile === 'string' ? JSON.parse(mobile) : mobile
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.documentWidth <= bounds.width, 'Mobile assignment popup must stay inside the viewport')
  await browser(sessions[0], 'press', 'Escape')
  await browser(sessions[0], 'set', 'viewport', '1440', '1040')
  if (process.env.KEYCLOAK_TEST_SCREENSHOT) await browser(sessions[0], 'screenshot', process.env.KEYCLOAK_TEST_SCREENSHOT)
  await signIn(sessions[1], 'bob')
  await browser(sessions[1], 'wait', '--text', 'does not have access')
  assert.equal((await pool.query('SELECT 1 FROM postfold_sessions WHERE id=$1', [id])).rowCount, 1)
  assert.equal((await fetch(origin + '/auth/logout', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, redirect: 'manual' })).status, 403)
  await browser(sessions[0], 'find', 'role', 'button', 'click', '--name', 'Sign out', '--exact')
  await browser(sessions[0], 'wait', '--fn', 'location.pathname === "/auth/logged-out" || [...document.querySelectorAll("button, input[type=submit]")].some(element => (element.textContent || element.value || "").trim() === "Logout")')
  if (!(await browser(sessions[0], 'get', 'url')).includes('/auth/logged-out')) await browser(sessions[0], 'find', 'role', 'button', 'click', '--name', 'Logout', '--exact')
  await browser(sessions[0], 'wait', '--url', '**/auth/logged-out')
  assert.equal((await fetch(origin + '/auth/me', { headers })).status, 401)
  assert.equal((await fetch((await peer.getUrl()) + '/auth/me', { headers })).status, 401)
  console.info('PASS: real Keycloak code flow/PKCE, state protection, encrypted sessions, role guards, concurrent refresh, CSRF, trusted assignment/audit authors, competing assignments, assignment UI, activity and SSO logout')
} catch (error) {
  console.error(error)
  if (app) console.error('Browser failure page:', (await browser(sessions[0], 'get', 'text', 'body').catch(() => '')).slice(0,1500))
  if (started) console.error(command('docker', ['logs', '--tail', '15', container]))
  process.exitCode = 1
} finally {
  for (const session of sessions) {
    const statePath = join(directory, 'cleanup-browser.json')
    try {
      await browser(session, 'state', 'save', statePath)
      for (const cookie of JSON.parse(readFileSync(statePath, 'utf8')).cookies) if (cookie.name === 'postfold-session') sessionIds.push(digest(cookie.value))
    } catch {}
    await browser(session, 'close').catch(() => {})
  }
  if (web && web.exitCode === null) { web.kill('SIGTERM'); await new Promise((resolve) => web.once('exit', resolve)) }
  if (peer) await peer.close()
  if (app) await app.close()
  await pool.query('DELETE FROM demo_project_settings WHERE mailbox_id=$1', [`sso-test-${identifier}`]).catch(() => {})
  await pool.query('DELETE FROM postfold_sessions WHERE id=ANY($1::text[])', [sessionIds]).catch(() => {})
  await pool.end()
  if (started) command('docker', ['rm', '-f', container])
  rmSync(directory, { recursive: true, force: true })
}
