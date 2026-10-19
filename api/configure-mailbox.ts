import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes, scryptSync } from 'node:crypto'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { Pool } from 'pg'
import { saveAccount } from './mail-secrets.js'
import { checkAccess } from '../shared/access.js'
import { authMode } from '../shared/auth.js'

// Interactive bootstrap when run from a terminal; passwords are not echoed.
async function promptInput(withAccess: boolean) {
  let muted = false
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done() } })
  const rl = createInterface({ input: process.stdin, output, terminal: true })
  const lines = rl[Symbol.asyncIterator]() // Buffers pasted lines that arrive before their question.
  const ask = async (question: string, fallback = '', hidden = false) => {
    process.stdout.write(`${question}${fallback && !hidden ? ` [${fallback}]` : ''}: `)
    muted = hidden
    const { value: answer = '', done } = await lines.next()
    if (done) throw new Error('Input closed.')
    if (hidden) { muted = false; process.stdout.write('\n') }
    return (hidden ? answer : answer.trim()) || fallback
  }
  const endpoint = async (label: string, tlsPort: string, starttlsPort: string, user: string, password = '') => {
    const security = await ask(`${label} security (tls/starttls)`, 'tls')
    return {
      host: await ask(`${label} host`),
      port: Number(await ask(`${label} port`, security === 'starttls' ? starttlsPort : tlsPort)),
      security, user: await ask(`${label} user`, user),
      password: await ask(`${label} password${password ? ' (empty = same as IMAP)' : ''}`, password, true),
    }
  }
  try {
    const email = await ask('Mailbox email')
    const name = await ask('Display name', 'Support')
    const imap = await endpoint('IMAP', '993', '143', email)
    const smtp = await endpoint('SMTP', '465', '587', imap.user, imap.password)
    const sentPath = await ask('Sent folder path', 'Sent')
    const saveSent = (await ask('Append sent copies to that folder? (y/n)', 'y')).toLowerCase().startsWith('y')
    const access = withAccess ? { user: await ask('Postfold access user', 'operator'), password: await ask('Postfold access password (16+ characters)', '', true) } : undefined
    return { account: { email, name, imap, smtp, sentPath, saveSent }, access }
  } finally { rl.close() }
}

// Read a protected bootstrap JSON via stdin (or prompt in a terminal); never print credentials.
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
try {
  if (!process.env.DATABASE_URL || (authMode() === 'basic' && !process.env.POSTFOLD_ACCESS_FILE)) throw new Error('Set DATABASE_URL, MAILBOX_KEY_FILE and the selected access configuration.')
  const input = process.stdin.isTTY
    ? await promptInput(authMode() === 'basic' && !existsSync(process.env.POSTFOLD_ACCESS_FILE!))
    : JSON.parse(readFileSync(0, 'utf8'))
  let access: { user: string; salt: string; hash: string } | undefined
  if (authMode() === 'basic' && existsSync(process.env.POSTFOLD_ACCESS_FILE!)) checkAccess(undefined)
  else if (authMode() === 'basic') {
    if (!input.access || typeof input.access.user !== 'string' || !/^[a-z0-9._-]{1,64}$/i.test(input.access.user) || typeof input.access.password !== 'string' || input.access.password.length < 16 || Buffer.byteLength(input.access.password) > 1024) throw new Error('Provide access.user and an access.password of at least 16 characters.')
    const salt = randomBytes(16).toString('hex')
    access = { user: input.access.user, salt, hash: scryptSync(input.access.password, salt, 64).toString('hex') }
  }
  await saveAccount(pool, process.env.MAILBOX_ID ?? 'support', input.account)
  if (access) writeFileSync(process.env.POSTFOLD_ACCESS_FILE!, JSON.stringify(access) + '\n', { mode: 0o600, flag: 'wx' })
  console.info('Encrypted mailbox account saved. Remove the plaintext bootstrap file, then start with MAILBOX_MODE=imap.')
} catch (error) {
  // SyntaxError messages from JSON.parse can quote the bootstrap input, so only other reasons are shown.
  const reason = error instanceof Error && !(error instanceof SyntaxError) ? ` ${error.message}` : ''
  console.error(`Mailbox setup failed.${reason} Check configuration, database and secret file permissions. No secrets were logged.`)
  process.exitCode = 1
} finally { await pool.end() }
