import { createFileRoute } from '@tanstack/react-router'
import { apiHeaders, apiPath } from '../../server/demo'

// Same-origin relay for the API image proxy; the global access middleware has already authenticated the request.
export const Route = createFileRoute('/api/mail-image')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const target = new URL(request.url).searchParams.get('url') ?? ''
        if (process.env.MAILBOX_MODE !== 'imap' || !target.startsWith('https://')) return new Response(null, { status: 404 })
        const response = await fetch(apiPath(`/image?url=${encodeURIComponent(target)}`), { headers: apiHeaders(), signal: AbortSignal.timeout(15_000) }).catch(() => null)
        if (!response?.ok) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })
        return new Response(response.body, { headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
          'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } })
      },
    },
  },
})
