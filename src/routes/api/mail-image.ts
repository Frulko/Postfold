import { createFileRoute } from '@tanstack/react-router'
import { authMode } from '../../../shared/auth'

// Same-origin relay for the API image proxy; the global access middleware has already authenticated the request.
// Credentials are read from the request itself: route modules must not import the server-only helpers of server functions.
export const Route = createFileRoute('/api/mail-image')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const target = new URL(request.url).searchParams.get('url') ?? ''
        if (process.env.MAILBOX_MODE !== 'imap' || !target.startsWith('https://')) return new Response(null, { status: 404 })
        const headers: Record<string, string> = authMode() === 'keycloak'
          ? { Cookie: request.headers.get('cookie') ?? '', Origin: process.env.POSTFOLD_ORIGIN ?? '' }
          : { Authorization: request.headers.get('authorization') ?? '' }
        const response = await fetch(`${process.env.API_ORIGIN ?? 'http://127.0.0.1:4000'}/mailbox/image?url=${encodeURIComponent(target)}`, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null)
        if (!response?.ok) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })
        return new Response(response.body, { headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
          'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } })
      },
    },
  },
})
