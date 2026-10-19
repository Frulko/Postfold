// Postfold offline shell: the last page loaded online and its static files, so a reload without network still opens.
// The cached page holds mail, so it is served only until the offline deadline written by the app (end of the
// sign-in session, 8 h at most); after that it is deleted and the user must sign in again.
const PAGES = 'postfold-pages', ASSETS = 'postfold-assets', SESSION = 'postfold-session'
const DEADLINE = '/__postfold/offline-deadline'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (![PAGES, ASSETS, SESSION].includes(key)) await caches.delete(key)
  await self.clients.claim()
})()))

async function deadline() {
  const response = await (await caches.open(SESSION)).match(DEADLINE)
  return response ? Number(await response.text()) : 0
}

const expiredPage = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Postfold</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100dvh;font:14px/1.6 ui-sans-serif,-apple-system,"Segoe UI",sans-serif;color:#18181b;background:#fafafa}main{max-width:420px;padding:24px}button{padding:8px 14px;border:1px solid #d4d4d8;border-radius:7px;background:#fff;font:inherit;cursor:pointer}p{color:#52525b}</style></head>
<body><main><h1>Reconnexion nécessaire</h1><p>Postfold est hors ligne et l’accès hors connexion a expiré (fin de session, 8 h au plus). Reconnectez-vous au réseau puis à Postfold. Vos brouillons et modifications en attente restent sur cet appareil.</p>
<p lang="en">Offline access has expired. Reconnect to the network and sign in again; drafts and pending changes stay on this device.</p><button onclick="location.reload()">Réessayer · Retry</button></main></body></html>`

async function page(request) {
  try {
    const response = await fetch(request)
    // Only a signed-in page is kept, never a sign-in redirect or an error.
    if (response.ok && !response.redirected && response.type === 'basic') await (await caches.open(PAGES)).put('/', response.clone())
    return response
  } catch {
    const cached = Date.now() < await deadline() ? await (await caches.open(PAGES)).match('/') : undefined
    if (cached) return cached
    await caches.delete(PAGES)
    return new Response(expiredPage, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
}

// ponytail: hashed build files accumulate across releases; prune by the current page's references if the cache grows large.
async function asset(request) {
  const cache = await caches.open(ASSETS)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone())
  return response
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  if (event.request.mode === 'navigate' && url.pathname === '/') event.respondWith(page(event.request))
  else if (url.pathname.startsWith('/assets/') || /^\/[\w.-]+\.(svg|png|ico|webmanifest)$/.test(url.pathname)) event.respondWith(asset(event.request))
  // Everything else (server functions, sign-in, images) goes to the network as before.
})
