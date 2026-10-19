import { lookup, type LookupAddress } from 'node:dns'
import https from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

// Remote mail images are fetched server-side (like Gmail's proxy): senders' cross-origin policies no longer block them
// and readers' IP addresses stay private. Only public HTTPS hosts, raster types and bounded sizes are accepted.
const blocked = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) blocked.addSubnet(network, prefix, 'ipv4')
// No ::ffff:0:0/96 rule: BlockList would then match every IPv4 address; IPv4-mapped IPv6 is already checked against the IPv4 rules.
for (const [network, prefix] of [['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(network, prefix, 'ipv6')
const isBlocked = (address: string, family: number) => blocked.check(address, family === 6 ? 'ipv6' : 'ipv4')
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon'])
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

// Checked at connection time, so a DNS answer cannot change between validation and use.
const publicLookup: LookupFunction = (hostname, options, callback) => lookup(hostname, options, (error, address: string | LookupAddress[], family?: number) => {
  const addresses = Array.isArray(address) ? address : [{ address, family: family ?? 4 }]
  const refused = !error && addresses.some((item) => isBlocked(item.address, item.family))
  ;(callback as (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void)(refused ? Object.assign(new Error('Private address refused'), { code: 'EBLOCKED' }) : error, address, family)
})

export function fetchRemoteImage(raw: string, redirects = 3): Promise<{ type: string; body: Buffer }> {
  let url: URL
  try { url = new URL(raw) } catch { return Promise.reject(new Error('Invalid image URL')) }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'https:' || url.port || url.username || url.password || (isIP(host) && isBlocked(host, isIP(host)))) return Promise.reject(new Error('Image URL refused'))
  return new Promise((resolve, reject) => {
    const request = https.get(url, { lookup: publicLookup, timeout: 10_000, headers: { 'User-Agent': 'Postfold image proxy', Accept: 'image/*' } }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
        response.resume()
        fetchRemoteImage(new URL(response.headers.location, url).href, redirects - 1).then(resolve, reject)
        return
      }
      const type = (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (status !== 200 || !rasterTypes.has(type) || Number(response.headers['content-length'] ?? 0) > MAX_IMAGE_BYTES) { response.resume(); reject(new Error('Not a supported image')); return }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_IMAGE_BYTES) request.destroy(new Error('Image too large')); else chunks.push(chunk) })
      response.on('end', () => resolve({ type, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('Image request timed out')))
    request.on('error', reject)
  })
}
