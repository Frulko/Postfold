import { setResponseHeader } from '@tanstack/react-start/server'
import { parseLocale } from '../../shared/i18n'

// The browser speaks to the frontend origin; OIDC and session storage live in NestJS.
export async function keycloakAccess(request: Request, handlerType: string): Promise<Response | undefined> {
  const path = new URL(request.url)
  if (path.pathname === '/auth/logged-out' && request.method === 'GET') return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Postfold — Signed out</title><link rel="icon" href="/icon.svg"><body style="font-family:system-ui;background:#fafafa;color:#18181b;padding:48px"><img src="/icon.svg" width="48" height="48" alt=""><h1>Signed out</h1><p>Your Postfold session has ended.</p><a href="/auth/login">Sign in with Keycloak</a></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
  const headers: Record<string, string> = { Cookie: request.headers.get('cookie') ?? '' }
  const origin = request.headers.get('origin')
  if (origin) headers.Origin = origin
  const api = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000'
  if (['/auth/login', '/auth/callback', '/auth/me', '/auth/logout'].includes(path.pathname)) {
    const method = path.pathname === '/auth/logout' ? 'POST' : 'GET'
    if (request.method !== method) return new Response('Method not allowed', { status: 405, headers: { Allow: method } })
    const response = await fetch(`${api}${path.pathname}${path.search}`, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    const forwarded = new Headers(response.headers)
    forwarded.delete('content-length')
    forwarded.delete('set-cookie')
    for (const cookie of response.headers.getSetCookie()) forwarded.append('set-cookie', cookie)
    return new Response(response.body, { status: response.status, headers: forwarded })
  }
  const me = await fetch(`${api}/auth/me`, { headers, signal: AbortSignal.timeout(15_000) })
  if (me.status === 401) return handlerType === 'serverFn' ? new Response('Sign in with Keycloak.', { status: 401, headers: { 'Cache-Control': 'no-store' } }) : new Response(null, { status: 302, headers: { Location: `/auth/login?lang=${parseLocale(path.searchParams.get('lang'))}`, 'Cache-Control': 'no-store' } })
  if (me.status === 403) return new Response('Your Keycloak account does not have access to this mailbox. Ask your administrator to assign the configured mailbox role.', { status: 403, headers: { 'Cache-Control': 'no-store' } })
  if (!me.ok) return new Response('Keycloak session verification is temporarily unavailable.', { status: 503, headers: { 'Cache-Control': 'no-store' } })
  setResponseHeader('Cache-Control', 'private, no-store')
}
