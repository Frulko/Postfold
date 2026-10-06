import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'
import { getRequestHeader, setResponseHeader } from '@tanstack/react-start/server'
import { authMode } from '../shared/auth'

const access = createMiddleware().server(async ({ next, request, handlerType }) => {
  if (authMode() === 'keycloak') {
    const { keycloakAccess } = await import('./server/keycloak')
    const response = await keycloakAccess(request, handlerType)
    return response ?? next()
  }
  if (process.env.MAILBOX_MODE !== 'imap') return next()
  const { checkAccess } = await import('../shared/access')
  if (!checkAccess(getRequestHeader('authorization'))) return new Response('Authentication required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Postfold", charset="UTF-8"', 'Cache-Control': 'no-store' } })
  setResponseHeader('Cache-Control', 'private, no-store')
  return next()
})

const csrf = createCsrfMiddleware({ filter: (context) => context.handlerType === 'serverFn', origin: (origin, context) => origin === (process.env.POSTFOLD_ORIGIN ?? new URL(context.request.url).origin) })
export const startInstance = createStart(() => ({ requestMiddleware: [csrf, access] }))
