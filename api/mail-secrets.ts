import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { Pool } from 'pg'
import { isMailAccount, type MailAccount } from '../shared/mail-account.js'

export type SealedSecret = { version: 1; keyId: string; nonce: string; tag: string; ciphertext: string }

export function readPrivateFile(path: string | undefined) {
  if (!path || (statSync(path).mode & 0o077) !== 0) throw new Error('A secret file is missing or accessible to other users; require mode 0600.')
  return readFileSync(path, 'utf8').trim()
}

export function mailboxKey() {
  const hex = readPrivateFile(process.env.MAILBOX_KEY_FILE)
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('MAILBOX_KEY_FILE must contain a 32-byte hexadecimal key.')
  return Buffer.from(hex, 'hex')
}

export function sealSecret(value: string, key: Buffer, accountId: string): SealedSecret {
  const nonce = randomBytes(12)
  const keyId = process.env.MAILBOX_KEY_ID ?? 'v1'
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(`postfold:mail-account:1:${keyId}:${accountId}`))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return { version: 1, keyId, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
}

export function openSecret(value: SealedSecret, key: Buffer, accountId: string) {
  if (value.version !== 1 || value.keyId !== (process.env.MAILBOX_KEY_ID ?? 'v1')) throw new Error('Unsupported credential key version.')
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.nonce, 'base64'))
  cipher.setAAD(Buffer.from(`postfold:mail-account:1:${value.keyId}:${accountId}`))
  cipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  return Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64')), cipher.final()]).toString('utf8')
}

export async function initAccounts(pool: Pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS mail_accounts (id text PRIMARY KEY, secret jsonb NOT NULL)')
}

export async function saveAccount(pool: Pool, id: string, account: unknown) {
  if (!/^[a-z0-9._-]{1,64}$/i.test(id) || !isMailAccount(account)) throw new Error('Invalid mailbox configuration; credentials were not saved.')
  const secret = sealSecret(JSON.stringify(account), mailboxKey(), id)
  await initAccounts(pool)
  await pool.query('INSERT INTO mail_accounts (id, secret) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET secret = EXCLUDED.secret', [id, secret])
}

export async function loadAccount(pool: Pool, id: string): Promise<MailAccount> {
  await initAccounts(pool)
  const { rows } = await pool.query('SELECT secret FROM mail_accounts WHERE id = $1', [id])
  if (!rows.length) throw new Error('No encrypted mail account configured; run pnpm mailbox:configure first.')
  const account: unknown = JSON.parse(openSecret(rows[0].secret, mailboxKey(), id))
  if (!isMailAccount(account)) throw new Error('Invalid encrypted mailbox configuration.')
  return account
}
