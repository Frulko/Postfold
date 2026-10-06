import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { sealSecret, openSecret } from './mail-secrets.js'
import { isMailAccount, isReplyRequest } from '../shared/mail-account.js'

test('mail credentials use authenticated encryption bound to the account and key version', () => {
  const key = randomBytes(32)
  const secret = JSON.stringify({ password: 'test-only-password', refreshToken: 'test-only-token' })
  const sealed = sealSecret(secret, key, 'support')
  assert.equal(openSecret(sealed, key, 'support'), secret)
  assert.ok(!JSON.stringify(sealed).includes('test-only'))
  assert.notEqual(sealSecret(secret, key, 'support').nonce, sealed.nonce)
  assert.throws(() => openSecret(sealed, randomBytes(32), 'support'))
  assert.throws(() => openSecret(sealed, key, 'other-mailbox'))
  assert.throws(() => openSecret({ ...sealed, ciphertext: Buffer.from('tampered').toString('base64') }, key, 'support'))
  assert.throws(() => openSecret({ ...sealed, keyId: 'unknown' }, key, 'support'))
})

test('mail configuration rejects plaintext transport and replies reject header injection', () => {
  const endpoint = { host: 'localhost', port: 993, security: 'tls', user: 'support', password: 'test-only-password' }
  const account = { email: 'support@postfold.test', name: 'Support', imap: endpoint, smtp: endpoint, sentPath: 'Sent', saveSent: true }
  assert.equal(isMailAccount(account), true)
  assert.equal(isMailAccount({ ...account, smtp: { ...endpoint, security: 'plain' } }), false)
  assert.equal(isMailAccount({ ...account, email: 'support@postfold.test\r\nBcc: attacker@postfold.test' }), false)
  const reply = { id: 'message', revision: 0, text: 'Hello', requestId: crypto.randomUUID() }
  assert.equal(isReplyRequest(reply), true)
  assert.equal(isReplyRequest({ ...reply, to: 'attacker@postfold.test' }), false)
  assert.equal(isReplyRequest({ ...reply, text: ' ' }), false)
})
