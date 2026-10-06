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
const sessions = [`postfold-sso-${identifier}`, `postfold-denied-${identifier}`]
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
    roles: { client: { postfold: [{ name: 'support' }] } },
    clients: [{ clientId: 'postfold', enabled: true, protocol: 'openid-connect', publicClient: false, secret: 'test-only-keycloak-secret', standardFlowEnabled: true,
      directAccessGrantsEnabled: false, redirectUris: [publicOrigin + '/auth/callback'], webOrigins: [publicOrigin], defaultClientScopes: ['basic', 'profile', 'email', 'roles'],
      attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': publicOrigin + '/auth/logged-out' },
      protocolMappers: [{ name: 'postfold-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: { 'included.client.audience': 'postfold', 'access.token.claim': 'true', 'id.token.claim': 'false' } }],
    }],
    users: ['alice', 'bob'].map((username) => ({ username, enabled: true, email: username + '@postfold.test', emailVerified: true,
      firstName: username === 'alice' ? 'Alice' : 'Bob', lastName: 'Support', credentials: [{ type: 'password', value: 'test-only-user-password', temporary: false }],
      clientRoles: username === 'alice' ? { postfold: ['support'] } : {},
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
  await browser(sessions[0], 'find', 'role', 'button', 'click', '--name', 'Refresh', '--exact')
  await browser(sessions[0], 'wait', '--text', 'Alice Support')
  assert.ok((await browser(sessions[0], 'snapshot', '-i')).includes('Sign out'))
  if (process.env.KEYCLOAK_TEST_SCREENSHOT) await browser(sessions[0], 'screenshot', process.env.KEYCLOAK_TEST_SCREENSHOT)
  await signIn(sessions[1], 'bob')
  await browser(sessions[1], 'wait', '--text', 'does not have access')
  assert.equal((await pool.query('SELECT 1 FROM postfold_sessions WHERE id=$1', [id])).rowCount, 1)
  assert.equal((await fetch(origin + '/auth/logout', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, redirect: 'manual' })).status, 403)
  await browser(sessions[0], 'find', 'role', 'button', 'click', '--name', 'Sign out', '--exact')
  await browser(sessions[0], 'snapshot', '-i')
  if (!(await browser(sessions[0], 'get', 'url')).includes('/auth/logged-out')) await browser(sessions[0], 'find', 'role', 'button', 'click', '--name', 'Logout', '--exact')
  await browser(sessions[0], 'wait', '--url', '**/auth/logged-out')
  assert.equal((await fetch(origin + '/auth/me', { headers })).status, 401)
  assert.equal((await fetch((await peer.getUrl()) + '/auth/me', { headers })).status, 401)
  console.info('PASS: real Keycloak code flow/PKCE, state replay protection, encrypted server sessions, HttpOnly cookies, role guards, SSR/server functions, concurrent refresh across instances, CSRF rejection and SSO logout')
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
