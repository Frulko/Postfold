import { createMiddleware, createStart } from '@tanstack/react-start'
import { getRequestHeader, setResponseHeader } from '@tanstack/react-start/server'

const access = createMiddleware().server(async ({ next }) => {
  if (process.env.MAILBOX_MODE !== 'imap') return next()
  const { checkAccess } = await import('../shared/access')
  if (!checkAccess(getRequestHeader('authorization'))) return new Response('Authentication required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Postfold", charset="UTF-8"', 'Cache-Control': 'no-store' } })
  setResponseHeader('Cache-Control', 'private, no-store')
  return next()
})

export const startInstance = createStart(() => ({ requestMiddleware: [access] }))
