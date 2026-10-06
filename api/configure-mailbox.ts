import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes, scryptSync } from 'node:crypto'
import { Pool } from 'pg'
import { saveAccount } from './mail-secrets.js'
import { checkAccess } from '../shared/access.js'
import { authMode } from '../shared/auth.js'

// Read a protected bootstrap JSON via stdin; never print credentials.
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
try {
  if (!process.env.DATABASE_URL || (authMode() === 'basic' && !process.env.POSTFOLD_ACCESS_FILE)) throw new Error('Set DATABASE_URL, MAILBOX_KEY_FILE and the selected access configuration.')
  const input = JSON.parse(readFileSync(0, 'utf8'))
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
} catch {
  console.error('Mailbox setup failed. Check configuration, database and secret file permissions. No secrets were logged.')
  process.exitCode = 1
} finally { await pool.end() }
