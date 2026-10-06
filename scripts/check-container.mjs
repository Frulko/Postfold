import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'

// An isolated database and deployment: never touch the development mailbox or volume.
const directory = mkdtempSync(join(tmpdir(), 'postfold-container-'))
const project = `postfold-check-${randomUUID()}`
copyFileSync('deploy/compose.yaml', join(directory, 'compose.yaml'))
mkdirSync(join(directory, 'secrets'))
const socket = createServer()
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise(resolve => socket.close(resolve))
const env = {
  ...process.env, POSTFOLD_IMAGE: process.env.POSTFOLD_TEST_IMAGE ?? 'postfold:check',
  POSTGRES_PASSWORD: randomUUID().replaceAll('-', ''), POSTFOLD_WEB_PORT: String(port),
  POSTFOLD_ORIGIN: `http://127.0.0.1:${port}`, POSTFOLD_AUTH: 'basic',
  MAILBOX_MODE: 'demo', DEMO_MODE: 'true',
}
const compose = (...args) => execFileSync('docker', ['compose', '--project-name', project, '--file', join(directory, 'compose.yaml'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
try {
  compose('up', '-d', '--wait', '--wait-timeout', '120')
  assert.equal(compose('exec', '-T', 'api', 'id', '-u'), '1000', 'API must run without root privileges')
  const html = await fetch(`http://127.0.0.1:${port}/?lang=en`)
  assert.equal(html.status, 200)
  assert.match(await html.text(), /Postfold/)
  const read = () => JSON.parse(compose('exec', '-T', 'api', 'node', '-e', "fetch('http://127.0.0.1:4000/demo/mailbox').then(r => r.json()).then(v => console.log(JSON.stringify(v)))"))
  const mailbox = read()
  const settings = { ...mailbox.projectSettings, projects: [...mailbox.projects, { id: 'container-check', name: 'Container persistence', color: 'blue' }], order: [...mailbox.projectSettings.order, 'container-check'] }
  compose('exec', '-T', 'api', 'node', '-e', `fetch('http://127.0.0.1:4000/demo/projects', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: ${JSON.stringify(JSON.stringify(settings))}}).then(r => {if (!r.ok) throw Error('Folder update failed')})`)
  compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120', 'api', 'web')
  assert.ok(read().projects.some(folder => folder.id === 'container-check'), 'Replacing application containers must preserve shared folders')
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200)
  console.info('Non-root production API/frontend and database persistence across container replacement: passed')
} catch (error) {
  console.error(compose('logs', '--tail', '60'))
  throw error
} finally {
  try { compose('down', '--volumes', '--remove-orphans') } finally { rmSync(directory, { recursive: true, force: true }) }
}
