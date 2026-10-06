import { scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

export function checkAccess(header: string | undefined) {
  const path = process.env.POSTFOLD_ACCESS_FILE
  if (!path || (statSync(path).mode & 0o077) !== 0) throw new Error('POSTFOLD_ACCESS_FILE is required with mode 0600 for live mail.')
  const access = JSON.parse(readFileSync(path, 'utf8')) as { user: string; salt: string; hash: string }
  if (typeof access.user !== 'string' || !/^[0-9a-f]{32}$/i.test(access.salt) || !/^[0-9a-f]{128}$/i.test(access.hash)) throw new Error('Invalid access configuration.')
  if (typeof header !== 'string' || !header.startsWith('Basic ') || header.length > 4096) return false
  const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8')
  const colon = credentials.indexOf(':')
  if (colon < 0) return false
  const hash = scryptSync(credentials.slice(colon + 1), access.salt, 64)
  return timingSafeEqual(hash, Buffer.from(access.hash, 'hex')) && credentials.slice(0, colon) === access.user
}
